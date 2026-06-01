// Window layout policy — master-stack (dwm-style), hard-coded for milestone 1.
//
// This is the replaceable policy seam. The durable seam is everything around it:
// the native setSurfaceLayout/setStack calls and the WM invocation points. A
// future plugin-overridable layout or a BSP model replaces this function; the WM
// drives it the same way (compute outer rects for the whole window set, then
// (re)configure changed windows). Nothing else needs to move.
//
// Master-stack: the first window in order is the master, filling a left column of
// width `output.width * masterFraction`. Every other window shares the right
// column as equal-height horizontal slices. A single window fills the output.
//
// This computes OUTER rects (the tile a window owns, decoration included). The WM
// shrinks each by its decoration insets to get the content rect the client is
// configured to. Geometry is output-owned: the layout ignores client content size.

import type { Rect, Output } from "./index.js";

// Layout parameters. Hard-coded defaults for M1; these map cleanly to config
// fields later (e.g. config.tiling.masterFraction).
export interface LayoutParams {
  // Fraction of output width given to the master column when 2+ windows exist.
  masterFraction: number;
  // Gap (output px) between tiles and around the outer edge.
  gap: number;
}

export const DEFAULT_LAYOUT: LayoutParams = {
  masterFraction: 0.5,
  gap: 0,
};

// Clamp a rect to non-negative size (degenerate outputs / large gaps).
function clampRect(r: Rect): Rect {
  return {
    x: r.x | 0,
    y: r.y | 0,
    width: Math.max(0, r.width | 0),
    height: Math.max(0, r.height | 0),
  };
}

// Compute the outer rect for each window, in the given order. windowCount is the
// number of windows; returns one rect per window (index 0 = master). Pure: a
// deterministic function of count + output + params.
//
// Order convention: index 0 is the master; 1..n-1 fill the stack top-to-bottom.
// The WM keeps the master at the front of its layout order (a newly mapped window
// becomes master by being inserted at the front).
export function masterStackLayout(
  windowCount: number,
  output: Output,
  params: LayoutParams = DEFAULT_LAYOUT,
): Rect[] {
  if (windowCount <= 0) return [];

  const g = Math.max(0, params.gap | 0);
  const ow = Math.max(0, output.width);
  const oh = Math.max(0, output.height);

  // Usable area inside the outer gap.
  const ax = g;
  const ay = g;
  const aw = Math.max(0, ow - 2 * g);
  const ah = Math.max(0, oh - 2 * g);

  // Single window fills the usable area.
  if (windowCount === 1) {
    return [clampRect({ x: ax, y: ay, width: aw, height: ah })];
  }

  const frac = Math.min(0.95, Math.max(0.05, params.masterFraction));
  const stackCount = windowCount - 1;

  // Master column on the left; stack column on the right, separated by one gap.
  const masterW = Math.max(0, Math.round((aw - g) * frac));
  const stackW = Math.max(0, aw - g - masterW);
  const stackX = ax + masterW + g;

  const rects: Rect[] = [];
  // Master fills the full usable height of the left column.
  rects.push(clampRect({ x: ax, y: ay, width: masterW, height: ah }));

  // Stack: equal-height slices separated by gaps. Total inter-slice gaps =
  // (stackCount - 1) * g. Distribute the remainder to the last slice so the
  // column is exactly filled (no rounding crack at the bottom).
  const totalGap = (stackCount - 1) * g;
  const sliceH = Math.floor((ah - totalGap) / stackCount);
  for (let i = 0; i < stackCount; i++) {
    const y = ay + i * (sliceH + g);
    // Last slice absorbs the rounding remainder.
    const h = i === stackCount - 1 ? ay + ah - y : sliceH;
    rects.push(clampRect({ x: stackX, y, width: stackW, height: h }));
  }
  return rects;
}
