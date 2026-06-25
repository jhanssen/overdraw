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
  // Whether the surface is in this frame's draw list. Skip render
  // dispatch when false.
  isPresentable(surfaceId: number): boolean;
  // The surface's WM-assigned outer rect. Passed into the render
  // ctx so plugins can compute placement-relative output sizing
  // (e.g. border plugin's strict gate-release compares input.w
  // against surfaceRect.w - 2*B). Returns null for unknown
  // surfaces; the tick treats null as a zero rect.
  surfaceWmRect(surfaceId: number):
    { x: number; y: number; w: number; h: number } | null;
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
    try {
      this.ensureRing(input.w, input.h);
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
    let result: InterceptRenderResult | void;
    try {
      result = this.handlers.render({
        input: {
          texture: input.texture,
          rect: { x: 0, y: 0, w: input.w, h: input.h },
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
          releaseGate: () => this.releaseGate(),
        },
      });
      this.consecutiveFailures = 0;
    } catch (e: unknown) {
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

    const outputRect = result?.outputRect ?? null;
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
