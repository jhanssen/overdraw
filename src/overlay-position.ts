// Overlay geometry: the core-decides-authoritative-rect half of createOverlay
// (architecture.md "First plugin milestone": the plugin requests, the core
// decides the real rect and allocates, the plugin populates). Pure + GPU-free so
// it is unit-testable in isolation (mirrors popup-position.ts).
//
// A plugin declares intent (anchor + requested size on a layer); only the core
// knows the output rect, so the core computes the actual placement and MAY clamp
// the size to the output. The plugin renders to whatever rect it is granted.

export type OverlayAnchor =
  | "top-left" | "top" | "top-right"
  | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";

export interface OverlayRequest {
  anchor: OverlayAnchor;
  // Requested size; the core clamps to the output (an overlay never exceeds it).
  width: number;
  height: number;
  // Optional inset from the anchored edges (logical px). Default 0.
  margin?: number;
}

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Output { width: number; height: number; }

// Compute the authoritative output-space rect for an overlay request. The size is
// clamped to the output; the anchor positions the (possibly clamped) box against
// the output edges/center, honoring `margin` on the anchored edges; the final
// origin is clamped so the box stays fully on the output.
export function placeOverlay(req: OverlayRequest, output: Output): Rect {
  const m = Math.max(0, req.margin ?? 0);
  // Clamp size to the output (leave room for margins on anchored axes).
  const w = clamp(req.width, 0, output.width);
  const h = clamp(req.height, 0, output.height);

  const a = req.anchor;
  const left = a === "top-left" || a === "left" || a === "bottom-left";
  const right = a === "top-right" || a === "right" || a === "bottom-right";
  const top = a === "top-left" || a === "top" || a === "top-right";
  const bottom = a === "bottom-left" || a === "bottom" || a === "bottom-right";

  let x;
  if (left) x = m;
  else if (right) x = output.width - w - m;
  else x = Math.round((output.width - w) / 2);   // horizontally centered

  let y;
  if (top) y = m;
  else if (bottom) y = output.height - h - m;
  else y = Math.round((output.height - h) / 2);   // vertically centered

  // Keep the box fully on the output even if margins/size would push it off.
  x = clamp(x, 0, Math.max(0, output.width - w));
  y = clamp(y, 0, Math.max(0, output.height - h));
  return { x, y, width: w, height: h };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
