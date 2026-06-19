// Pointer clamp against a multi-output layout.
//
// Outputs live in a global logical coordinate space; each is a rectangle
// {x, y, w, h}. Their union may be non-rectangular (overhangs between
// mismatched-size monitors, gaps between stacked monitors). The cursor must
// always sit inside the union; a relative motion that would land in a gap
// slides along an axis instead of jumping past the edge.
//
// Algorithm (target → X-slide → Y-slide → stay):
//   1. If the requested (oldX+dx, oldY+dy) is inside any output, accept it.
//   2. Else try X-only motion: keep oldY (or snap it to the nearest output
//      that covers the new X), giving the visual effect of sliding along
//      the horizontal edge that blocked the diagonal.
//   3. Else try Y-only motion symmetrically.
//   4. Else (both axes rejected) stay at (oldX, oldY).
//
// The caller guarantees (oldX, oldY) is inside some output (the cursor
// invariant). On a layout change that strands the cursor (e.g. an output
// removed), reseatCursor() returns a fresh in-bounds position; the libinput
// backend calls it from setOutputLayout when its current position is now
// outside.

export interface OutputRect {
  // Top-left, inclusive. The cursor at (x, y) is considered inside the
  // rect when x in [rx, rx+rw) AND y in [ry, ry+rh).
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export function insideAny(outs: ReadonlyArray<OutputRect>, x: number, y: number): boolean {
  for (const r of outs) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

// Apply a relative motion (dx, dy) from (oldX, oldY), clamping to the union
// of `outs` with edge-sliding for gaps. `outs` may be empty -- in that case
// the result is (oldX, oldY) (no valid landing exists, so the cursor cannot
// move; the caller is expected to handle empty layouts via reseatCursor).
export function clampPointerMotion(
  outs: ReadonlyArray<OutputRect>,
  oldX: number, oldY: number,
  dx: number, dy: number,
): Point {
  if (outs.length === 0) return { x: oldX, y: oldY };

  const tx = oldX + dx, ty = oldY + dy;
  if (insideAny(outs, tx, ty)) return { x: tx, y: ty };

  // X-slide: keep the target X, find an output containing X in its x-range
  // whose y-range is closest to the TARGET y (so the cursor slides as far
  // along the wall as the user asked for in Y). Snap y into that output.
  const sx = slideAlongX(outs, tx, ty);
  if (sx !== null) return sx;

  // Y-slide: symmetric, keep target Y, refX = target X.
  const sy = slideAlongY(outs, tx, ty);
  if (sy !== null) return sy;

  return { x: oldX, y: oldY };
}

// If any output covers x in its x-range, pick the one whose y-range is
// closest to refY (preferring strictly-containing outputs, then nearest
// edge), and snap y into that output's bounds. Returns null when no
// output covers this x.
function slideAlongX(
  outs: ReadonlyArray<OutputRect>, x: number, refY: number,
): Point | null {
  let bestRect: OutputRect | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const r of outs) {
    if (!(x >= r.x && x < r.x + r.w)) continue;
    // Distance from refY to this rect's y-range; 0 if refY is inside.
    const d = refY < r.y ? r.y - refY
            : refY >= r.y + r.h ? refY - (r.y + r.h - 1)
            : 0;
    if (d < bestDist) { bestDist = d; bestRect = r; }
  }
  if (!bestRect) return null;
  const y = clampToRange(refY, bestRect.y, bestRect.y + bestRect.h - 1);
  return { x, y };
}

// Symmetric of slideAlongX.
function slideAlongY(
  outs: ReadonlyArray<OutputRect>, refX: number, y: number,
): Point | null {
  let bestRect: OutputRect | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const r of outs) {
    if (!(y >= r.y && y < r.y + r.h)) continue;
    const d = refX < r.x ? r.x - refX
            : refX >= r.x + r.w ? refX - (r.x + r.w - 1)
            : 0;
    if (d < bestDist) { bestDist = d; bestRect = r; }
  }
  if (!bestRect) return null;
  const x = clampToRange(refX, bestRect.x, bestRect.x + bestRect.w - 1);
  return { x, y };
}

function clampToRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Pick an in-bounds position when the cursor was stranded by a layout
// change (its prior position is no longer inside any output). Picks the
// center of the first output. Empty `outs` returns (0, 0) -- the caller
// should avoid calling this in that state (no valid landing exists).
export function reseatCursor(outs: ReadonlyArray<OutputRect>): Point {
  if (outs.length === 0) return { x: 0, y: 0 };
  const r = outs[0];
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
