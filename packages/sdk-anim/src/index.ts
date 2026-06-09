// Plugin-side spec builders for the animations namespace
// (core-plugin-api.md §9). Returns AnimationSpec values the plugin
// submits to core via sdk.animations.run; no runtime SDK dependency.
//
// Usage:
//   import { tween, spring, sequence, parallel, target } from "@overdraw/sdk-anim";
//
//   await sdk.animations.run(tween(target.windowOpacity(id),
//     { from: 1, to: 0, duration: 200 }));
//
//   await sdk.animations.run(spring(target.windowOpacity(id),
//     { from: 0, to: 1, stiffness: 200, damping: 20 }));
//
//   await sdk.animations.run(sequence(
//     tween(target.windowOpacity(id), { from: 0, to: 1, duration: 200 }),
//     tween(target.windowOpacity(id), { from: 1, to: 0, duration: 200 }),
//   ));
//
// The builders mirror Motion One's surface for author familiarity, but
// the spec-vs-runner split is core's: builders return AnimationSpec,
// the plugin passes it to sdk.animations.run. See core-plugin-api.md.

import type {
  AnimationSpec, CubicBezier, EasingPreset, EasingSpec,
  MarginValue, ParallelSpec, SequenceSpec, SpringSpec, TargetRef,
  TransformValue, TweenSpec,
} from "@overdraw/animation-types";

// Tween + easing options. `easing` defaults to "linear" on the core
// side when omitted; we accept either the preset strings, a built
// CubicBezier object, or the result of cubicBezier(x1, y1, x2, y2).
export interface TweenOpts {
  readonly from: unknown;
  readonly to: unknown;
  readonly duration: number;
  readonly easing?: EasingSpec;
}

export function tween(target: TargetRef, opts: TweenOpts): TweenSpec {
  return {
    type: "tween", target,
    from: opts.from, to: opts.to,
    duration: opts.duration,
    ...(opts.easing !== undefined ? { easing: opts.easing } : {}),
  };
}

// Spring opts. The evaluator defaults stiffness=200, damping=20,
// mass=1, initialVelocity=0 when omitted. Common presets are inline
// here rather than as a separate `springs.*` object -- there's little
// benefit to a named-presets table when the params are this short.
export interface SpringOpts {
  readonly from: unknown;
  readonly to: unknown;
  readonly stiffness?: number;
  readonly damping?: number;
  readonly mass?: number;
  readonly initialVelocity?: number;
}

export function spring(target: TargetRef, opts: SpringOpts): SpringSpec {
  const spec: SpringSpec = {
    type: "spring", target,
    from: opts.from, to: opts.to,
    ...(opts.stiffness !== undefined ? { stiffness: opts.stiffness } : {}),
    ...(opts.damping !== undefined ? { damping: opts.damping } : {}),
    ...(opts.mass !== undefined ? { mass: opts.mass } : {}),
    ...(opts.initialVelocity !== undefined ? { initialVelocity: opts.initialVelocity } : {}),
  };
  return spec;
}

export function sequence(...items: AnimationSpec[]): SequenceSpec {
  return { type: "sequence", items };
}

export function parallel(...items: AnimationSpec[]): ParallelSpec {
  return { type: "parallel", items };
}

// TargetRef builders. Plugin authors use these rather than constructing
// `{ kind: "window-opacity", windowId }` literals -- gives a stable
// import surface if the TargetRef shape ever grows new variants.
export const target = {
  windowOpacity(windowId: number): TargetRef {
    return { kind: "window-opacity", windowId };
  },
  windowTransform(windowId: number): TargetRef {
    return { kind: "window-transform", windowId };
  },
  windowOutputMargin(windowId: number): TargetRef {
    return { kind: "window-output-margin", windowId };
  },
} as const;

// Cubic-bezier easing builder for the cubic-bezier() form. The four
// CSS presets ("linear", "ease", "ease-in", "ease-out", "ease-in-out")
// are accepted as EasingSpec strings without going through this helper.
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): CubicBezier {
  return { kind: "cubic-bezier", x1, y1, x2, y2 };
}

// Convenience: named easings (the CSS presets). Imported as
// `import { easings } from "@overdraw/sdk-anim"` then used as
// `tween(target, { ..., easing: easings.easeOut })`.
export const easings: Record<string, EasingPreset> = {
  linear: "linear",
  ease: "ease",
  easeIn: "ease-in",
  easeOut: "ease-out",
  easeInOut: "ease-in-out",
};

// Re-export the canonical types so consumers depend on
// @overdraw/sdk-anim alone (rather than also @overdraw/animation-types)
// when they only need the builders + types.
export type {
  AnimationSpec, CubicBezier, EasingPreset, EasingSpec, MarginValue,
  ParallelSpec, SequenceSpec, SpringSpec, TargetRef, TransformValue,
  TweenSpec,
};
