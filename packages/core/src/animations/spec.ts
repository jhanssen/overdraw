// Animation spec types (core-plugin-api.md §9). Plugins construct
// AnimationSpec values (via @overdraw/sdk-anim or directly) and submit
// them to core's evaluator via sdk.animations.run. Every shape is
// structured-clone-safe so the spec survives the SDK boundary unchanged
// regardless of transport.
//
// v1 ships tween + spring + sequence + parallel (per core-plugin-api.md
// "Decided"). decay / keyframes / stagger are deferred until concrete
// use cases demand them.

// Per-surface render-state target. The kind picks which CompositorSink
// setter the evaluator writes each frame; windowId picks which surface.
//
// Per the design, a window's transform / margin are single composite
// values. An animation on window-transform owns ALL transform fields
// for its lifetime; to animate scale and translate independently,
// plugins write a single transform spec that interpolates both, OR
// compose via parallel of single-field-only tweens (which still hit
// cancel-on-replacement on the same target).
export type TargetRef =
  | { readonly kind: "window-opacity"; readonly windowId: number }
  | { readonly kind: "window-transform"; readonly windowId: number }
  | { readonly kind: "window-output-margin"; readonly windowId: number };

// The set of values an animation can interpolate. The shape matches the
// CompositorSink setters' payloads. For window-transform / -output-margin,
// `from`/`to` may omit fields; the evaluator fills missing fields with
// the identity / zero default at construction time.
export interface TransformValue {
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
}
export interface MarginValue {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}
// ValueOf<TargetRef>: scalar for opacity, struct for the others.
export type ValueOf<T extends TargetRef> =
  T extends { kind: "window-opacity" } ? number
  : T extends { kind: "window-transform" } ? TransformValue
  : T extends { kind: "window-output-margin" } ? MarginValue
  : never;

// Cubic-bezier control points (matches CSS cubic-bezier(x1,y1,x2,y2)).
// The four standard CSS presets are accepted as named strings.
export type EasingPreset = "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out";
export interface CubicBezier {
  readonly kind: "cubic-bezier";
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}
export type EasingSpec = EasingPreset | CubicBezier;

// The four v1 spec variants. `from` is required in v1; future versions
// may default it from the surface's current value when omitted.
export interface TweenSpec {
  readonly type: "tween";
  readonly target: TargetRef;
  readonly from: unknown;     // ValueOf<target.kind>, untyped at runtime
  readonly to: unknown;       // same
  readonly duration: number;  // ms; must be > 0
  readonly easing?: EasingSpec;  // default "linear"
}
export interface SpringSpec {
  readonly type: "spring";
  readonly target: TargetRef;
  readonly from: unknown;
  readonly to: unknown;
  // Standard semi-implicit Euler params. Defaults if omitted:
  //   stiffness = 200, damping = 20, mass = 1.
  readonly stiffness?: number;
  readonly damping?: number;
  readonly mass?: number;
  // Initial velocity in value-units per second. Default 0.
  readonly initialVelocity?: number;
}
export interface SequenceSpec {
  readonly type: "sequence";
  readonly items: readonly AnimationSpec[];
}
export interface ParallelSpec {
  readonly type: "parallel";
  readonly items: readonly AnimationSpec[];
}
export type AnimationSpec = TweenSpec | SpringSpec | SequenceSpec | ParallelSpec;

// Opaque handle returned by run(); reserved for future cancel-by-handle.
// Cancel-by-target (TargetRef) is the v1 path -- it composes with the
// cancel-on-replacement rule (one active animation per target).
export type AnimationHandle = number;
