// Pure geometry for interactive move/resize grabs. Given the grab state,
// the current pointer position, and the window's size constraints, return
// the new floating rect. No I/O; trivially unit-testable.

import type { PointerGrabMove, PointerGrabResize } from "../protocols/ctx.js";

export interface SizeConstraints {
  minSize: { width: number; height: number } | null;
  maxSize: { width: number; height: number } | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Compute the new outer rect for a move/resize grab given the pointer's
// current (x, y). `constraints` may be null (no clamps) or a partial spec
// (missing min/max defaults to 1 / Infinity respectively). Camera-pan
// grabs never reach here (they move the camera, not a rect; see
// wl_seat's applyGrabMotion).
export function computeGrabRect(
  g: PointerGrabMove | PointerGrabResize,
  x: number,
  y: number,
  constraints: SizeConstraints | null,
): Rect {
  const dx = x - g.anchorX;
  const dy = y - g.anchorY;
  if (g.kind === "move") {
    return {
      x: g.startRect.x + dx,
      y: g.startRect.y + dy,
      width: g.startRect.width,
      height: g.startRect.height,
    };
  }
  // Resize.
  let nx = g.startRect.x;
  let ny = g.startRect.y;
  let nw = g.startRect.width;
  let nh = g.startRect.height;
  const edges = g.edges;
  const left = edges === "left" || edges === "top-left" || edges === "bottom-left";
  const right = edges === "right" || edges === "top-right" || edges === "bottom-right";
  const top = edges === "top" || edges === "top-left" || edges === "top-right";
  const bottom = edges === "bottom" || edges === "bottom-left" || edges === "bottom-right";
  if (left) { nx = g.startRect.x + dx; nw = g.startRect.width - dx; }
  else if (right) { nw = g.startRect.width + dx; }
  if (top) { ny = g.startRect.y + dy; nh = g.startRect.height - dy; }
  else if (bottom) { nh = g.startRect.height + dy; }

  // Clamp against size constraints. Clamping the left/top edges
  // adjusts the anchor (x/y) so the OPPOSITE edge stays put.
  const minW = constraints?.minSize?.width ?? 1;
  const minH = constraints?.minSize?.height ?? 1;
  const maxW = constraints?.maxSize?.width ?? Number.POSITIVE_INFINITY;
  const maxH = constraints?.maxSize?.height ?? Number.POSITIVE_INFINITY;
  if (nw < minW) {
    if (left) nx -= (minW - nw);
    nw = minW;
  } else if (nw > maxW) {
    if (left) nx += (nw - maxW);
    nw = maxW;
  }
  if (nh < minH) {
    if (top) ny -= (minH - nh);
    nh = minH;
  } else if (nh > maxH) {
    if (top) ny += (nh - maxH);
    nh = maxH;
  }
  return { x: nx, y: ny, width: nw, height: nh };
}
