// Region math for wl_region: a list of axis-aligned rectangles built by
// add/subtract operations. Used by wl_surface.set_input_region (which
// affects hit-testing) and wl_surface.set_opaque_region (a rendering
// optimization hint, not currently consumed).
//
// Per the wl_compositor spec, a region's coordinates are in surface-local
// pixels. Hit-test by transforming the output-space point into surface-
// local coordinates first, then calling Region.contains.
//
// Representation: a list of disjoint rectangles. add() unions a rect into
// the list (splitting overlapping rects into a disjoint set); subtract()
// removes a rect from each existing entry (potentially splitting each
// into up to 4 sub-rects). Stays simple at the cost of redundancy --
// well-behaved clients call add/subtract a small number of times, so the
// rect count stays in single digits.
//
// Internal invariant: rects in the list are non-empty (width > 0 AND
// height > 0). add/subtract operations preserve this.

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Region {
  // Disjoint rects. Empty list = empty region.
  private rects: RegionRect[] = [];

  // Append a rect, splitting any overlaps so the resulting list stays
  // disjoint. Per spec, add/subtract take signed coords; we clamp to
  // non-negative width/height defensively (a 0-area rect is a no-op).
  add(x: number, y: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    // To keep the list disjoint after the add, subtract the new rect
    // from every existing rect first, then append the new rect.
    this.rects = this.rects.flatMap((r) => subtractRectFromRect(r, { x, y, width, height }));
    this.rects.push({ x, y, width, height });
  }

  subtract(x: number, y: number, width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.rects = this.rects.flatMap((r) => subtractRectFromRect(r, { x, y, width, height }));
  }

  contains(x: number, y: number): boolean {
    for (const r of this.rects) {
      if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height) return true;
    }
    return false;
  }

  // True if the region is empty (no rects). An empty applied input
  // region per spec means "no input anywhere on the surface" -- the
  // entire surface is click-through.
  isEmpty(): boolean { return this.rects.length === 0; }

  // Snapshot of the rect list for copy-semantics at commit time. The
  // returned Region is independent of this one; further mutations to
  // either don't affect the other.
  clone(): Region {
    const r = new Region();
    r.rects = this.rects.map((rr) => ({ ...rr }));
    return r;
  }

  // Diagnostic: rect count + a copy of the list.
  snapshot(): RegionRect[] {
    return this.rects.map((r) => ({ ...r }));
  }
}

// Subtract `sub` from `rect`, returning 0..4 disjoint sub-rectangles that
// together cover (rect - sub). No-overlap case returns [rect] unchanged;
// full-cover case returns []. Algorithm:
//
//   Compute the intersection. If empty, return [rect].
//   Otherwise emit up to 4 strips: above, below, left, right of the
//   intersection (within rect).
function subtractRectFromRect(rect: RegionRect, sub: RegionRect): RegionRect[] {
  const ix0 = Math.max(rect.x, sub.x);
  const iy0 = Math.max(rect.y, sub.y);
  const ix1 = Math.min(rect.x + rect.width, sub.x + sub.width);
  const iy1 = Math.min(rect.y + rect.height, sub.y + sub.height);
  if (ix0 >= ix1 || iy0 >= iy1) {
    // No overlap.
    return [rect];
  }
  const rx0 = rect.x;
  const ry0 = rect.y;
  const rx1 = rect.x + rect.width;
  const ry1 = rect.y + rect.height;
  const out: RegionRect[] = [];
  // Above strip.
  if (ry0 < iy0) out.push({ x: rx0, y: ry0, width: rx1 - rx0, height: iy0 - ry0 });
  // Below strip.
  if (iy1 < ry1) out.push({ x: rx0, y: iy1, width: rx1 - rx0, height: ry1 - iy1 });
  // Left strip (only the band aligned with intersection's y range).
  if (rx0 < ix0) out.push({ x: rx0, y: iy0, width: ix0 - rx0, height: iy1 - iy0 });
  // Right strip.
  if (ix1 < rx1) out.push({ x: ix1, y: iy0, width: rx1 - ix1, height: iy1 - iy0 });
  return out;
}
