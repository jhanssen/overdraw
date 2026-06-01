// JS compositor: the per-output compositing pass, in core main-thread JS, over
// the Dawn wire (via a wire-retargeted dawn.node GPUDevice). This is the
// architecture's intended home for the renderer (architecture.md: "the core's
// per-output frame loop / compositing renderer" runs on the Node main thread);
// it replaces the equivalent C++ Compositor render path.
//
// Slice 1: headless (offscreen target) + shm surfaces. Each surface's pixels are
// uploaded with queue.writeTexture from a zero-copy ArrayBuffer over the client
// shm mapping (addon.shmView). dmabuf surfaces + nested swapchain present are
// later slices.
//
// The WebGPU objects come from dawn.node and conform to the standard WebGPU JS
// API, so they are typed with @webgpu/types (GPUDevice/GPUTexture/...).

// The same compositing shader the C++ path used: a unit quad placed into a
// per-surface normalized output rect, sampling the surface texture.
const WGSL = `
struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
};
struct Rect { r : vec4f, };
@group(0) @binding(2) var<uniform> placement : Rect;
@vertex fn vs(@builtin(vertex_index) i : u32) -> VsOut {
  var q = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  var uv = array<vec2f, 4>(
    vec2f(0.0, 1.0), vec2f(1.0, 1.0),
    vec2f(0.0, 0.0), vec2f(1.0, 0.0));
  let placed = placement.r.xy + q[i] * placement.r.zw;
  let ndc = vec2f(placed.x * 2.0 - 1.0, 1.0 - placed.y * 2.0);
  var o : VsOut;
  o.pos = vec4f(ndc, 0.0, 1.0);
  o.uv = uv[i];
  return o;
}
@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;
@fragment fn fs(in : VsOut) -> @location(0) vec4f {
  return textureSample(tex, samp, in.uv);
}
`;

import type { CompositorSink, Layer } from "../protocols/ctx.js";
import { LAYER_ORDER } from "../protocols/ctx.js";
import type { WaylandFd } from "../types.js";

// Minimal slice of the native addon this module needs.
export interface CompositorAddon {
  shmView(poolId: number, offset: number, length: number): ArrayBuffer | null;
  // Async dmabuf import (server-side reserve/inject). Returns a monotonic
  // importId (0 = could not start); cb(handle|null) fires on completion. `fd` is
  // a WaylandFd (the native side peeks it without consuming).
  createTextureFromDmabuf(
    fd: WaylandFd, w: number, h: number, fourcc: number, modHi: number, modLo: number,
    offset: number, stride: number, cb: (handle: bigint | null) => void): number;
  // Release a dmabuf import (drops the server STM + fd). Called once the buffer
  // is freed (GPU-completion-gated) or the surface is removed.
  releaseDmabufImport(importId: number): void;
  // Nested present (slice 3): acquire the host swapchain's current texture handle
  // (null if none this frame) and present it after rendering.
  acquireOutputTexture(): bigint | null;
  presentOutput(): void;
}

// The dawn.node wire binding bits the compositor needs for dmabuf surfaces.
export interface DawnWire {
  wrapTexture(deviceHandle: bigint, textureHandle: bigint): GPUTexture;
}

// The bitflag constant objects dawn.node exposes (dawn.globals); shaped like the
// ambient WebGPU globals.
export interface DawnGlobals {
  GPUTextureUsage: typeof GPUTextureUsage;
  GPUBufferUsage: typeof GPUBufferUsage;
  GPUMapMode: typeof GPUMapMode;
}

interface Surface {
  texture: GPUTexture | null;       // bgra8unorm, sampled
  view: GPUTextureView | null;
  placementBuf: GPUBuffer | null;   // uniform buffer (vec4)
  bindGroup: GPUBindGroup | null;
  width: number;
  height: number;
  x: number;
  y: number;
  layoutW: number;
  layoutH: number;
  present: boolean;
  // dmabuf: the wl_buffer id currently backing this surface (0 = shm/none), for
  // the zero-copy buffer-release lifecycle, and the native importId for releasing
  // the server-side STM/fd (0 = shm/none).
  currentBufferId: number;
  currentImportId: number;
}

// A dmabuf buffer awaiting GPU-completion of the last frame that sampled it,
// after which the client may reuse it (wl_buffer.release) and the server-side
// import may be released (importId).
interface RetiringBuffer { bufferId: number; importId: number; retireSerial: number; tex: GPUTexture; }

const DEFAULT_FORMAT = "bgra8unorm";

export interface JsCompositorOpts {
  // Present to the host swapchain (slice 3) instead of an offscreen target.
  // Requires dawn + deviceHandle (for wrapTexture) and the addon acquire/present.
  nested?: boolean;
  // The render-target color format (must match the swapchain when nested).
  format?: GPUTextureFormat;
}

export class JsCompositor implements CompositorSink {
  private device: GPUDevice;
  private g: DawnGlobals;
  private addon: CompositorAddon;
  private width: number;
  private height: number;
  // Surfaces that gained presentable content since the last takeImportedSurfaces.
  private imported: Array<{ id: number; width: number; height: number }> = [];
  private warnedDmabuf = false;

  private sampler: GPUSampler;
  private pipeline: GPURenderPipeline;
  private layout: GPUBindGroupLayout;
  private target?: GPUTexture;          // offscreen render target (headless)
  private targetView?: GPUTextureView;

  private surfaces = new Map<number, Surface>();
  // The content layer's ordered draw list (windows+subsurfaces+popups).
  private stack: number[] = [];
  // Non-content layers (background/below/above/overlay). Composited around the
  // content stack per LAYER_ORDER. Plugin overlays/decorations populate these.
  private layers = new Map<Layer, number[]>();

  // dmabuf buffer-release lifecycle (mirrors the C++ retiring/freed logic): each
  // composite submit gets a serial; a superseded buffer retires tagged with the
  // latest submit serial and is freed once that serial completes on the GPU.
  private submitSerial = 0;
  private completedSerial = 0;
  private retiring: RetiringBuffer[] = [];
  private freed: number[] = [];
  // Callbacks deferred until the compositing submit in flight at registration time
  // completes on the GPU. Used to recycle a plugin/overlay consumer slot only after
  // the frame that last sampled it is done (else EndAccess races the GPU read).
  private afterFrame: Array<{ serial: number; cb: () => void }> = [];

  // dmabuf support (optional; only needed when dmabuf clients run under the JS
  // compositor). `dawn` provides wrapTexture; `deviceHandle` is the wire device.
  private dawn: DawnWire | null;
  private deviceHandle: bigint;

  // Nested present (slice 3): render into the host swapchain + present, instead
  // of an offscreen target.
  private nested: boolean;
  private format: GPUTextureFormat;
  private outputTex: GPUTexture | null = null;  // wrapped swapchain texture, held during a frame

  constructor(device: GPUDevice, globals: DawnGlobals, addon: CompositorAddon,
              output: { width: number; height: number },
              dawn: DawnWire | null = null, deviceHandle: bigint = 0n,
              opts: JsCompositorOpts = {}) {
    this.device = device;
    this.g = globals;
    this.addon = addon;
    this.width = output.width;
    this.height = output.height;
    this.dawn = dawn;
    this.deviceHandle = deviceHandle;
    this.nested = opts.nested ?? false;
    this.format = opts.format ?? DEFAULT_FORMAT;

    this.sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      primitive: { topology: "triangle-strip" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
    });
    this.layout = this.pipeline.getBindGroupLayout(0);

    // Headless: an owned offscreen target (read back via readback()). Nested: the
    // target is the swapchain's current texture, acquired per frame.
    if (!this.nested) {
      this.target = device.createTexture({
        size: { width: this.width, height: this.height },
        format: this.format,
        usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT | this.g.GPUTextureUsage.COPY_SRC,
      });
      this.targetView = this.target.createView();
    }
  }

  // --- CompositorSink ---

  setStack(ids: number[]): void { this.stack = ids.slice(); }

  setLayerSurfaces(layer: Layer, ids: number[]): void {
    if (layer === "content") { this.stack = ids.slice(); return; }
    this.layers.set(layer, ids.slice());
  }

  // The full back-to-front draw order: each layer in LAYER_ORDER, with `content`
  // taken from the window/subsurface/popup stack.
  private drawOrder(): number[] {
    const out: number[] = [];
    for (const layer of LAYER_ORDER) {
      if (layer === "content") out.push(...this.stack);
      else { const ids = this.layers.get(layer); if (ids) out.push(...ids); }
    }
    return out;
  }

  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void {
    const s = this.surfaces.get(id);
    if (s) { s.x = x; s.y = y; s.layoutW = w; s.layoutH = h; }
    else this.surfaces.set(id, blankSurface(x, y, w, h));
  }

  removeSurface(id: number): void {
    const s = this.surfaces.get(id);
    if (s) {
      // Release the surface's live dmabuf import (client surfaces; retiring buffers
      // free on their own completion in reapRetiring).
      if (s.currentImportId !== 0) this.addon.releaseDmabufImport(s.currentImportId);
      // Destroy the per-surface placement uniform buffer (a wire GPUBuffer). The
      // sampled texture is dropped with the map entry; explicitly .destroy()-ing the
      // wrapped consumer/client texture here caused intermittent fatal dawn.node
      // throws during teardown (it is owned by the ring/client side), so it is left
      // to be released via its owner + the GPU-process ReleaseSurfaceBuf path. The
      // sync_file fence-fd reclaim is tracked separately.
      s.placementBuf?.destroy();
    }
    this.surfaces.delete(id);
  }

  // Upload a committed shm buffer into the surface's sampled texture (zero-copy
  // from the client mapping via addon.shmView), and report it as presentable.
  commitSurfaceBuffer(id: number, poolId: number, offset: number,
                      width: number, height: number, stride: number): boolean {
    const ab = this.addon.shmView(poolId, offset, stride * height);
    if (!ab) return false;
    this.uploadPixels(id, { width, height, stride }, ab);
    this.imported.push({ id, width, height });
    return true;
  }

  // Import a client dmabuf (zero-copy) as a sampled texture and install it on the
  // surface. The import is async (server-side reserve/inject); on completion we
  // wrap the wire texture (dawn.node wrapTexture) and build the bind group.
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number, fourcc: number,
                      modHi: number, modLo: number, offset: number, stride: number,
                      bufferId: number): boolean {
    const dawn = this.dawn;
    if (!dawn || this.deviceHandle === 0n) {
      if (!this.warnedDmabuf) {
        console.warn("[js-compositor] dmabuf needs dawn.wrapTexture + deviceHandle");
        this.warnedDmabuf = true;
      }
      return false;
    }
    const importId = this.addon.createTextureFromDmabuf(
      fd, w, h, fourcc, modHi, modLo, offset, stride,
      (handle) => {
        if (handle === null) { if (importId) this.addon.releaseDmabufImport(importId); return; }
        const tex = dawn.wrapTexture(this.deviceHandle, handle);
        this.installDmabuf(id, tex, w, h, bufferId, importId);
      });
    return importId !== 0;
  }

  // Install a freshly-imported dmabuf texture on the surface, retiring the buffer
  // it supersedes (freed once the last frame that sampled it completes).
  private installDmabuf(id: number, tex: GPUTexture, w: number, h: number,
                        bufferId: number, importId: number): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }

    if (s.currentBufferId !== 0 && s.currentBufferId !== bufferId && s.texture) {
      // The old buffer was sampled by every frame up to the latest submit; it is
      // free once that submit completes. Keep its texture alive until then.
      this.retiring.push({ bufferId: s.currentBufferId, importId: s.currentImportId,
                           retireSerial: this.submitSerial, tex: s.texture });
    }
    s.currentBufferId = bufferId;
    s.currentImportId = importId;
    s.texture = tex;
    const view = tex.createView();
    s.view = view;
    s.width = w;
    s.height = h;
    const placementBuf = s.placementBuf ?? this.device.createBuffer({
      size: 16, usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
    });
    s.placementBuf = placementBuf;
    s.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: view },
        { binding: 2, resource: { buffer: placementBuf } },
      ],
    });
    s.present = true;
    this.imported.push({ id, width: w, height: h });
  }

  // Install a pre-wrapped wire texture (e.g. a plugin overlay's consumer texture,
  // dual-imported dmabuf on the core device) as surface `id`'s sampled texture.
  // Unlike commitSurfaceDmabuf this does no import (the GPU process already did
  // it + the core wrapped the injected handle); it just (re)builds the bind group.
  // The plugin/overlay layer placement is set separately (setSurfaceLayout +
  // setLayerSurfaces). Idempotent per frame (same texture handle reused).
  setSurfaceTexture(id: number, tex: GPUTexture, w: number, h: number): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }
    if (s.texture === tex && s.bindGroup) { s.present = true; return; }
    s.texture = tex;
    s.width = w; s.height = h;
    const view = tex.createView();
    s.view = view;
    const placementBuf = s.placementBuf ?? this.device.createBuffer({
      size: 16, usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
    });
    s.placementBuf = placementBuf;
    s.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: view },
        { binding: 2, resource: { buffer: placementBuf } },
      ],
    });
    s.present = true;
  }

  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }> {
    const out = this.imported;
    this.imported = [];
    return out;
  }

  // dmabuf buffers freed since the last call (their last sampling frame completed
  // on the GPU). shm buffers are copied at upload, so they never appear here.
  takeFreedBuffers(): number[] {
    const out = this.freed;
    this.freed = [];
    return out;
  }

  // Run `cb` once the compositing submit currently in flight (the latest issued)
  // has completed on the GPU -- i.e. after any frame that may have sampled a
  // surface's now-superseded consumer slot is done reading it. If no submit is
  // outstanding, runs on the next completion (a frame is always coming). Used by
  // the plugin/overlay ring to recycle a consumer slot without racing the GPU read.
  afterCurrentFrame(cb: () => void): void {
    this.afterFrame.push({ serial: this.submitSerial, cb });
  }

  private runAfterFrame(): void {
    if (this.afterFrame.length === 0) return;
    const keep: Array<{ serial: number; cb: () => void }> = [];
    for (const e of this.afterFrame) {
      if (e.serial <= this.completedSerial) {
        try { e.cb(); } catch (err) { console.warn("[js-compositor] afterCurrentFrame cb threw", err); }
      } else {
        keep.push(e);
      }
    }
    this.afterFrame = keep;
  }

  private reapRetiring(): void {
    if (this.retiring.length === 0) return;
    const keep: RetiringBuffer[] = [];
    for (const r of this.retiring) {
      if (r.retireSerial <= this.completedSerial) {
        this.freed.push(r.bufferId);                       // -> wl_buffer.release
        if (r.importId !== 0) this.addon.releaseDmabufImport(r.importId); // drop server STM/fd
        // r.tex reference is dropped here (entry not kept).
      } else {
        keep.push(r);
      }
    }
    this.retiring = keep;
  }

  // Upload raw BGRA8 pixels (tightly `stride`-rowed) into the surface's sampled
  // texture, creating/recreating it on size change. Used by uploadShm and by
  // tests / future producers that supply pixels directly.
  uploadPixels(id: number, c: { width: number; height: number; stride: number },
               data: ArrayBuffer | ArrayBufferView): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }

    let tex = s.texture;
    if (!tex || s.width !== c.width || s.height !== c.height) {
      if (tex) tex.destroy();
      // Sampled client textures are always BGRA8 (shm ARGB8888 byte-for-byte;
      // dmabuf imported as BGRA8Unorm), independent of the output format.
      tex = this.device.createTexture({
        size: { width: c.width, height: c.height },
        format: "bgra8unorm",
        usage: this.g.GPUTextureUsage.TEXTURE_BINDING | this.g.GPUTextureUsage.COPY_DST,
      });
      s.texture = tex;
      const view = tex.createView();
      s.view = view;
      s.width = c.width;
      s.height = c.height;
      const placementBuf = s.placementBuf ?? this.device.createBuffer({
        size: 16, usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
      });
      s.placementBuf = placementBuf;
      s.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: view },
          { binding: 2, resource: { buffer: placementBuf } },
        ],
      });
    }

    // `data` begins at the buffer's first pixel row, so dataLayout offset is 0.
    this.device.queue.writeTexture(
      { texture: tex },
      data,
      { offset: 0, bytesPerRow: c.stride, rowsPerImage: c.height },
      { width: c.width, height: c.height },
    );
    s.present = true;
  }

  private updatePlacement(s: Surface): void {
    if (!s.placementBuf) return;
    const w = s.layoutW || s.width;
    const h = s.layoutH || s.height;
    const rect = new Float32Array([
      s.x / this.width, s.y / this.height, w / this.width, h / this.height,
    ]);
    this.device.queue.writeBuffer(s.placementBuf, 0, rect);
  }

  // Composite one frame: clear black, draw stack back-to-front, premultiplied
  // blend. Nested (slice 3) renders into the host swapchain's current texture and
  // presents; headless renders into the offscreen target (read via readback()).
  renderFrame(): void {
    let targetView = this.targetView;
    let presenting = false;
    if (this.nested) {
      const handle = this.addon.acquireOutputTexture();
      if (handle === null) return;  // no swapchain texture this frame
      if (!this.dawn) return;
      this.outputTex = this.dawn.wrapTexture(this.deviceHandle, handle);
      targetView = this.outputTex.createView();
      presenting = true;
    }
    if (!targetView) return;  // headless before the target exists (shouldn't happen)
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    for (const id of this.drawOrder()) {
      const s = this.surfaces.get(id);
      if (s && s.present && s.bindGroup) {
        this.updatePlacement(s);
        pass.setBindGroup(0, s.bindGroup);
        pass.draw(4);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);

    // This submit sampled every present surface's current buffer. Tag it; when it
    // completes on the GPU, advance completedSerial and free retiring dmabuf
    // buffers whose retireSerial has completed (-> wl_buffer.release). The promise
    // resolves on the Node thread via the wire pump.
    const serial = ++this.submitSerial;
    this.device.queue.onSubmittedWorkDone().then(() => {
      if (serial > this.completedSerial) this.completedSerial = serial;
      this.reapRetiring();
      this.runAfterFrame();
    });

    if (presenting) {
      this.addon.presentOutput();
      this.outputTex = null;  // drop our borrowed wrap (native held its own ref)
    }
  }

  // Async readback of the composited target. Returns tightly-packed BGRA bytes
  // (width*height*4). copyTextureToBuffer requires 256-aligned bytesPerRow, so
  // we pad on the GPU side and unpad here.
  async readback(): Promise<{ width: number; height: number; data: Uint8Array }> {
    if (this.nested || !this.target) {
      throw new Error("readback() is headless-only (nested presents to the swapchain)");
    }
    const target = this.target;
    const unpadded = this.width * 4;
    const padded = Math.ceil(unpadded / 256) * 256;
    const buf = this.device.createBuffer({
      size: padded * this.height,
      usage: this.g.GPUBufferUsage.COPY_DST | this.g.GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: target },
      { buffer: buf, bytesPerRow: padded, rowsPerImage: this.height },
      { width: this.width, height: this.height },
    );
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(this.g.GPUMapMode.READ);
    const mapped = new Uint8Array(buf.getMappedRange());
    const out = new Uint8Array(unpadded * this.height);
    for (let y = 0; y < this.height; y++) {
      out.set(mapped.subarray(y * padded, y * padded + unpadded), y * unpadded);
    }
    buf.unmap();
    buf.destroy();
    return { width: this.width, height: this.height, data: out };
  }
}

function blankSurface(x: number, y: number, w: number, h: number): Surface {
  return {
    texture: null, view: null, placementBuf: null, bindGroup: null,
    width: 0, height: 0, x, y, layoutW: w, layoutH: h, present: false,
    currentBufferId: 0, currentImportId: 0,
  };
}
