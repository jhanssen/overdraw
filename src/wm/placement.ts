// Window placement — STUB.
//
// This is the only piece of throwaway policy in the WM path. It decides where a
// newly mapped toplevel goes and returns an output-pixel rect. The durable seam
// is everything around it: the native setSurfaceLayout/setStack calls and the
// invocation points in the protocol layer. When a real layout model (dynamic
// tiling + floating) lands, replace this function's body (or have it delegate to
// the layout tree); nothing else needs to move.
//
// Current behavior: a trivial cascade. Each new window is offset down-right from
// the last, at a fixed size, clamped to the output.

import type { Rect, WmState } from "./index.js";

const CASCADE_STEP = 80;

// Returns { x, y, width, height } in output px. width/height of 0 means "use the
// surface's content size" (native fallback) -- the stub does not impose a size,
// only a position, so windows show at their natural size cascaded down-right.
export function placeWindow(wm: WmState): Rect {
  const n = wm.windows.length; // count BEFORE this window is added
  const out = wm.output;

  let x = (n * CASCADE_STEP) % Math.max(1, out.width - 100);
  let y = (n * CASCADE_STEP) % Math.max(1, out.height - 100);
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;

  return { x: x | 0, y: y | 0, width: 0, height: 0 };
}
