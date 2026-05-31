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
// The WebGPU objects come from dawn.node; we type them loosely (no @webgpu/types
// dependency) — this layer is dynamic by nature, like the native-addon surface.

/* eslint-disable @typescript-eslint/no-explicit-any */

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

import type { CompositorSink } from "../protocols/ctx.js";

// Minimal slice of the native addon this module needs.
export interface CompositorAddon {
  shmView(poolId: number, offset: number, length: number): ArrayBuffer | null;
}

interface Surface {
  texture: any;       // GPUTexture (bgra8unorm, sampled)
  view: any;          // GPUTextureView
  placementBuf: any;  // uniform buffer (vec4)
  bindGroup: any;
  width: number;
  height: number;
  x: number;
  y: number;
  layoutW: number;
  layoutH: number;
  present: boolean;
}

const FORMAT = "bgra8unorm";

export class JsCompositor implements CompositorSink {
  private device: any;
  private g: any; // dawn.node globals (GPUTextureUsage, GPUBufferUsage, ...)
  private addon: CompositorAddon;
  private width: number;
  private height: number;
  // Surfaces that gained presentable content since the last takeImportedSurfaces.
  private imported: Array<{ id: number; width: number; height: number }> = [];
  private warnedDmabuf = false;

  private sampler: any;
  private pipeline: any;
  private layout: any; // bind group layout
  private target: any; // offscreen render target (headless)
  private targetView: any;

  private surfaces = new Map<number, Surface>();
  private stack: number[] = [];

  constructor(device: any, globals: any, addon: CompositorAddon,
              output: { width: number; height: number }) {
    this.device = device;
    this.g = globals;
    this.addon = addon;
    this.width = output.width;
    this.height = output.height;

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
          format: FORMAT,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
    });
    this.layout = this.pipeline.getBindGroupLayout(0);

    this.target = device.createTexture({
      size: { width: this.width, height: this.height },
      format: FORMAT,
      usage: this.g.GPUTextureUsage.RENDER_ATTACHMENT | this.g.GPUTextureUsage.COPY_SRC,
    });
    this.targetView = this.target.createView();
  }

  // --- CompositorSink ---

  setStack(ids: number[]): void { this.stack = ids.slice(); }

  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void {
    const s = this.surfaces.get(id);
    if (s) { s.x = x; s.y = y; s.layoutW = w; s.layoutH = h; }
    else this.surfaces.set(id, blankSurface(x, y, w, h));
  }

  removeSurface(id: number): void { this.surfaces.delete(id); }

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

  // dmabuf in the JS compositor is slice 2 (createTextureFromDmabuf + wrapTexture
  // + the buffer-release lifecycle). Until then, report unhandled.
  commitSurfaceDmabuf(): boolean {
    if (!this.warnedDmabuf) {
      console.warn("[js-compositor] commitSurfaceDmabuf not yet implemented (slice 2)");
      this.warnedDmabuf = true;
    }
    return false;
  }

  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }> {
    const out = this.imported;
    this.imported = [];
    return out;
  }

  // shm has no zero-copy buffer-release lifecycle (pixels are copied at upload),
  // so nothing to release. dmabuf release lands in slice 2.
  takeFreedBuffers(): number[] { return []; }

  // Upload raw BGRA8 pixels (tightly `stride`-rowed) into the surface's sampled
  // texture, creating/recreating it on size change. Used by uploadShm and by
  // tests / future producers that supply pixels directly.
  uploadPixels(id: number, c: { width: number; height: number; stride: number },
               data: ArrayBuffer | ArrayBufferView): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }

    if (!s.texture || s.width !== c.width || s.height !== c.height) {
      if (s.texture) s.texture.destroy?.();
      s.texture = this.device.createTexture({
        size: { width: c.width, height: c.height },
        format: FORMAT,
        usage: this.g.GPUTextureUsage.TEXTURE_BINDING | this.g.GPUTextureUsage.COPY_DST,
      });
      s.view = s.texture.createView();
      s.width = c.width;
      s.height = c.height;
      if (!s.placementBuf) {
        s.placementBuf = this.device.createBuffer({
          size: 16, usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
        });
      }
      s.bindGroup = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: s.view },
          { binding: 2, resource: { buffer: s.placementBuf } },
        ],
      });
    }

    // `data` begins at the buffer's first pixel row, so dataLayout offset is 0.
    this.device.queue.writeTexture(
      { texture: s.texture },
      data,
      { offset: 0, bytesPerRow: c.stride, rowsPerImage: c.height },
      { width: c.width, height: c.height },
    );
    s.present = true;
  }

  private updatePlacement(s: Surface): void {
    const w = s.layoutW || s.width;
    const h = s.layoutH || s.height;
    const rect = new Float32Array([
      s.x / this.width, s.y / this.height, w / this.width, h / this.height,
    ]);
    this.device.queue.writeBuffer(s.placementBuf, 0, rect);
  }

  // Composite one frame into the offscreen target (clear black, draw stack
  // back-to-front, premultiplied-alpha blend). Returns nothing; read with
  // readback().
  renderFrame(): void {
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.targetView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(this.pipeline);
    for (const id of this.stack) {
      const s = this.surfaces.get(id);
      if (s && s.present && s.bindGroup) {
        this.updatePlacement(s);
        pass.setBindGroup(0, s.bindGroup);
        pass.draw(4);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  // Async readback of the composited target. Returns tightly-packed BGRA bytes
  // (width*height*4). copyTextureToBuffer requires 256-aligned bytesPerRow, so
  // we pad on the GPU side and unpad here.
  async readback(): Promise<{ width: number; height: number; data: Uint8Array }> {
    const unpadded = this.width * 4;
    const padded = Math.ceil(unpadded / 256) * 256;
    const buf = this.device.createBuffer({
      size: padded * this.height,
      usage: this.g.GPUBufferUsage.COPY_DST | this.g.GPUBufferUsage.MAP_READ,
    });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer(
      { texture: this.target },
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
    buf.destroy?.();
    return { width: this.width, height: this.height, data: out };
  }
}

function blankSurface(x: number, y: number, w: number, h: number): Surface {
  return {
    texture: null, view: null, placementBuf: null, bindGroup: null,
    width: 0, height: 0, x, y, layoutW: w, layoutH: h, present: false,
  };
}
