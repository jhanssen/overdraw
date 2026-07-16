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

// A column's width bounds in pixels. Absent fields mean unbounded; a min
// above a max wins (a client that sends both nonsensically still gets a
// usable window).
export interface ColumnBounds {
  min?: number;
  max?: number;
}

// Divide `avail` pixels among the columns in proportion to their weights,
// honoring each column's pixel bounds EXACTLY. Bounded columns are pinned
// at their bound and the remainder is re-divided among the rest, until
// nothing else violates (water-filling) -- a plain proportional scale
// cannot do this, since scaling a pinned column drags it back off its
// bound.
//
// When the floors alone exceed `avail` the region simply cannot hold them
// (a fixed island whose members demand more than the glass). The columns
// are then squeezed proportionally: overflowing instead would push the
// island over its neighbor, which the world arrangement forbids outright.
function allocateColumns(
  weights: ReadonlyArray<number>,
  bounds: ReadonlyArray<ColumnBounds | undefined>,
  avail: number,
): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  const pinned = new Array<boolean>(n).fill(false);
  const w = (i: number): number => Math.max(1e-6, weights[i]);
  const lo = (i: number): number => Math.max(0, bounds[i]?.min ?? 0);
  const hi = (i: number): number => {
    const max = bounds[i]?.max ?? Number.POSITIVE_INFINITY;
    return Math.max(lo(i), max);   // min wins over a smaller max
  };

  let remaining = avail;
  // Each pass pins at least one column, so n passes settle it.
  for (let pass = 0; pass <= n; pass++) {
    let freeWeight = 0;
    for (let i = 0; i < n; i++) if (!pinned[i]) freeWeight += w(i);
    if (freeWeight <= 0) break;
    const scale = remaining / freeWeight;
    let pinnedAny = false;
    for (let i = 0; i < n; i++) {
      if (pinned[i]) continue;
      const cand = w(i) * scale;
      const bound = cand < lo(i) ? lo(i) : cand > hi(i) ? hi(i) : null;
      if (bound === null) continue;
      out[i] = bound;
      pinned[i] = true;
      remaining -= bound;
      pinnedAny = true;
    }
    if (pinnedAny) continue;
    for (let i = 0; i < n; i++) if (!pinned[i]) out[i] = w(i) * scale;
    break;
  }

  let total = 0;
  for (const v of out) total += v;
  if (total > avail && total > 0) {
    const s = avail / total;
    for (let i = 0; i < n; i++) out[i] *= s;
  }
  return out;
}

// One full-height column per window, left to right in member order,
// separated by gaps. `weights` carries each window's relative column
// width and `bounds` its pixel size limits; columns divide the region in
// proportion to their weights, clamped to their bounds. A region
// pre-sized by columnsMeasure from the same inputs lands every column on
// its target; a fixed workarea-sized region compresses or stretches them
// instead.
export function columnsLayout(
  weights: ReadonlyArray<number>,
  region: { width: number; height: number },
  gap = 0,
  bounds: ReadonlyArray<ColumnBounds | undefined> = [],
): Rect[] {
  const n = weights.length;
  if (n <= 0) return [];

  const g = Math.max(0, gap | 0);
  const ax = g;
  const ay = g;
  const aw = Math.max(0, Math.max(0, region.width) - 2 * g);
  const ah = Math.max(0, Math.max(0, region.height) - 2 * g);

  const avail = Math.max(0, aw - (n - 1) * g);
  const alloc = allocateColumns(weights, bounds, avail);
  const rects: Rect[] = [];
  let x = ax;
  for (let i = 0; i < n; i++) {
    // Flooring only ever hands the remainder to the last column, so a
    // pinned bound (always a whole number of pixels) survives it intact.
    const w = i === n - 1
      ? ax + aw - x
      : Math.floor(alloc[i]);
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
  gap = 0,
  bounds: ReadonlyArray<ColumnBounds | undefined> = [],
): { width: number; height: number } {
  const n = widthsPx.length;
  if (n === 0) return { width: workarea.width, height: workarea.height };
  const g = Math.max(0, gap | 0);
  // A bound is a CONTENT size -- the pixels the window itself needs --
  // while a fraction is a pitch that already includes its gap share. So a
  // bounded column must reserve its gap allotment on top, or the strip
  // lands short and the water-fill shaves the very floor it measured for:
  // two min-width columns would each come out a gap narrower than their
  // minimum.
  const gapShare = (n + 1) * g / n;
  // Sum first, round once. Rounding each column instead lets the error
  // accumulate: three 1/3 columns of a 3440px glass round to 1147 apiece
  // and measure 3441 -- one pixel of scroll on a strip that fits.
  let natural = 0;
  for (let i = 0; i < n; i++) {
    const pitch = Math.max(0, widthsPx[i]);
    const b = bounds[i];
    const lo = b?.min !== undefined ? b.min + gapShare : null;
    const hi = b?.max !== undefined ? b.max + gapShare : null;
    let v = pitch;
    if (hi !== null && v > hi) v = hi;
    if (lo !== null && v < lo) v = lo;   // a min outranks a smaller max
    natural += Math.max(0, v);
  }
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
