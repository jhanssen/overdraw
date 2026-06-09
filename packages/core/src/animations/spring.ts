// Semi-implicit Euler integrator for spring physics (core-plugin-api.md
// §9 "Decided"). Standard formulation:
//   accel = (-stiffness * (x - target) - damping * v) / mass
//   v += accel * dt
//   x += v * dt
//
// Semi-implicit (not explicit) Euler: velocity updates BEFORE position,
// so high-frequency systems do not blow up the way explicit Euler does.
// The standard form for animation libraries; borrowing the integrator,
// not experimenting with one.
//
// Rest detection: a spring is "settled" when displacement and velocity
// are both below per-component thresholds. Absolute thresholds (not
// scaled by displacement) keep the rest check predictable across
// unit-scale (opacity, scale) and pixel-scale (translate) targets;
// callers using larger pixel offsets may see settle take a few extra
// frames vs. tighter scaled thresholds, which is acceptable.

export interface SpringParams {
  // Default 200. Higher = snappier; lower = looser.
  readonly stiffness: number;
  // Default 20. Higher = more drag; critical damping at ~28.3 for k=200,m=1.
  readonly damping: number;
  // Default 1. Higher = slower to accelerate.
  readonly mass: number;
  // Default 0. Initial velocity in value-units per second.
  readonly initialVelocity: number;
}

export const DEFAULT_SPRING: SpringParams = {
  stiffness: 200, damping: 20, mass: 1, initialVelocity: 0,
};

// Rest thresholds. precision = position must be within this of the
// target; restVelocity = velocity must be below this. Tuned for the
// unit-scale opacity/scale case; pixel-scale animations settle a frame
// or two later (the asymptote is reached visibly).
const PRECISION = 0.01;
const REST_VELOCITY = 0.01;

// Per-component spring state. Step in-place each frame and read `done`
// to know when to retire. `value` is the current interpolated value;
// `velocity` is the running rate of change.
export class SpringState {
  // Public so the evaluator reads the current value cheaply.
  value: number;
  velocity: number;
  readonly target: number;
  readonly params: SpringParams;

  constructor(from: number, target: number, params: SpringParams) {
    this.value = from;
    this.velocity = params.initialVelocity;
    this.target = target;
    this.params = params;
  }

  // Advance dt seconds. Returns true if the spring settled this step
  // (value snaps exactly to target). Idempotent once settled.
  step(dtSec: number): boolean {
    if (this.done()) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    const { stiffness, damping, mass } = this.params;
    const accel = (-stiffness * (this.value - this.target) - damping * this.velocity) / mass;
    this.velocity += accel * dtSec;
    this.value += this.velocity * dtSec;
    if (this.done()) {
      this.value = this.target;
      this.velocity = 0;
      return true;
    }
    return false;
  }

  done(): boolean {
    return Math.abs(this.value - this.target) < PRECISION
        && Math.abs(this.velocity) < REST_VELOCITY;
  }
}
