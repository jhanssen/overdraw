// Pure geometry for zwlr_layer_surface_v1: compute the output-space rect
// from anchor + size + margin against the appropriate output rect (raw or
// effective, per exclusive-zone mode), and resolve the exclusive edge a
// positive zone applies to.
//
// No compositor / state dependencies; pure number-in number-out so the math
// is unit-testable in isolation (mirrors popup-position.ts / overlay-
// position.ts in shape and intent).
//
// Anchor encoding matches the protocol bitfield: top=1, bottom=2, left=4,
// right=8. Helpers below decode it; callers pass the raw uint.

export const ANCHOR_TOP = 1;
export const ANCHOR_BOTTOM = 2;
export const ANCHOR_LEFT = 4;
export const ANCHOR_RIGHT = 8;
export const ANCHOR_ALL = ANCHOR_TOP | ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT;

// Bits we accept on set_anchor. Anything outside is an invalid_anchor error.
export function isValidAnchor(anchor: number): boolean {
  return (anchor & ~ANCHOR_ALL) === 0;
}

export type ExclusiveEdge = "top" | "right" | "bottom" | "left";

export interface Rect { x: number; y: number; width: number; height: number; }

export interface Margin { top: number; right: number; bottom: number; left: number; }

export interface PlaceArgs {
  // The output rect in compositor coordinates. Used when zone is -1 (extend
  // over reservations) or > 0 (the surface itself reserves; it's drawn
  // against the raw output).
  outputRect: Rect;
  // The output rect minus already-registered reservations from OTHER layer
  // surfaces. Used when zone == 0 (the "be moved out of others' zones" mode).
  effectiveRect: Rect;
  // Client-requested width / height. 0 on an axis means "fill the axis";
  // valid only when the surface is anchored to opposite edges on that axis.
  width: number;
  height: number;
  anchor: number;
  margin: Margin;
  // -1, 0, or >0; see the protocol's set_exclusive_zone description.
  exclusiveZone: number;
}

export interface PlaceResult {
  rect: Rect;
  // When the inputs violate the spec, this names the error the protocol
  // requires us to post. The returned rect is still a sane clamp so that
  // a buggy client doesn't render at NaN; the caller posts the error and
  // proceeds with the clamped rect.
  error?: "invalid_size";
}

// Compute the output-space rect for a layer surface.
//
// Algorithm:
//   1. Pick the base rect: outputRect when zone != 0; effectiveRect when zone == 0.
//   2. Resolve width / height. 0 on an axis means "span the base rect on that
//      axis, minus margins on the anchored edges." A 0 axis without
//      opposite-edge anchors is invalid_size.
//   3. Position the box according to the anchor bits:
//      - anchored on an axis (single edge or both): push to that edge,
//        inset by the margin on that edge.
//      - unanchored on an axis: center.
//      - both edges on an axis (size already chose to span): origin = base
//        + left/top margin.
//   4. Clamp the origin so the box stays inside the base rect even if margins
//      / size pushed it off.
export function placeLayerSurface(args: PlaceArgs): PlaceResult {
  const base = args.exclusiveZone === 0 ? args.effectiveRect : args.outputRect;

  const anchoredLeft = (args.anchor & ANCHOR_LEFT) !== 0;
  const anchoredRight = (args.anchor & ANCHOR_RIGHT) !== 0;
  const anchoredTop = (args.anchor & ANCHOR_TOP) !== 0;
  const anchoredBottom = (args.anchor & ANCHOR_BOTTOM) !== 0;
  const spansX = anchoredLeft && anchoredRight;
  const spansY = anchoredTop && anchoredBottom;

  let error: "invalid_size" | undefined;

  // Resolve width: 0 means "span the axis"; legal only when anchored both sides.
  let width = args.width;
  if (width === 0) {
    if (!spansX) error = "invalid_size";
    // Clamp to the available span (base width minus left+right margins).
    const ml = anchoredLeft ? args.margin.left : 0;
    const mr = anchoredRight ? args.margin.right : 0;
    width = Math.max(0, base.width - ml - mr);
  } else {
    width = Math.max(0, Math.min(width, base.width));
  }

  let height = args.height;
  if (height === 0) {
    if (!spansY) error = error ?? "invalid_size";
    const mt = anchoredTop ? args.margin.top : 0;
    const mb = anchoredBottom ? args.margin.bottom : 0;
    height = Math.max(0, base.height - mt - mb);
  } else {
    height = Math.max(0, Math.min(height, base.height));
  }

  // X positioning. Margins only apply on edges the surface is anchored to.
  let x: number;
  if (spansX) {
    x = base.x + args.margin.left;
  } else if (anchoredLeft) {
    x = base.x + args.margin.left;
  } else if (anchoredRight) {
    x = base.x + base.width - width - args.margin.right;
  } else {
    x = base.x + Math.round((base.width - width) / 2);
  }

  let y: number;
  if (spansY) {
    y = base.y + args.margin.top;
  } else if (anchoredTop) {
    y = base.y + args.margin.top;
  } else if (anchoredBottom) {
    y = base.y + base.height - height - args.margin.bottom;
  } else {
    y = base.y + Math.round((base.height - height) / 2);
  }

  // Keep the box fully inside the base rect.
  x = clamp(x, base.x, base.x + Math.max(0, base.width - width));
  y = clamp(y, base.y, base.y + Math.max(0, base.height - height));

  const result: PlaceResult = { rect: { x, y, width, height } };
  if (error) result.error = error;
  return result;
}

// Resolve the edge a positive exclusive zone applies to. Per the protocol's
// set_exclusive_zone description, a positive value is only meaningful when
// the surface is anchored to:
//   - one edge, OR
//   - one edge + both perpendiculars (e.g. top + left + right).
// Combinations producing "treated as zero":
//   - 0 edges (no anchor),
//   - 2 perpendicular edges (a corner) -- v4 and earlier.
//   - 2 parallel edges (e.g. top + bottom),
//   - all 4 edges.
//
// v5 set_exclusive_edge extends the corner case: when 2 perpendicular edges
// are anchored AND `explicitEdge` names one of them, use that edge.
//
// Returns the edge to register; null when the zone should be ignored;
// "invalid" when the explicit edge violates the spec (not in the anchor set).
export type EdgeResolution =
  | { edge: ExclusiveEdge }
  | { edge: null }
  | { edge: null; error: "invalid_exclusive_edge" };

export function resolveExclusiveEdge(anchor: number, explicitEdge: number): EdgeResolution {
  const anchoredLeft = (anchor & ANCHOR_LEFT) !== 0;
  const anchoredRight = (anchor & ANCHOR_RIGHT) !== 0;
  const anchoredTop = (anchor & ANCHOR_TOP) !== 0;
  const anchoredBottom = (anchor & ANCHOR_BOTTOM) !== 0;

  // Explicit edge (v5): must be a single anchor bit AND must be in the
  // anchored set, else invalid_exclusive_edge.
  if (explicitEdge !== 0) {
    if (!isSingleEdgeBit(explicitEdge)) {
      return { edge: null, error: "invalid_exclusive_edge" };
    }
    if ((anchor & explicitEdge) === 0) {
      return { edge: null, error: "invalid_exclusive_edge" };
    }
    return { edge: edgeOfBit(explicitEdge) };
  }

  // Deduction from anchor combination.
  const bits = popcount(anchor & ANCHOR_ALL);

  if (bits === 1) {
    if (anchoredTop) return { edge: "top" };
    if (anchoredBottom) return { edge: "bottom" };
    if (anchoredLeft) return { edge: "left" };
    if (anchoredRight) return { edge: "right" };
  }

  if (bits === 3) {
    // The singleton edge is the one OPPOSITE the missing edge -- or
    // equivalently, the edge whose perpendiculars are both anchored.
    if (anchoredLeft && anchoredRight && anchoredTop && !anchoredBottom) return { edge: "top" };
    if (anchoredLeft && anchoredRight && !anchoredTop && anchoredBottom) return { edge: "bottom" };
    if (anchoredTop && anchoredBottom && anchoredLeft && !anchoredRight) return { edge: "left" };
    if (anchoredTop && anchoredBottom && !anchoredLeft && anchoredRight) return { edge: "right" };
  }

  // 0, 2, or 4 bits without an explicit edge -> no exclusive effect.
  return { edge: null };
}

// Thickness to reserve on `edge` for a layer surface with the given applied
// `zone` (> 0) and `margin`. Per the spec, "the exclusive zone includes the
// margin" -- meaning the zone is the TOTAL distance reserved from the edge,
// inclusive of any margin on that edge. So a panel with margin top=4 and
// zone=30 reserves 30px (the panel sits 4px inset and is 26px tall in the
// 30px reservation).
//
// Today we return zone directly. A future revision that wants margin to
// EXTEND reservation past the surface's body would change this.
export function computeReservedThickness(zone: number): number {
  return zone > 0 ? Math.floor(zone) : 0;
}

// ---- helpers --------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function popcount(n: number): number {
  let c = 0;
  for (let m = n & 0xf; m; m >>= 1) c += m & 1;
  return c;
}

function isSingleEdgeBit(n: number): boolean {
  return n === ANCHOR_TOP || n === ANCHOR_BOTTOM || n === ANCHOR_LEFT || n === ANCHOR_RIGHT;
}

function edgeOfBit(bit: number): ExclusiveEdge {
  if (bit === ANCHOR_TOP) return "top";
  if (bit === ANCHOR_BOTTOM) return "bottom";
  if (bit === ANCHOR_LEFT) return "left";
  return "right";
}
