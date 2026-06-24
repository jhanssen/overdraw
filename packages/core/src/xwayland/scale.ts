// Effective Xwayland scale: one integer for the whole session, in [1,3].
// See docs/xwayland-design.md "HiDPI".
//
// The X client sees an oversized world by this factor; the compositor lies
// about pixel sizes and coordinates uniformly. Computed once at Xwayland
// start and frozen for the session.

import type { CompositorState, OutputRecord } from "../protocols/ctx.js";

// Clamp + round to the [1,3] integer band. Anything outside the band is
// capped (we don't refuse it -- the higher levels validate the config
// knob; this is the lower-level apply).
function clampInt(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 3) return 3;
  return Math.round(n);
}

// Walk the current outputs and return the highest scale seen, or 1 if
// state has no outputs yet.
function highestOutputScale(state: CompositorState): number {
  const outs = state.outputs;
  if (!outs || outs.size === 0) return 1;
  let max = 1;
  for (const o of outs.values() as IterableIterator<OutputRecord>) {
    if (typeof o.scale === "number" && o.scale > max) max = o.scale;
  }
  return max;
}

// Resolve the integer X scale to use. `configScale` is the user knob:
// 0 = auto (ceil(highest output scale)), 1..3 = explicit. Always returns
// an int in [1,3].
export function resolveXwaylandScale(state: CompositorState, configScale: number): number {
  if (configScale >= 1) return clampInt(configScale);
  return clampInt(Math.ceil(highestOutputScale(state)));
}

// Per-call convenience -- reads the frozen scale off state. Returns 1 when
// xwaylandScale is unset (no Xwayland session, or a test harness that didn't
// set it), so callers can multiply/divide unconditionally.
export function xwaylandScaleOf(state: CompositorState): number {
  const n = state.xwaylandScale;
  return typeof n === "number" && n >= 1 ? n : 1;
}
