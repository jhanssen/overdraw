// xdg_positioner constraint solver (pure). Computes a popup's rect from the
// positioner state, the parent's position, and the output bounds, applying the
// constraint adjustments (flip / slide / resize) to keep the popup on-screen.
//
// Coordinates: the positioner's anchor_rect and the result are in the PARENT
// surface's window-geometry space (origin = parent's top-left). `parentX/parentY`
// is the parent's top-left in output space; the output is [0,0,outW,outH]. The
// returned rect is in parent-relative coords (the caller adds parentX/Y to place
// it in output space) so xdg_popup.configure reports parent-relative position.

export interface Positioner {
  width: number;
  height: number;
  anchorRect: { x: number; y: number; width: number; height: number };
  anchor: number;       // xdg_positioner.anchor enum
  gravity: number;      // xdg_positioner.gravity enum
  constraintAdjustment: number; // bitmask
  offsetX: number;
  offsetY: number;
}

// anchor / gravity enum values (xdg_positioner).
const A = { none: 0, top: 1, bottom: 2, left: 3, right: 4, top_left: 5, bottom_left: 6, top_right: 7, bottom_right: 8 };
const CA = { none: 0, slide_x: 1, slide_y: 2, flip_x: 4, flip_y: 8, resize_x: 16, resize_y: 32 };

export interface Rect { x: number; y: number; width: number; height: number; }

// Horizontal/vertical component of an anchor/gravity enum: -1 (left/top),
// 0 (center), +1 (right/bottom).
function hComp(e: number): number {
  if (e === A.left || e === A.top_left || e === A.bottom_left) return -1;
  if (e === A.right || e === A.top_right || e === A.bottom_right) return 1;
  return 0;
}
function vComp(e: number): number {
  if (e === A.top || e === A.top_left || e === A.top_right) return -1;
  if (e === A.bottom || e === A.bottom_left || e === A.bottom_right) return 1;
  return 0;
}

// The anchor point on the anchor rect for a given anchor enum (parent-relative).
function anchorPoint(ar: Positioner["anchorRect"], anchor: number): { x: number; y: number } {
  const hx = hComp(anchor), vy = vComp(anchor);
  const x = ar.x + (hx < 0 ? 0 : hx > 0 ? ar.width : ar.width / 2);
  const y = ar.y + (vy < 0 ? 0 : vy > 0 ? ar.height : ar.height / 2);
  return { x, y };
}

// Top-left of a `size` popup placed so the gravity direction extends away from
// the anchor point. gravity right/bottom => popup extends right/down => its
// top-left is at the anchor; gravity left/top => extends left/up => top-left is
// shifted by -size; center => centered on the anchor.
function placeForGravity(ax: number, ay: number, w: number, h: number, gravity: number): { x: number; y: number } {
  const gx = hComp(gravity), gy = vComp(gravity);
  const x = gx < 0 ? ax - w : gx > 0 ? ax : ax - w / 2;
  const y = gy < 0 ? ay - h : gy > 0 ? ay : ay - h / 2;
  return { x, y };
}

// Mirror an anchor/gravity enum on the horizontal axis (for flip_x): left<->right.
function flipH(e: number): number {
  switch (e) {
    case A.left: return A.right; case A.right: return A.left;
    case A.top_left: return A.top_right; case A.top_right: return A.top_left;
    case A.bottom_left: return A.bottom_right; case A.bottom_right: return A.bottom_left;
    default: return e;
  }
}
function flipV(e: number): number {
  switch (e) {
    case A.top: return A.bottom; case A.bottom: return A.top;
    case A.top_left: return A.bottom_left; case A.bottom_left: return A.top_left;
    case A.top_right: return A.bottom_right; case A.bottom_right: return A.top_right;
    default: return e;
  }
}

// Compute the unconstrained popup top-left (parent-relative) for given anchor +
// gravity.
function computeRaw(p: Positioner, anchor: number, gravity: number): { x: number; y: number } {
  const ap = anchorPoint(p.anchorRect, anchor);
  const pl = placeForGravity(ap.x, ap.y, p.width, p.height, gravity);
  return { x: pl.x + p.offsetX, y: pl.y + p.offsetY };
}

// Solve the popup rect (parent-relative). `parentX/Y` = parent top-left in output
// space; output = [0,0,outW,outH]. Applies flip (preferred), then slide, then
// resize per the constraint_adjustment mask, independently per axis.
export function solvePopupPosition(
  p: Positioner, parentX: number, parentY: number, outW: number, outH: number,
): Rect {
  let w = p.width, h = p.height;
  let anchor = p.anchor, gravity = p.gravity;
  let { x, y } = computeRaw(p, anchor, gravity);

  // Output bounds in parent-relative coords.
  const minX = -parentX, maxX = outW - parentX;
  const minY = -parentY, maxY = outH - parentY;

  // --- X axis ---
  if (x < minX || x + w > maxX) {
    if (p.constraintAdjustment & CA.flip_x) {
      const fa = flipH(anchor), fg = flipH(gravity);
      const flipped = computeRaw({ ...p, anchor: fa, gravity: fg }, fa, fg).x;
      if (flipped >= minX && flipped + w <= maxX) { x = flipped; anchor = fa; gravity = fg; }
    }
    if (x < minX || x + w > maxX) {
      if (p.constraintAdjustment & CA.slide_x) {
        if (x + w > maxX) x = maxX - w;
        if (x < minX) x = minX;
      }
      if ((p.constraintAdjustment & CA.resize_x) && x + w > maxX) {
        w = Math.max(1, maxX - x);
      }
    }
  }

  // --- Y axis ---
  if (y < minY || y + h > maxY) {
    if (p.constraintAdjustment & CA.flip_y) {
      const fa = flipV(anchor), fg = flipV(gravity);
      const flipped = computeRaw({ ...p, anchor: fa, gravity: fg }, fa, fg).y;
      if (flipped >= minY && flipped + h <= maxY) { y = flipped; }
    }
    if (y < minY || y + h > maxY) {
      if (p.constraintAdjustment & CA.slide_y) {
        if (y + h > maxY) y = maxY - h;
        if (y < minY) y = minY;
      }
      if ((p.constraintAdjustment & CA.resize_y) && y + h > maxY) {
        h = Math.max(1, maxY - y);
      }
    }
  }

  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}
