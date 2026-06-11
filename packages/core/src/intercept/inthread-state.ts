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

export class InThreadInterceptState {
  readonly surfaceId: number;
  private readonly handlers: InterceptHandlers;
  private readonly deps: InThreadTickDeps;
  private readonly pluginName: string;

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

  constructor(surfaceId: number, pluginName: string,
              handlers: InterceptHandlers, deps: InThreadTickDeps) {
    this.surfaceId = surfaceId;
    this.pluginName = pluginName;
    this.handlers = handlers;
    this.deps = deps;
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
    this.ensureRing(input.w, input.h);
    this.next = (this.next + 1) % this.ring.length;
    const outTex = this.ring[this.next];
    const outView = this.views[this.next];
    if (!outTex || !outView) {
      this.deps.log(
        `[intercept ${this.pluginName}] surface ${this.surfaceId}: ring slot missing`);
      return { ok: true, rendered: false };
    }

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
      if (this.consecutiveFailures >= InThreadInterceptState.FAILURE_THRESHOLD) {
        return { ok: false, rendered: false };
      }
      return { ok: true, rendered: false };
    }

    const outputRect = result?.outputRect ?? null;
    this.deps.installOutput(this.surfaceId, outView, outputRect);
    return { ok: true, rendered: true };
  }

  // Tear down: clear the compositor's intercept output, drop the ring.
  destroy(): void {
    this.deps.clearOutput(this.surfaceId);
    for (const t of this.ring) t.destroy();
    this.ring = [];
    this.views = [];
  }

  private ensureRing(w: number, h: number): void {
    if (this.ringW === w && this.ringH === h && this.ring.length === 3) return;
    for (const t of this.ring) t.destroy();
    this.ring = [];
    this.views = [];
    this.ringW = w;
    this.ringH = h;
    const usage = this.deps.textureUsage.RENDER_ATTACHMENT
                | this.deps.textureUsage.TEXTURE_BINDING
                | this.deps.textureUsage.COPY_SRC
                | this.deps.textureUsage.COPY_DST;
    for (let i = 0; i < 3; ++i) {
      const t = this.deps.device.createTexture({
        size: { width: w, height: h, depthOrArrayLayers: 1 },
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
