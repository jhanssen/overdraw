// Effective Xwayland scale: one number for the whole session, in [1,3],
// fractional allowed. See docs/xwayland-design.md "HiDPI".
//
// The X client sees an oversized world by this factor; the compositor lies
// about pixel sizes and coordinates uniformly. Computed once at Xwayland
// start and frozen for the session. Auto tracks the highest output scale
// EXACTLY (a 1.5-scaled output gives X scale 1.5), so the X desktop's
// pixel size equals the output's device pixel size -- X clients render at
// native density and a desktop-sized fullscreen buffer equals the mode
// (direct-scanout-able 1:1). Every X-wire integer boundary rounds
// (tellXRect, xdg_output); internal logical<->X conversions stay float.

import type { CompositorState, OutputRecord } from "../protocols/ctx.js";

// Clamp to the [1,3] band. Anything outside the band is capped (we don't
// refuse it -- the higher levels validate the config knob; this is the
// lower-level apply). Fractional values pass through.
function clamp(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 3) return 3;
  return n;
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

// Resolve the X scale to use. `configScale` is the user knob:
// 0 = auto (the highest output scale, exactly), >= 1 = explicit
// (fractional allowed). Always returns a number in [1,3].
export function resolveXwaylandScale(state: CompositorState, configScale: number): number {
  if (configScale >= 1) return clamp(configScale);
  return clamp(highestOutputScale(state));
}

// Per-call convenience -- reads the frozen scale off state. Returns 1 when
// xwaylandScale is unset (no Xwayland session, or a test harness that didn't
// set it), so callers can multiply/divide unconditionally.
export function xwaylandScaleOf(state: CompositorState): number {
  const n = state.xwaylandScale;
  return typeof n === "number" && n >= 1 ? n : 1;
}

type Size = { width: number; height: number };

// WM_NORMAL_HINTS min/max arrive in X device pixels; the WM thinks in
// logical. Convert conservatively -- ceil the min, floor the max -- so the
// constraint the WM enforces never violates the client's own (a rounded-
// down min could configure a size the client refuses to shrink to). A
// range narrower than one logical pixel (min == max, the fixed-size-dialog
// idiom) can invert under ceil/floor; keep it ordered by lifting max to
// min (over-max by under a logical pixel).
export function sizeHintsToLogical(
  min: Size | null, max: Size | null, n: number,
): { minSize: Size | null; maxSize: Size | null } {
  const minSize = min === null ? null : {
    width: Math.ceil(min.width / n),
    height: Math.ceil(min.height / n),
  };
  const maxSize = max === null ? null : {
    width: Math.floor(max.width / n),
    height: Math.floor(max.height / n),
  };
  if (minSize !== null && maxSize !== null) {
    maxSize.width = Math.max(maxSize.width, minSize.width);
    maxSize.height = Math.max(maxSize.height, minSize.height);
  }
  return { minSize, maxSize };
}
