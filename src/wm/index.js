// Window manager state holder (durable).
//
// Owns the window list + stacking order and pushes layout/stack to native via
// addon.setSurfaceLayout / addon.setStack. JS owns placement (architecture.md:
// "JS owns WM"); native only consumes rects + order.
//
// This module is the durable seam. The *policy* (where windows go) lives in
// placement.js and is a stub today; a future dynamic-tiling+floating model
// replaces that policy and may compute the whole arrangement, pushing it through
// the same setSurfaceLayout/setStack calls used here.

import { placeWindow } from './placement.js';

export function createWm(addon, output) {
  // windows: stack order, back-to-front. Each: { surfaceId, rect, surfaceRec }.
  const windows = [];
  const wm = { output, windows };

  function pushStack() {
    addon.setStack(windows.map((w) => w.surfaceId));
  }

  return {
    state: wm,

    // Called when a toplevel maps (first buffered commit). Assigns a rect via
    // the placement policy, pushes it to native, adds to the top of the stack.
    mapWindow(surfaceId, surfaceRec, contentW = 0, contentH = 0) {
      if (windows.some((w) => w.surfaceId === surfaceId)) return; // already mapped
      const rect = placeWindow(wm);
      // The placement stub may leave size 0 (= use content size). Resolve the
      // effective size so hit-testing (windowAt) has real bounds, while still
      // letting native fall back to content size for drawing.
      const effW = rect.width || contentW;
      const effH = rect.height || contentH;
      const win = { surfaceId, rect: { x: rect.x, y: rect.y, width: effW, height: effH }, surfaceRec };
      windows.push(win);  // top of stack
      addon.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      pushStack();
      return win.rect;
    },

    // Called on surface destroy / unmap.
    unmapWindow(surfaceId) {
      const i = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (i < 0) return;
      windows.splice(i, 1);
      pushStack();
    },

    // The window whose rect contains the output-space point, topmost first, or
    // null. For pointer hit-testing once the seat layer lands.
    windowAt(x, y) {
      for (let i = windows.length - 1; i >= 0; i--) {
        const r = windows[i].rect;
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
          return windows[i];
      }
      return null;
    },
  };
}
