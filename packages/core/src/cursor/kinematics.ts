// Cursor kinematic state: smoothed velocity + shake detection + idle
// timer. Feeds the cursor rule engine (Phase 9c) so plugin rules like
// `when: {speedRange: [500, Infinity]}` or `{shake: true}` can match
// against derived pointer state without subscribing to every motion
// event.
//
// Algorithms are direct ports of hypr-dynamic-cursors (rotate / tilt /
// stretch / shake). The shake detector uses the "trail / diagonal of
// bounding box" ratio (the KWin algorithm hypr copied). Velocity uses
// a windowed finite-difference over a ring buffer.
//
// Lazy enablement: the state machine does nothing until at least one
// consumer is registered. enable() bumps a refcount; disable() drops.
// The compositor (or its bus glue) calls update() on pointer motion
// only when the state machine is enabled.

export interface KinematicsSnapshot {
  // Smoothed speed in output pixels per second (magnitude).
  speedPxPerSec: number;
  velocityX: number;
  velocityY: number;
  // True while a shake gesture is in progress.
  shake: boolean;
  // Live shake intensity (trail / diagonal of bounding box, minus
  // threshold). 0 when not shaking. Useful for animating magnification
  // amounts off the live ratio.
  shakeIntensity: number;
  // Milliseconds since the last pointer motion event. Reset to 0 on
  // each motion; counts up via tick().
  idleMs: number;
}

export interface KinematicsConfig {
  // Velocity sample window in ms (window over which the finite-
  // difference is taken). Each registered rule with a `speedRange`
  // predicate contributes a desired window; the state machine sizes
  // its ring to the max across rules. Default 100ms (hypr's default).
  velocityWindowMs?: number;
  // Shake detector window (1s of history is hypr's default).
  shakeWindowMs?: number;
  // Shake threshold: ratio of (trail / diagonal) above which a shake
  // is detected. Hypr default 6.0.
  shakeThreshold?: number;
  // Sample rate the ring is sized against. The display frame clock
  // would be the natural choice but is fabricated today (status.md
  // "Read first"); hardcode 60Hz. When the display-driven clock
  // lands, the count math becomes correct without code change.
  sampleHz?: number;
}

const DEFAULTS: Required<KinematicsConfig> = {
  velocityWindowMs: 100,
  shakeWindowMs: 1000,
  shakeThreshold: 6.0,
  sampleHz: 60,
};

export class Kinematics {
  private readonly cfg: Required<KinematicsConfig>;
  private enableRefCount = 0;

  // Position ring + per-step distance ring (for the shake detector).
  // Sized to max(velocityWindowMs, shakeWindowMs) * sampleHz / 1000;
  // smaller windows read a suffix.
  private posX: Float64Array;
  private posY: Float64Array;
  private dist: Float64Array;
  private ringSize: number;
  private writeIdx = 0;
  private samplesSeen = 0;

  // Velocity computation window (in samples).
  private velocitySamples: number;
  // Shake window (in samples).
  private shakeSamples: number;

  private lastTickMs = 0;
  private firstTick = true;       // distinguishes "never ticked" from "ticked at t=0"
  private idleMsAccum = 0;

  // Cached snapshot (updated on every motion + tick); read by rule engine.
  private snap: KinematicsSnapshot = {
    speedPxPerSec: 0, velocityX: 0, velocityY: 0,
    shake: false, shakeIntensity: 0, idleMs: 0,
  };

  constructor(cfg: KinematicsConfig = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    const maxMs = Math.max(this.cfg.velocityWindowMs, this.cfg.shakeWindowMs);
    this.ringSize = Math.max(2, Math.ceil(this.cfg.sampleHz * maxMs / 1000));
    this.velocitySamples = Math.max(2, Math.ceil(this.cfg.sampleHz * this.cfg.velocityWindowMs / 1000));
    this.shakeSamples = Math.max(2, Math.ceil(this.cfg.sampleHz * this.cfg.shakeWindowMs / 1000));
    this.posX = new Float64Array(this.ringSize);
    this.posY = new Float64Array(this.ringSize);
    this.dist = new Float64Array(this.ringSize);
  }

  // Refcounted enablement. update() and tick() do nothing while the
  // refcount is zero (no consumer cares; don't pay the per-motion cost).
  enable(): void { this.enableRefCount += 1; }
  disable(): void {
    if (this.enableRefCount > 0) this.enableRefCount -= 1;
    if (this.enableRefCount === 0) this.reset();
  }
  isEnabled(): boolean { return this.enableRefCount > 0; }

  // Reset all state. Called on disable-to-zero; tests use it for clean
  // case isolation.
  reset(): void {
    this.posX.fill(0);
    this.posY.fill(0);
    this.dist.fill(0);
    this.writeIdx = 0;
    this.samplesSeen = 0;
    this.lastTickMs = 0;
    this.firstTick = true;
    this.idleMsAccum = 0;
    this.snap = {
      speedPxPerSec: 0, velocityX: 0, velocityY: 0,
      shake: false, shakeIntensity: 0, idleMs: 0,
    };
  }

  // Feed a pointer motion event. (x, y) in output-space pixels. The event
  // timestamp is accepted for signature stability but unused: idle time is
  // tracked by tick(), and velocity assumes sampleHz spacing.
  update(x: number, y: number, _timeMs: number): void {
    if (this.enableRefCount === 0) return;
    // Distance from the previous sample (for the shake trail).
    const prevIdx = (this.writeIdx + this.ringSize - 1) % this.ringSize;
    const dx = this.samplesSeen > 0 ? x - this.posX[prevIdx] : 0;
    const dy = this.samplesSeen > 0 ? y - this.posY[prevIdx] : 0;
    const d = Math.hypot(dx, dy);
    this.posX[this.writeIdx] = x;
    this.posY[this.writeIdx] = y;
    this.dist[this.writeIdx] = d;
    this.writeIdx = (this.writeIdx + 1) % this.ringSize;
    if (this.samplesSeen < this.ringSize) this.samplesSeen += 1;

    this.idleMsAccum = 0;
    this.snap.idleMs = 0;

    this.recomputeVelocity();
    this.recomputeShake();
  }

  // Per-frame tick. Advances idle counter; the first tick after enable()
  // (or reset()) only initializes the baseline timestamp.
  tick(timeMs: number): void {
    if (this.enableRefCount === 0) return;
    if (this.firstTick) {
      this.lastTickMs = timeMs;
      this.firstTick = false;
      return;
    }
    const dt = Math.max(0, timeMs - this.lastTickMs);
    this.lastTickMs = timeMs;
    this.idleMsAccum += dt;
    this.snap.idleMs = this.idleMsAccum;
  }

  snapshot(): Readonly<KinematicsSnapshot> {
    return this.snap;
  }

  // ----- internals --------------------------------------------------------

  // Velocity over the last `velocitySamples` samples: (cur - first) / window.
  // Mirrors hypr's ModeTilt / ModeStretch finite-difference.
  private recomputeVelocity(): void {
    const n = Math.min(this.samplesSeen, this.velocitySamples);
    if (n < 2) {
      this.snap.velocityX = 0; this.snap.velocityY = 0; this.snap.speedPxPerSec = 0;
      return;
    }
    const cur = (this.writeIdx + this.ringSize - 1) % this.ringSize;
    const first = (cur + this.ringSize - (n - 1)) % this.ringSize;
    const windowMs = (n - 1) * (1000 / this.cfg.sampleHz);
    const vx = (this.posX[cur] - this.posX[first]) * 1000 / windowMs;
    const vy = (this.posY[cur] - this.posY[first]) * 1000 / windowMs;
    this.snap.velocityX = vx;
    this.snap.velocityY = vy;
    this.snap.speedPxPerSec = Math.hypot(vx, vy);
  }

  // Shake detection: trail = sum of per-step distances in the window.
  // diagonal = diagonal of the bounding box of positions in the window.
  // shake = (diagonal > 100px) && (trail / diagonal - threshold > 0).
  // KWin's algorithm, copied by hypr-dynamic-cursors.
  private recomputeShake(): void {
    const n = Math.min(this.samplesSeen, this.shakeSamples);
    if (n < 2) {
      this.snap.shake = false;
      this.snap.shakeIntensity = 0;
      return;
    }
    const cur = (this.writeIdx + this.ringSize - 1) % this.ringSize;
    // Sum distances + min/max box over the suffix.
    let trail = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < n; ++k) {
      const idx = (cur + this.ringSize - k) % this.ringSize;
      // dist[idx] is the step distance from the PREVIOUS sample; skip
      // the oldest step which is the boundary (only included for the
      // newer-than-first samples).
      if (k < n - 1) trail += this.dist[idx];
      const x = this.posX[idx], y = this.posY[idx];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const diagonal = Math.hypot(maxX - minX, maxY - minY);
    let intensity = 0;
    let shake = false;
    if (diagonal > 100) {
      const ratio = trail / diagonal;
      const amount = ratio - this.cfg.shakeThreshold;
      if (amount > 0) { shake = true; intensity = amount; }
    }
    this.snap.shake = shake;
    this.snap.shakeIntensity = intensity;
  }
}
