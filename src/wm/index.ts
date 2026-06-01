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

// Edge insets (output px). Decoration reserves border space around a window.
export interface Insets { top: number; right: number; bottom: number; left: number; }

// The WM only needs the surface's resource (for input routing / client id); it
// does not depend on the protocol layer's SurfaceRecord. Anything carrying a
// `resource` satisfies this.
export interface SurfaceHandle { resource: Resource; }

export interface Window {
  surfaceId: number;
  // The CONTENT rect (where the client draws). Unchanged by decoration insets
  // (additive insets: the client is never told; its content stays put).
  rect: Rect;
  surfaceRec: SurfaceHandle;
  // Decoration insets reserved around this window (additive). Absent = none.
  insets?: Insets;
}

export interface WmState { output: Output; windows: Window[]; }

// What setInsets grants back: the (possibly clamped) insets, the outer rect (the
// decoration's region = content rect grown by the insets), and the content rect
// (unchanged). The decoration surface is placed at outerRect.
export interface InsetGrant { insets: Insets; outerRect: Rect; contentRect: Rect; }

export interface Wm {
  state: WmState;
  mapWindow(surfaceId: number, surfaceRec: SurfaceHandle, contentW?: number, contentH?: number): Rect | undefined;
  unmapWindow(surfaceId: number): void;
  windowAt(x: number, y: number): Window | null;
  // Reserve additive decoration insets around a mapped window. ADDITIVE: the
  // window's OUTER rect = its as-mapped content rect grown by the insets; the
  // content rect (and the client) are unchanged. Returns the granted geometry, or
  // undefined if the surface is not a mapped window. The core may clamp the insets
  // (v1 does not, but the contract allows it). Idempotent-replace: a second call
  // sets the new insets.
  setInsets(surfaceId: number, insets: Insets): InsetGrant | undefined;
  // The outer rect of a window (content grown by its insets), or the content rect
  // when it has none. Used for decoration placement + (future) outer hit-testing.
  outerRectOf(surfaceId: number): Rect | undefined;
}

// The outer rect = the content rect grown by the insets (additive): origin moves
// up-left by (left, top); size grows by (left+right, top+bottom).
function grow(content: Rect, i: Insets): Rect {
  return {
    x: content.x - i.left,
    y: content.y - i.top,
    width: content.width + i.left + i.right,
    height: content.height + i.top + i.bottom,
  };
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

    setInsets(surfaceId, insets) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      // v1: grant the requested insets verbatim (the contract allows clamping; a
      // real layout policy may clamp e.g. side insets to zero when maximized).
      const granted: Insets = {
        top: Math.max(0, insets.top), right: Math.max(0, insets.right),
        bottom: Math.max(0, insets.bottom), left: Math.max(0, insets.left),
      };
      win.insets = granted;
      const contentRect = { ...win.rect };
      const outerRect = grow(contentRect, granted);
      return { insets: granted, outerRect, contentRect };
    },

    outerRectOf(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      return win.insets ? grow(win.rect, win.insets) : { ...win.rect };
    },

    // Topmost window containing the output-space point, or null.
    windowAt(x, y) {
      for (let i = windows.length - 1; i >= 0; i--) {
        const win = windows[i];
        const r = win.rect;
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
          return win;
      }
      return null;
    },
  };
}
