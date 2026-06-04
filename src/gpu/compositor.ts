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
import {
  ClientBufferLifecycle,
  type LifecycleIntent,
} from "./client-buffer-lifecycle.js";

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
  // In-band per-frame BeginAccess/EndAccess on a cached client dmabuf import
  // (Layer C of docs/client-buffer-lifecycle.md): write a kind=1/kind=2 control
  // frame on the core WIRE socket (not ctrl). The frame is FIFO-ordered against
  // the Dawn sample commands around it -- a Begin written before the sample's
  // wire batch is processed first (bracket open before HandleCommands reaches
  // the sample); an End written after the submit's wire batch is processed
  // after it. No ctrl round-trip (Node thread does not block), no wireSerial,
  // no WireBarrier. The addon flushes staged Dawn bytes before each frame, so
  // JS does NOT flush explicitly. writeBeginAccess returns false iff the import
  // is unknown (JS-gate bug; the GPU process hard-fails on its side too).
  writeBeginAccess(importId: number): boolean;
  writeEndAccess(importId: number): void;
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
  // For dmabuf surfaces, the buffer the lifecycle machine has assigned as
  // current (0 = shm/none/not-yet-imported). Used to pair frameSampled events
  // with the right buffer id, and to know what to (re)bind into the bind group
  // when an import completes.
  currentBufferId: number;
}

// The executor's per-bufferId record. Holds the GPU side of a cached client
// dmabuf import (wrapped texture + view + the native importId for release).
// Created lazily when the lifecycle's importBuffer intent completes (async via
// the addon callback); torn down by the releaseImport intent.
interface DmabufImport {
  tex: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
  importId: number;
}

// Pending importBuffer intent: the descriptor we need to call the addon. Kept
// here (not in the state machine) so the lifecycle stays Dawn-free.
interface DmabufDescriptor {
  fd: WaylandFd;
  width: number;
  height: number;
  fourcc: number;
  modHi: number;
  modLo: number;
  offset: number;
  stride: number;
  // Surfaces waiting on this import to complete (so we can install the texture
  // on each once the wrap arrives). One bufferId can be the current of many
  // surfaces over its lifetime, but per per-surface invariant 4 only one at a
  // time, so this is normally singleton; defensive list.
  pendingInstalls: number[];
}

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

  // dmabuf buffer-release lifecycle. The pure state machine (no GPU, no Dawn)
  // is the source of truth; the executor here translates events <-> intents.
  // See src/gpu/client-buffer-lifecycle.ts for the rules; the design is in
  // docs/client-buffer-lifecycle.md.
  private lifecycle = new ClientBufferLifecycle();
  // Per-bufferId cached GPU import. Populated when an importBuffer intent's
  // async addon callback resolves; cleared by releaseImport. Cache lifetime is
  // the wl_buffer lifetime (rule A): cycling clients hit cache on re-attach.
  private dmabufImports = new Map<number, DmabufImport>();
  // bufferId -> descriptor for importBuffer intents whose async callback has
  // not yet fired. Also lists surfaces waiting to bind once the wrap arrives.
  private dmabufPending = new Map<number, DmabufDescriptor>();
  // Buffers freed by the lifecycle (sendWlRelease intents). Drained per-frame
  // by src/protocols/index.ts via takeFreedBuffers() (the wire layer).
  private freed: number[] = [];

  // Submit-serial bookkeeping. completedSerial is what onSubmittedWorkDone
  // turns into gpuCompleted(serial) events; both also drive afterCurrentFrame.
  private submitSerial = 0;
  private completedSerial = 0;
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
    // Feed surfaceRemoved to the lifecycle BEFORE dropping the Surface record.
    // The state machine emits the (gated-on-completion) sendWlRelease +
    // releaseImport for the surface's then-current buffer; the executor
    // handles them in dispatch(). Other (previously-superseded but still
    // cached) buffers stay cached until bufferDestroyed fires for them per
    // rule A; the disconnect sweep in src/protocols/index.ts is what
    // guarantees no client-disconnect leak.
    this.dispatch(this.lifecycle.step({ kind: "surfaceRemoved", surfaceId: id }));

    const s = this.surfaces.get(id);
    if (s) {
      // The per-surface placement uniform buffer is a wire GPUBuffer the
      // executor owns; destroy it now. The sampled texture is the dmabuf
      // import owned by dmabufImports/lifecycle; the lifecycle path released
      // it via the surfaceRemoved drain (or deferred until inflight frames
      // complete). Explicitly .destroy()-ing the wrapped client texture here
      // caused intermittent fatal dawn.node throws during teardown.
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

  // Commit a client dmabuf wl_buffer to a surface. Feeds the lifecycle machine
  // a `commit` event; the resulting intents drive the import (if first-sight
  // of this bufferId) or simply re-bind the existing cached import to the
  // surface.
  //
  // Returns false only when this compositor was constructed without a Dawn
  // wire (the headless protocol-only mode used by some tests); true otherwise.
  // (It used to return the addon's importId-truthy value, but the
  // intent-driven path makes the import strictly async, so we return true and
  // let the lifecycle drive the rest.)
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number, fourcc: number,
                      modHi: number, modLo: number, offset: number, stride: number,
                      bufferId: number): boolean {
    if (!this.dawn || this.deviceHandle === 0n) {
      if (!this.warnedDmabuf) {
        console.warn("[js-compositor] dmabuf needs dawn.wrapTexture + deviceHandle");
        this.warnedDmabuf = true;
      }
      return false;
    }

    // Ensure the surface exists (the layout sweep may not have created it).
    if (!this.surfaces.has(id)) this.surfaces.set(id, blankSurface(0, 0, 0, 0));

    // Stash the descriptor BEFORE the commit event: if the lifecycle emits an
    // importBuffer intent, the intent handler reads dmabufPending to find the
    // descriptor. (The lifecycle keeps the rules; the executor keeps the GPU
    // concerns. Crossing the boundary with raw fds would defeat that.)
    if (!this.dmabufPending.has(bufferId) && !this.dmabufImports.has(bufferId)) {
      this.dmabufPending.set(bufferId, {
        fd, width: w, height: h, fourcc, modHi, modLo, offset, stride,
        pendingInstalls: [],
      });
    }
    // Track that this surface wants the texture installed when the import
    // completes (cache miss path) -- or immediately (cache hit path, handled
    // below after stepping the lifecycle).
    const pending = this.dmabufPending.get(bufferId);
    if (pending && !pending.pendingInstalls.includes(id)) {
      pending.pendingInstalls.push(id);
    }

    // Feed the lifecycle. It emits importBuffer (cache miss) or nothing (cache
    // hit / same-buffer re-commit). The acquireFenceAvailable event is a stub
    // in Layer B: `kind: "none"` until Layer C re-exports the dmabuf sync_file
    // per commit. (Today the GPU process exports the sync_file at import time
    // and feeds it into the single BeginAccess at import, which is the bug
    // Layer C fixes; Layer B leaves the existing behavior untouched.)
    this.dispatch(this.lifecycle.step({
      kind: "commit", surfaceId: id, bufferId, dims: { w, h },
    }));
    this.dispatch(this.lifecycle.step({
      kind: "acquireFenceAvailable", bufferId, fence: { kind: "none" },
    }));

    // Cache hit: the lifecycle did NOT emit importBuffer, and we already have
    // a cached GPUTexture for this bufferId. Bind it on the surface now.
    const cached = this.dmabufImports.get(bufferId);
    if (cached) {
      this.bindImportToSurface(id, bufferId, cached);
      // No longer pending an install.
      this.dmabufPending.delete(bufferId);
    }

    return true;
  }

  // Wire a (possibly-just-imported) cached GPU import into the given surface:
  // (re)build the view + bind group, mark present, and announce the surface as
  // having new content this frame.
  private bindImportToSurface(id: number, bufferId: number, imp: DmabufImport): void {
    let s = this.surfaces.get(id);
    if (!s) { s = blankSurface(0, 0, 0, 0); this.surfaces.set(id, s); }
    s.currentBufferId = bufferId;
    s.texture = imp.tex;
    s.view = imp.view;
    s.width = imp.width;
    s.height = imp.height;
    const placementBuf = s.placementBuf ?? this.device.createBuffer({
      size: 16, usage: this.g.GPUBufferUsage.UNIFORM | this.g.GPUBufferUsage.COPY_DST,
    });
    s.placementBuf = placementBuf;
    s.bindGroup = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: imp.view },
        { binding: 2, resource: { buffer: placementBuf } },
      ],
    });
    s.present = true;
    this.imported.push({ id, width: imp.width, height: imp.height });
  }

  // Run the intents the lifecycle just emitted. The executor is intentionally
  // dumb: it has no policy of its own. Layer B implements importBuffer +
  // releaseImport + sendWlRelease; beginAccess + endAccess are stubs filled in
  // by Layer C (the cross-process per-frame Begin/End bracket).
  private dispatch(intents: LifecycleIntent[]): void {
    for (const i of intents) this.runIntent(i);
  }

  private runIntent(intent: LifecycleIntent): void {
    switch (intent.kind) {
      case "importBuffer": this.runImportBuffer(intent.bufferId); break;
      case "releaseImport": this.runReleaseImport(intent.bufferId); break;
      case "sendWlRelease": this.freed.push(intent.bufferId); break;
      case "beginAccess":
      case "endAccess":
        // The actual GPU-process BeginAccess/EndAccess are written in-band in
        // renderFrame() (writeBeginAccess before the sample, writeEndAccess
        // after the submit). They are not driven from here: renderFrame writes
        // the Begin frame and only THEN feeds frameSampled, so the lifecycle
        // intents are informational. They record the LOGICAL contract the unit
        // tests verify (alternation, chain-fence threading), while the wire
        // frames enforce the actual GPU-side bracket ordering.
        break;
    }
  }

  // Async addon call to import the client dmabuf. On completion the wrapped
  // wire texture is cached and any pending surface installs are bound.
  private runImportBuffer(bufferId: number): void {
    if (this.dmabufImports.has(bufferId)) return;  // defensive: never re-import
    const pending = this.dmabufPending.get(bufferId);
    if (!pending) {
      console.warn(`[js-compositor] importBuffer(${bufferId}) without pending descriptor (executor/state-machine drift)`);
      return;
    }
    const dawn = this.dawn;
    if (!dawn || this.deviceHandle === 0n) {
      this.dispatch(this.lifecycle.step({
        kind: "accessFailed", bufferId, reason: "no dawn wire / deviceHandle",
      }));
      return;
    }
    const importId = this.addon.createTextureFromDmabuf(
      pending.fd, pending.width, pending.height, pending.fourcc,
      pending.modHi, pending.modLo, pending.offset, pending.stride,
      (handle) => {
        const p = this.dmabufPending.get(bufferId);
        if (handle === null) {
          // The native import failed (modifier mismatch, bad dmabuf, etc).
          // Release the importId reservation; poison the buffer in the
          // state machine; subsequent samples are skipped (surface stays
          // last-good).
          if (importId) this.addon.releaseDmabufImport(importId);
          if (p) this.dmabufPending.delete(bufferId);
          this.dispatch(this.lifecycle.step({
            kind: "accessFailed", bufferId, reason: "createTextureFromDmabuf returned null",
          }));
          return;
        }
        const tex = dawn.wrapTexture(this.deviceHandle, handle);
        const view = tex.createView();
        const imp: DmabufImport = {
          tex, view, width: pending.width, height: pending.height, importId,
        };
        this.dmabufImports.set(bufferId, imp);
        // Bind to every surface that was waiting for this import.
        if (p) {
          for (const sid of p.pendingInstalls) this.bindImportToSurface(sid, bufferId, imp);
          this.dmabufPending.delete(bufferId);
        }
      });
    if (importId === 0) {
      // Synchronous failure to start the import (addon refused). Treat the
      // same as the async-null callback.
      this.dmabufPending.delete(bufferId);
      this.dispatch(this.lifecycle.step({
        kind: "accessFailed", bufferId, reason: "createTextureFromDmabuf returned 0",
      }));
    }
  }

  private runReleaseImport(bufferId: number): void {
    const imp = this.dmabufImports.get(bufferId);
    if (!imp) {
      // releaseImport fired for a buffer whose async import never resolved
      // (accessFailed path also clears dmabufPending; nothing to do).
      this.dmabufPending.delete(bufferId);
      return;
    }
    this.dmabufImports.delete(bufferId);
    // Detach from any surfaces still pointing at this import. Without this, a
    // surface whose bufferDestroyed fired (or whose buffer was the destroyed
    // wl_buffer at the moment its own surfaceRemoved drained) keeps a stale
    // GPUTexture reference; the next frame would try to sample a freed import.
    for (const s of this.surfaces.values()) {
      if (s.currentBufferId === bufferId) {
        s.currentBufferId = 0;
        s.texture = null;
        s.view = null;
        s.bindGroup = null;
        s.present = false;
      }
    }
    // Native release: drops the server-side STM + texture + dmabuf fd.
    if (imp.importId !== 0) this.addon.releaseDmabufImport(imp.importId);
  }

  // The wire layer (src/protocols/wl_buffer.ts) calls this from the wl_buffer
  // destroy handler and from the disconnect sweep. It's the cache-invalidation
  // trigger -- the ONLY (along with surfaceRemoved) path that releases a
  // cached GPU import per rule A.
  notifyBufferDestroyed(bufferId: number): void {
    this.dispatch(this.lifecycle.step({ kind: "bufferDestroyed", bufferId }));
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
  //
  // Lifecycle wiring: frameStart at top; frameSampled per drawn dmabuf surface
  // (drives Layer C's per-frame BeginAccess); submitted after queue.submit (drives
  // EndAccess); gpuCompleted on onSubmittedWorkDone (drives release intents).
  // The early-return paths emit frameAborted so the lifecycle's open begin is
  // rolled back without leaving a dangling access bracket.
  renderFrame(): void {
    let targetView = this.targetView;
    let presenting = false;
    let frameOpen = false;
    if (this.nested) {
      const handle = this.addon.acquireOutputTexture();
      if (handle === null) return;  // no swapchain texture this frame; no frame opened
      if (!this.dawn) return;
      this.outputTex = this.dawn.wrapTexture(this.deviceHandle, handle);
      targetView = this.outputTex.createView();
      presenting = true;
    }
    if (!targetView) return;  // headless before the target exists (shouldn't happen)

    this.dispatch(this.lifecycle.step({ kind: "frameStart" }));
    frameOpen = true;

    // Per-frame BeginAccess pass: for each dmabuf surface that will draw, write
    // an in-band kind=1 frame on the core wire BEFORE encoding the sample
    // command. All begins are written up-front (each appendFrame flushes any
    // staged Dawn bytes first); the encode+submit below then produces the
    // sample wire commands as a later kind=0 batch, so on the wire the order is
    // [begin...][sample submit batch][end...] -- every bracket is open by the
    // time the GPU process's HandleCommands decodes the samples. No round-trip;
    // the Node thread does not block.
    //
    // `bracketed` holds the (importId, bufferId) of every dmabuf surface we
    // opened a bracket on, in draw order; the post-submit End pass walks it to
    // write kind=2 frames.
    const bracketed: Array<{ importId: number; bufferId: number }> = [];
    const draw = this.drawOrder();
    for (const id of draw) {
      const s = this.surfaces.get(id);
      if (!s || !s.present || !s.bindGroup) continue;
      if (s.currentBufferId === 0) continue;  // shm or plugin overlay; no lifecycle
      const imp = this.dmabufImports.get(s.currentBufferId);
      if (!imp) continue;  // import not yet resolved (async); will draw next frame
      // The dmabufImports gate above already proved the import is live (its
      // handle was installed only after the GPU process applied the inject).
      // writeBeginAccess therefore must succeed; a false return means the
      // JS-side import gate and the core's jsImportHandles_ map have desynced
      // -- a contract violation, not a recoverable per-frame condition. Surface
      // it loudly (the GPU process hard-fails on its side for analogous bugs).
      if (!this.addon.writeBeginAccess(imp.importId)) {
        throw new Error(
          `writeBeginAccess returned false for live import ` +
          `(bufferId=${s.currentBufferId}, importId=${imp.importId}): ` +
          `dmabufImports gate / core handle map desync`,
        );
      }
      // Bracket open. Tell the state machine the surface was sampled. The
      // resulting beginAccess intent is informational (the executor's
      // runIntent("beginAccess") is a no-op; the real Begin already
      // happened). The state machine sets accessOpen, adds to frame.sampled.
      this.dispatch(this.lifecycle.step({ kind: "frameSampled", surfaceId: id }));
      bracketed.push({ importId: imp.importId, bufferId: s.currentBufferId });
    }

    try {
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
      for (const id of draw) {
        const s = this.surfaces.get(id);
        if (s && s.present && s.bindGroup) {
          this.updatePlacement(s);
          pass.setBindGroup(0, s.bindGroup);
          pass.draw(4);
        }
      }
      pass.end();
      this.device.queue.submit([enc.finish()]);

      // Tag the submit; on GPU completion advance completedSerial and emit
      // gpuCompleted to the lifecycle (which fires deferred release intents).
      const serial = ++this.submitSerial;
      this.dispatch(this.lifecycle.step({ kind: "submitted", serial }));
      frameOpen = false;

      // EndAccess pass: write an in-band kind=2 frame for every bracket we
      // opened. Its FIFO position after the submit's kind=0 batch guarantees
      // the GPU process closes the bracket only after decoding the sample
      // commands -- the role the wireSerial-tagged WireBarrier deferral played
      // before, now intrinsic to the wire ordering (no flush+sample, no tag).
      // appendFrame flushes the submit's staged wire bytes as that kind=0 batch
      // before writing the first kind=2, so the ordering holds without an
      // explicit flushCoreWire. Then synthesize endAccessFenceExported to
      // satisfy the state-machine chain-fence tracking (the actual fence lives
      // in the GPU process and is chained intra-process; the state-machine
      // field is informational, used by the unit-test invariant 7).
      for (const { importId, bufferId } of bracketed) {
        this.addon.writeEndAccess(importId);
        this.dispatch(this.lifecycle.step({
          kind: "endAccessFenceExported", bufferId,
          // Sentinel: the GPU process exports a real fence and chains it
          // intra-process. The state machine doesn't see the fd; the kind
          // != "none" is what the chain-fence invariant tests check for.
          fence: { kind: "syncFile", fd: -1 },
        }));
      }

      this.device.queue.onSubmittedWorkDone().then(() => {
        if (serial > this.completedSerial) this.completedSerial = serial;
        this.dispatch(this.lifecycle.step({ kind: "gpuCompleted", serial }));
        this.runAfterFrame();
      });

      if (presenting) {
        this.addon.presentOutput();
        this.outputTex = null;
      }
    } catch (e) {
      // If anything threw between frameStart and submitted, roll back the open
      // begin so the lifecycle's invariant 2 (alternation) is preserved.
      if (frameOpen) {
        try { this.dispatch(this.lifecycle.step({ kind: "frameAborted" })); }
        catch { /* secondary throw -- intentionally swallowed */ }
      }
      throw e;
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
    currentBufferId: 0,
  };
}
