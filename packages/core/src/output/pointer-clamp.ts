// Pointer clamp against a multi-output layout.
//
// Outputs live in a global logical coordinate space; each is a rectangle
// {x, y, w, h}. Their union may be non-rectangular (overhangs between
// mismatched-size monitors, gaps between stacked monitors). The cursor
// must always sit inside the union.
//
// Algorithm: project the requested target (oldX+dx, oldY+dy) to the
// closest in-bounds point in the union (minimum squared distance across
// each rect's projection). For each rect the projection clamps each axis
// to its half-open range [r.x, r.x + r.w) and [r.y, r.y + r.h); the
// result lies strictly inside by at least EDGE_EPSILON so subsequent
// outward motion from the wall produces no event-to-event jitter (the
// cursor sits just inside the boundary and stays there).
//
// The single algorithm covers every case correctly: inside a rect ->
// unchanged; outside but axis-aligned to a rect (wall press) -> snap to
// the nearest edge; diagonal into a gap between two rects -> snap to
// whichever rect's corner/edge is closer; cursor outside all rects with
// no axis hit -> snap to the closest rect's corner.

export interface OutputRect {
  // Top-left, inclusive. The cursor at (x, y) is inside the rect when
  // x in [rx, rx+rw) AND y in [ry, ry+rh).
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

// Half-open range epsilon: how far inside the right/bottom edge the
// clamp keeps the cursor. 1/256 is small enough to avoid a visible dead
// zone with high-resolution mice and large enough to survive the round-
// trip through wl_fixed (24.8 fixed-point, 1/256 of a unit) that
// downstream consumers may apply.
const EDGE_EPSILON = 1 / 256;

export function insideAny(outs: ReadonlyArray<OutputRect>, x: number, y: number): boolean {
  for (const r of outs) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return true;
  }
  return false;
}

// Closest point inside a single rect. Each axis clamps to the half-open
// range [r.x, r.x + r.w) and [r.y, r.y + r.h), with EDGE_EPSILON keeping
// the result strictly inside the right/bottom edges.
function closestPointInRect(r: OutputRect, x: number, y: number): Point {
  const rxMax = r.x + r.w - EDGE_EPSILON;
  const ryMax = r.y + r.h - EDGE_EPSILON;
  const cx = x < r.x ? r.x : x > rxMax ? rxMax : x;
  const cy = y < r.y ? r.y : y > ryMax ? ryMax : y;
  return { x: cx, y: cy };
}

// Closest point inside the union of `outs`: the projection of (x, y)
// onto each rect, taking the minimum-squared-distance pick. The cursor
// invariant (always inside some rect) is preserved -- a point already
// inside any rect projects to itself there (zero distance).
function closestPointInUnion(
  outs: ReadonlyArray<OutputRect>, x: number, y: number,
): Point {
  let bestX = x, bestY = y;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const r of outs) {
    const p = closestPointInRect(r, x, y);
    const dx = x - p.x, dy = y - p.y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; bestX = p.x; bestY = p.y; }
  }
  return { x: bestX, y: bestY };
}

// Apply a relative motion (dx, dy) from (oldX, oldY) and project the
// requested target to the closest in-bounds point in `outs`. An empty
// layout leaves the cursor at (oldX, oldY) (no valid landing exists; the
// caller is expected to handle empty layouts via reseatCursor).
export function clampPointerMotion(
  outs: ReadonlyArray<OutputRect>,
  oldX: number, oldY: number,
  dx: number, dy: number,
): Point {
  if (outs.length === 0) return { x: oldX, y: oldY };
  return closestPointInUnion(outs, oldX + dx, oldY + dy);
}

// Pick an in-bounds position when the cursor was stranded by a layout
// change (its prior position is no longer inside any output). Returns
// the center of the first output. Empty `outs` returns (0, 0) -- the
// caller should avoid calling this in that state (no valid landing
// exists).
export function reseatCursor(outs: ReadonlyArray<OutputRect>): Point {
  if (outs.length === 0) return { x: 0, y: 0 };
  const r = outs[0];
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}
