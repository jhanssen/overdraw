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
  // Fraction of output width given to the master column when 2+ windows exist.
  masterFraction: number;
  // Gap (output px) between tiles and around the outer edge.
  gap: number;
}

export const DEFAULT_LAYOUT: LayoutParams = {
  masterFraction: 0.5,
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

// Equal full-height columns, left to right in member order, separated by
// gaps. The shape an elastic strip wants: the island source sizes the
// region to N columns and this divides it evenly.
export function columnsLayout(
  windowCount: number,
  output: { width: number; height: number },
  gap = 0,
): Rect[] {
  if (windowCount <= 0) return [];

  const g = Math.max(0, gap | 0);
  const ax = g;
  const ay = g;
  const aw = Math.max(0, Math.max(0, output.width) - 2 * g);
  const ah = Math.max(0, Math.max(0, output.height) - 2 * g);

  const totalGap = (windowCount - 1) * g;
  const colW = Math.floor((aw - totalGap) / windowCount);
  const rects: Rect[] = [];
  for (let i = 0; i < windowCount; i++) {
    const x = ax + i * (colW + g);
    // Last column absorbs the rounding remainder so the row fills exactly.
    const w = i === windowCount - 1 ? ax + aw - x : colW;
    rects.push(clampRect({ x, y: ay, width: w, height: ah }));
  }
  return rects;
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
