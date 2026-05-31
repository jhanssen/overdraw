// Window manager state holder (durable).
//
// Owns the window list + stacking order and pushes layout/stack to the
// compositor sink (CompositorSink.setSurfaceLayout / setStack). JS owns placement
// (architecture.md: "JS owns WM"); the compositor only consumes rects + order.
//
// This module is the durable seam. The *policy* (where windows go) lives in
// placement.ts and is a stub today; a future dynamic-tiling+floating model
// replaces that policy and may compute the whole arrangement, pushing it through
// the same setSurfaceLayout/setStack calls used here.

import type { Resource } from "../types.js";
import type { CompositorSink } from "../protocols/ctx.js";
import { placeWindow } from "./placement.js";

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Output { width: number; height: number; }

// The WM only needs the surface's resource (for input routing / client id); it
// does not depend on the protocol layer's SurfaceRecord. Anything carrying a
// `resource` satisfies this.
export interface SurfaceHandle { resource: Resource; }

export interface Window { surfaceId: number; rect: Rect; surfaceRec: SurfaceHandle; }
export interface WmState { output: Output; windows: Window[]; }

export interface Wm {
  state: WmState;
  mapWindow(surfaceId: number, surfaceRec: SurfaceHandle, contentW?: number, contentH?: number): Rect | undefined;
  unmapWindow(surfaceId: number): void;
  windowAt(x: number, y: number): Window | null;
}

export function createWm(compositor: CompositorSink, output: Output): Wm {
  // windows: stack order, back-to-front.
  const windows: Window[] = [];
  const wm: WmState = { output, windows };

  function pushStack(): void {
    compositor.setStack(windows.map((w) => w.surfaceId));
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
      const win: Window = {
        surfaceId,
        rect: { x: rect.x, y: rect.y, width: effW, height: effH },
        surfaceRec,
      };
      windows.push(win); // top of stack
      compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
      pushStack();
      return win.rect;
    },

    unmapWindow(surfaceId) {
      const i = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (i < 0) return;
      windows.splice(i, 1);
      pushStack();
    },

    // Topmost window containing the output-space point, or null.
    windowAt(x, y) {
      for (let i = windows.length - 1; i >= 0; i--) {
        const r = windows[i]!.rect;
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
          return windows[i]!;
      }
      return null;
    },
  };
}
