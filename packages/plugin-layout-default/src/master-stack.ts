// Master-stack layout algorithm. Pure function: deterministic from window
// count, output dimensions, and params.
//
// Master-stack: the first window in order is the master, filling a left
// column of width output.width * masterFraction. Every other window shares
// the right column as equal-height horizontal slices. A single window fills
// the output.
//
// This computes OUTER rects (the tile a window owns; decoration insets are
// applied by core's WM, not here). The layout ignores client content size.

import type { Rect } from "@overdraw/layout-types";

export interface LayoutParams {
  // Which algorithm tiles an island when its hint doesn't override it.
  mode: "master-stack" | "columns";
  // Fraction of output width given to the master column when 2+ windows exist.
  masterFraction: number;
  // Default column-width fraction of the workarea width (columns mode).
  column: number;
  // Gap (output px) between tiles and around the outer edge.
  gap: number;
}

export const DEFAULT_LAYOUT: LayoutParams = {
  mode: "master-stack",
  masterFraction: 0.5,
  column: 0.5,
  gap: 0,
};

// Clamp a rect to non-negative size + integer coords.
function clampRect(r: Rect): Rect {
  return {
    x: r.x | 0,
    y: r.y | 0,
    width: Math.max(0, r.width | 0),
    height: Math.max(0, r.height | 0),
  };
}

// One full-height column per window, left to right in member order,
// separated by gaps. `weights` carries each window's relative column
// width; columns are scaled proportionally so they exactly fill the
// region. A region pre-sized by columnsMeasure from the same weights
// scales by ~1 (columns land at their natural widths); a fixed
// workarea-sized region compresses or stretches them proportionally.
export function columnsLayout(
  weights: ReadonlyArray<number>,
  region: { width: number; height: number },
  gap = 0,
): Rect[] {
  const n = weights.length;
  if (n <= 0) return [];

  const g = Math.max(0, gap | 0);
  const ax = g;
  const ay = g;
  const aw = Math.max(0, Math.max(0, region.width) - 2 * g);
  const ah = Math.max(0, Math.max(0, region.height) - 2 * g);

  const avail = Math.max(0, aw - (n - 1) * g);
  let total = 0;
  for (const w of weights) total += Math.max(1e-6, w);
  const scale = total > 0 ? avail / total : 0;
  const rects: Rect[] = [];
  let x = ax;
  for (let i = 0; i < n; i++) {
    // Last column absorbs the rounding remainder so the row fills exactly.
    const w = i === n - 1
      ? ax + aw - x
      : Math.floor(Math.max(1e-6, weights[i]) * scale);
    rects.push(clampRect({ x, y: ay, width: w, height: ah }));
    x += w + g;
  }
  return rects;
}

// The columns' natural region size: the sum of the column widths,
// floored at the workarea (islands grow; they never shrink below the
// glass). Zero windows measure to the workarea itself.
//
// A column width is its share of the WORKAREA PITCH -- the gaps come out
// of the columns, they are not added around them. This is what makes N
// columns at fraction 1/N tile the glass exactly with nothing offscreen
// (the common case: two 0.5 columns side by side). Adding the gap bands
// here instead would push every such pair (2g + 1g) past the viewport
// edge and force the camera to scroll a strip that visibly ought to fit.
// The cost is that a column is fractionally narrower than
// `column x workarea` once gap > 0 -- the same trade master-stack makes,
// where the gap eats into the tiles rather than the screen.
export function columnsMeasure(
  widthsPx: ReadonlyArray<number>,
  workarea: { width: number; height: number },
): { width: number; height: number } {
  const n = widthsPx.length;
  if (n === 0) return { width: workarea.width, height: workarea.height };
  // Sum first, round once. Rounding each column instead lets the error
  // accumulate: three 1/3 columns of a 3440px glass round to 1147 apiece
  // and measure 3441 -- one pixel of scroll on a strip that fits.
  let natural = 0;
  for (const w of widthsPx) natural += Math.max(0, w);
  return {
    width: Math.max(workarea.width, Math.round(natural)),
    height: workarea.height,
  };
}

// Compute the outer rect for each window in the given count, in master-front
// order (index 0 = master; 1..n-1 fill the stack top-to-bottom).
export function masterStackLayout(
  windowCount: number,
  output: { width: number; height: number },
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

  // Stack: equal-height slices separated by gaps.
  const totalGap = (stackCount - 1) * g;
  const sliceH = Math.floor((ah - totalGap) / stackCount);
  for (let i = 0; i < stackCount; i++) {
    const y = ay + i * (sliceH + g);
    // Last slice absorbs the rounding remainder so the column fills exactly.
    const h = i === stackCount - 1 ? ay + ah - y : sliceH;
    rects.push(clampRect({ x: stackX, y, width: stackW, height: h }));
  }
  return rects;
}
