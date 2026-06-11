// Canonical types for the transitions namespace (core-plugin-api.md §8).
//
// A transition blends two composed scenes over time. The interpolation
// target is "which pixels go on screen," not a numeric value (numeric
// interpolation lives in the animations namespace). Closed set of
// built-in shaders; anything beyond the named kinds uses
// sdk.output.takeover.
//
// Plugins build TransitionSpec values (today by passing the fields
// directly to sdk.transitions.run; a sdk-anim-style builder may follow)
// and submit them to core via that method. The spec is structured-clone-
// safe so it survives the SDK boundary unchanged regardless of transport
// (the SceneHandle references are passed alongside, not inside the spec).
//
// Type-only: no runtime code.

import type { EasingSpec } from "@overdraw/animation-types";

// The closed set of built-in transition kinds. Each maps to one branch
// of the transition fragment shader in gpu/compositor.ts.
//
//   crossfade   - mix(from, to, progress)
//   slide-left  - from slides off left, to enters from right
//   slide-right - from slides off right, to enters from left
//   slide-up    - from slides off top, to enters from bottom
//   slide-down  - from slides off bottom, to enters from top
//   scale       - from scales down + fades; to scales up from center
export type TransitionKind =
  | "crossfade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "scale";

// The full set of kinds, exported as a runtime-checkable array for
// validation at the broker boundary. Mirrors TransitionKind exactly;
// adding a kind means adding to both.
export const TRANSITION_KINDS: readonly TransitionKind[] = [
  "crossfade",
  "slide-left",
  "slide-right",
  "slide-up",
  "slide-down",
  "scale",
] as const;

// Plugin-facing transition spec. The from/to SceneHandle references are
// passed as a separate argument to sdk.transitions.run (not inside the
// spec) because they carry process-local state that does not survive
// structured clone; the spec itself is pure data.
export interface TransitionSpec {
  readonly kind: TransitionKind;
  // Duration in milliseconds. Must be > 0; the broker rejects 0 / negative.
  readonly duration: number;
  // Easing applied to normalized progress before sampling. Defaults to
  // "linear" when omitted.
  readonly easing?: EasingSpec;
}

// Re-export EasingSpec so plugin authors importing TransitionSpec don't
// also need to depend on @overdraw/animation-types just to type the
// optional field. (The package dependency is in place anyway; this is
// for ergonomics at the call site.)
export type { EasingSpec } from "@overdraw/animation-types";
