// Per-surface in-thread intercept state. Owns a 3-slot output ring on
// core's GPUDevice, rotates through it on each tick, and routes the
// plugin's render callback. The output ring is sized to the surface's
// current client-texture dimensions; reallocated on size change.
//
// In-thread plugins share core's device, so the plugin writes directly
// into the ring textures we provide. The "fence" between plugin
// writes and core's subsequent sample is implicit: same-device queue
// ordering serializes them.
//
// One state per intercepted surface. The broker creates it on
// onSurfaceMatched and destroys it on onSurfaceUnmatched.

import type {
  InterceptHandlers, InterceptRenderResult,
} from "@overdraw/intercept-types";

export interface InThreadTickDeps {
  device: GPUDevice;
  // Returns the surface's current client-side sampled texture (the
  // input the plugin reads from). May return null if the surface has
  // no committed buffer yet -- in that case, skip the tick and clear
  // the intercept output (the surface draws raw / nothing).
  clientTexture(surfaceId: number):
    { texture: GPUTexture; w: number; h: number } | null;
  // The surface's intrinsic logical size (viewport destination, else buffer
  // dims / buffer_scale). Divides the client texture's buffer-pixel dims to
  // give the surface-local -> buffer-pixel scale factor; a fractional-scale
  // or buffer_scale>1 client commits a buffer larger than its logical size.
  // Null (unknown surface / no sink support) means assume scale 1.
  surfaceLogicalSize(surfaceId: number): { w: number; h: number } | null;
  // Monotonic client-content version for the surface. Compared across ticks
  // to set ctx.contentChanged (did the client commit new content since this
  // plugin last rendered).
  contentEpoch(surfaceId: number): number;
  // Whether the surface is in this frame's draw list. Skip render
  // dispatch when false.
  isPresentable(surfaceId: number): boolean;
  // The surface's WM-assigned outer rect. Passed into the render
  // ctx as surfaceRect so plugins can compute placement-relative
  // output sizing. Returns null for unknown surfaces; the tick
  // treats null as a zero rect.
  surfaceWmRect(surfaceId: number):
    { x: number; y: number; w: number; h: number } | null;
  // Whether the committed buffer matches the WM content rect at the output
  // scale. Surfaced as ctx.contentReady for scale-correct gate release.
  contentReady(surfaceId: number): boolean;
  // Whether the surface currently holds keyboard focus. Surfaced as
  // ctx.activated so a plugin styles focus level-triggered from live seat
  // state instead of an async window.change edge.
  isActivated(surfaceId: number): boolean;
  // The client's declared window geometry in surface-local (logical)
  // coordinates, or null if unset. The tick maps it into buffer pixels via
  // surfaceLogicalSize before clamping against the client texture.
  surfaceGeometry(surfaceId: number):
    { x: number; y: number; width: number; height: number } | null;
  // Open a BeginAccess bracket on the surface's client dmabuf import
  // (if any), run fn, close with EndAccess. SHM-backed surfaces pass
  // through with no bracket. The plugin's render call MUST run
  // inside this bracket because it samples the client texture (a
  // SharedTextureMemory-backed resource that requires explicit
  // access brackets for any GPU use). Returns true if fn ran;
  // false if the bracket could not be opened (the tick treats it
  // as a skipped frame).
  withClientTextureAccess(surfaceId: number, fn: () => void): boolean;
  // The compositor-facing sink for install/clear.
  installOutput(surfaceId: number, view: GPUTextureView,
                placement: { x: number; y: number; w: number; h: number } | null): void;
  clearOutput(surfaceId: number): void;
  // Texture-usage flag bag (from dawn.globals).
  textureUsage: typeof GPUTextureUsage;
  // Log destination (so failures from a misbehaving render callback
  // are visible).
  log: (line: string) => void;
}

// Gate configuration attached when the registration declared `gates`.
// The state engages the gate on construction and releases via the
// releaseGate callback exposed in the render ctx, on render throw,
// or on destroy.
export interface InThreadGateConfig {
  // Engage / release the WM content gate. Owner is the unique key
  // the broker chose (typically `"intercept-${spec.name}"`).
  ownerKey: string;
  engage(surfaceId: number, owner: string): void;
  release(surfaceId: number, owner: string): void;
  // Backstop timeout in ms. If the plugin neither releases nor
  // renders successfully within this window, the gate is
  // force-released. Default 10s.
  timeoutMs: number;
}

export class InThreadInterceptState {
  readonly surfaceId: number;
  private readonly handlers: InterceptHandlers;
  private readonly deps: InThreadTickDeps;
  private readonly pluginName: string;
  private readonly gate: InThreadGateConfig | null;
  private gateActive = false;
  private gateTimer: ReturnType<typeof setTimeout> | null = null;

  // 3-slot ring on core's device. Reallocated on input-dimension change.
  private ring: GPUTexture[] = [];
  private views: GPUTextureView[] = [];
  private ringW = 0;
  private ringH = 0;
  private next = 0;
  // The client content-epoch at this surface's last successful render. -1 =
  // never rendered, so the first tick reports contentChanged = true.
  private lastRenderedEpoch = -1;

  // Counter for consecutive render-throw failures. If we hit
  // FAILURE_THRESHOLD, the broker treats the registration as dead.
  // Reset on a successful render.
  private consecutiveFailures = 0;
  private frameNumber = 0;
  static readonly FAILURE_THRESHOLD = 30;
  static readonly DEFAULT_GATE_TIMEOUT_MS = 10000;

  constructor(surfaceId: number, pluginName: string,
              handlers: InterceptHandlers, deps: InThreadTickDeps,
              gate?: InThreadGateConfig | null) {
    this.surfaceId = surfaceId;
    this.pluginName = pluginName;
    this.handlers = handlers;
    this.deps = deps;
    this.gate = gate ?? null;
    if (this.gate) {
      // Engage the gate at construction (the broker calls onSurfaceMatched
      // immediately after; the plugin's handler runs with the gate already
      // engaged, so a setInsets-then-relayout sequence does not race a
      // brief draw-stack visit).
      this.gate.engage(this.surfaceId, this.gate.ownerKey);
      this.gateActive = true;
      this.gateTimer = setTimeout(() => {
        this.deps.log(
          `[intercept ${this.pluginName}] surface ${this.surfaceId}: ` +
          `gate backstop fired (${this.gate?.timeoutMs ?? 0}ms); force-releasing`);
        this.releaseGate();
      }, this.gate.timeoutMs);
    }
  }

  // Public: idempotent release of the WM content gate engaged at
  // construction (if any). Called from the plugin via ctx.releaseGate
  // inside a render call; also called automatically on render throw,
  // destroy, and the backstop timer.
  releaseGate(): void {
    if (!this.gateActive || !this.gate) return;
    this.gateActive = false;
    if (this.gateTimer !== null) {
      clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
    this.gate.release(this.surfaceId, this.gate.ownerKey);
  }

  // Per-frame tick. Called by the broker BEFORE renderFrame for each
  // intercepted surface. Returns true if the intercept produced a valid
  // output for this frame (compositor uses it); false if not (the broker
  // should clear the intercept output and let the surface fall back to
  // raw -- or, when consecutiveFailures crosses threshold, deactivate
  // the intercept entirely).
  tick(timeMs: number): TickResult {
    this.frameNumber += 1;
    if (!this.deps.isPresentable(this.surfaceId)) {
      // Surface isn't being composited this frame; nothing to do.
      // Don't count as a failure -- it's just off-screen.
      return { ok: true, rendered: false };
    }
    const input = this.deps.clientTexture(this.surfaceId);
    if (!input) {
      // No committed buffer; surface draws nothing anyway. Not a
      // failure either.
      this.deps.clearOutput(this.surfaceId);
      return { ok: true, rendered: false };
    }
    // Content rect = the client's window geometry (set_window_geometry) clamped
    // to the buffer, or the whole buffer when unset. This is the region the
    // plugin sees as input.rect; a CSD client's transparent drop-shadow margin
    // (buffer beyond the geometry) is excluded, so a decoration bands the real
    // window, not the shadow. The plugin reads the full buffer size off
    // input.texture when it needs to map input.rect into texture UVs.
    //
    // The geometry is in surface-local (logical) coordinates while input.w/h
    // are buffer pixels; a fractional-scale or buffer_scale>1 client commits
    // a buffer larger than its logical size, so scale the geometry into
    // buffer pixels first (identity for scale-1 clients). Without this, the
    // input rect covers only the top-left logicalW x logicalH buffer pixels
    // -- the window renders cropped and upscaled.
    const geom = this.deps.surfaceGeometry(this.surfaceId);
    const logical = this.deps.surfaceLogicalSize(this.surfaceId);
    const sx = logical && logical.w > 0 ? input.w / logical.w : 1;
    const sy = logical && logical.h > 0 ? input.h / logical.h : 1;
    const cx = geom ? Math.max(0, Math.min(Math.round(geom.x * sx), input.w - 1)) : 0;
    const cy = geom ? Math.max(0, Math.min(Math.round(geom.y * sy), input.h - 1)) : 0;
    const cw = geom ? Math.max(1, Math.min(Math.round(geom.width * sx), input.w - cx)) : input.w;
    const ch = geom ? Math.max(1, Math.min(Math.round(geom.height * sy), input.h - cy)) : input.h;
    try {
      this.ensureRing(cw, ch);
    } catch (e: unknown) {
      // outputDimensions returned bad values, or createTexture threw
      // (e.g. exceeds maxTextureDimension2D). Treat as a programming
      // error: count it as a consecutive failure and surface via the
      // existing FAILURE_THRESHOLD auto-unregister path.
      const msg = e instanceof Error ? e.message : String(e);
      this.consecutiveFailures += 1;
      this.deps.log(
        `[intercept ${this.pluginName}] surface ${this.surfaceId} ` +
        `ensureRing failed: ${msg}` +
        (this.consecutiveFailures >= InThreadInterceptState.FAILURE_THRESHOLD
          ? ` (${this.consecutiveFailures} consecutive failures; deactivating)`
          : ""));
      this.deps.clearOutput(this.surfaceId);
      this.releaseGate();
      if (this.consecutiveFailures >= InThreadInterceptState.FAILURE_THRESHOLD) {
        return { ok: false, rendered: false };
      }
      return { ok: true, rendered: false };
    }
    this.next = (this.next + 1) % this.ring.length;
    const outTex = this.ring[this.next];
    const outView = this.views[this.next];
    if (!outTex || !outView) {
      this.deps.log(
        `[intercept ${this.pluginName}] surface ${this.surfaceId}: ring slot missing`);
      return { ok: true, rendered: false };
    }

    const wmRect = this.deps.surfaceWmRect(this.surfaceId)
      ?? { x: 0, y: 0, w: 0, h: 0 };
    const epoch = this.deps.contentEpoch(this.surfaceId);
    const contentChanged = epoch !== this.lastRenderedEpoch;
    const holder: { result: InterceptRenderResult | false | void; error: unknown } =
      { result: undefined, error: null };
    // Wrap the plugin's render in a BeginAccess/EndAccess bracket
    // around the surface's client dmabuf import. The plugin samples
    // input.texture during render; without the bracket the GPU
    // process rejects the submit with a SharedTextureMemory access
    // error. SHM-backed surfaces have no import; the bracket is a
    // no-op for them but fn still runs.
    const bracketed = this.deps.withClientTextureAccess(this.surfaceId, () => {
      try {
        holder.result = this.handlers.render({
          input: {
            texture: input.texture,
            rect: { x: cx, y: cy, w: cw, h: ch },
          },
          output: {
            texture: outTex,
            rect: { x: 0, y: 0, w: this.ringW, h: this.ringH },
          },
          ctx: {
            surfaceId: this.surfaceId,
            frameNumber: this.frameNumber,
            time: timeMs,
            surfaceRect: wmRect,
            contentChanged,
            contentReady: this.deps.contentReady(this.surfaceId),
            activated: this.deps.isActivated(this.surfaceId),
            releaseGate: () => this.releaseGate(),
          },
        });
      } catch (e: unknown) {
        holder.error = e;
      }
    });
    if (!bracketed) {
      // Bracket open failed (e.g. dmabuf import not yet resolved
      // async). Not a failure -- the next tick will retry. Don't
      // touch the failure counter; this is a transient skip akin to
      // "no client texture yet."
      return { ok: true, rendered: false };
    }
    if (holder.error !== null) {
      const e = holder.error;
      const msg = e instanceof Error ? e.message : String(e);
      this.consecutiveFailures += 1;
      this.deps.log(
        `[intercept ${this.pluginName}] surface ${this.surfaceId} render threw: ${msg}` +
        (this.consecutiveFailures >= InThreadInterceptState.FAILURE_THRESHOLD
          ? ` (${this.consecutiveFailures} consecutive failures; deactivating)`
          : ''));
      this.deps.clearOutput(this.surfaceId);
      // A broken render must not hold the window invisible; release
      // the gate so the surface falls back to raw client (matches
      // today's "broken decoration provider -> undecorated window"
      // semantics).
      this.releaseGate();
      if (this.consecutiveFailures >= InThreadInterceptState.FAILURE_THRESHOLD) {
        return { ok: false, rendered: false };
      }
      return { ok: true, rendered: false };
    }
    this.consecutiveFailures = 0;

    // The plugin reported it produced no new output this frame (a static
    // effect whose inputs are unchanged). Keep the previously-installed output;
    // don't install or damage, so the compositor's dirty gate skips this
    // surface's region. The ring slot we rotated to is simply reused next time.
    // Do NOT advance lastRenderedEpoch: if the client content had actually
    // changed, a well-behaved plugin renders rather than skipping, so this only
    // happens when contentChanged was false anyway.
    if (holder.result === false) {
      return { ok: true, rendered: false };
    }

    this.lastRenderedEpoch = epoch;
    const outputRect = holder.result?.outputRect ?? null;
    this.deps.installOutput(this.surfaceId, outView, outputRect);
    return { ok: true, rendered: true };
  }

  // Tear down: clear the compositor's intercept output, drop the ring,
  // and release the WM content gate (if any). Idempotent.
  destroy(): void {
    this.releaseGate();
    this.deps.clearOutput(this.surfaceId);
    for (const t of this.ring) t.destroy();
    this.ring = [];
    this.views = [];
  }

  // Allocate or reallocate the output ring. (inputW, inputH) are the
  // client texture dimensions. If the plugin declared outputDimensions,
  // the callback maps input to output dims (border plugins add 2B on
  // each side); otherwise identity. Throws if the callback returns
  // invalid dimensions or createTexture rejects; the caller catches and
  // counts toward the failure threshold.
  private ensureRing(inputW: number, inputH: number): void {
    const out = this.handlers.outputDimensions
      ? this.handlers.outputDimensions(inputW, inputH)
      : { w: inputW, h: inputH };
    if (!Number.isFinite(out.w) || !Number.isFinite(out.h) ||
        out.w <= 0 || out.h <= 0 ||
        !Number.isInteger(out.w) || !Number.isInteger(out.h)) {
      throw new Error(
        `outputDimensions returned invalid size {w:${out.w}, h:${out.h}} ` +
        `for input ${inputW}x${inputH}`);
    }
    if (this.ringW === out.w && this.ringH === out.h && this.ring.length === 3) return;
    for (const t of this.ring) t.destroy();
    this.ring = [];
    this.views = [];
    this.ringW = out.w;
    this.ringH = out.h;
    const usage = this.deps.textureUsage.RENDER_ATTACHMENT
                | this.deps.textureUsage.TEXTURE_BINDING
                | this.deps.textureUsage.COPY_SRC
                | this.deps.textureUsage.COPY_DST;
    for (let i = 0; i < 3; ++i) {
      const t = this.deps.device.createTexture({
        size: { width: out.w, height: out.h, depthOrArrayLayers: 1 },
        format: "bgra8unorm",
        usage,
      });
      this.ring.push(t);
      this.views.push(t.createView());
    }
    this.next = 2;   // next tick rotates to 0
  }

  // Test introspection.
  failureCount(): number { return this.consecutiveFailures; }
  ringSize(): { w: number; h: number; slots: number } {
    return { w: this.ringW, h: this.ringH, slots: this.ring.length };
  }
}

export interface TickResult {
  // true unless we crossed the failure threshold and want the broker
  // to drop this registration.
  ok: boolean;
  // true when the plugin's output is installed in the compositor and
  // will be used to draw the surface this frame. false when the
  // surface falls back to raw (no committed buffer / off-screen / render
  // threw).
  rendered: boolean;
}
