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
  // The window-bound decoration surface id, if a decoration was created for this
  // window. computeBaseStack splices it directly BELOW this window's content id,
  // so each decoration is z-bound to its own window (a window on top occludes the
  // decoration below it, just as it occludes the window below it). Absent = none.
  decorationSurfaceId?: number;
  // Content gating (decoration milestone piece 3): true while the window is held
  // out of the draw stack waiting for its decoration's first frame, so content +
  // decoration appear together (atomic). computeBaseStack skips gated windows.
  contentGated?: boolean;
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
  // Content gating (decoration piece 3): hold a window's content out of the draw
  // stack (gated=true) until its decoration's first frame is ready, then release
  // (gated=false) so content + decoration appear together. Rebuilds the stack via
  // the injected rebuild hook. No-op if the surface is not a mapped window.
  setContentGated(surfaceId: number, gated: boolean): void;
  isContentGated(surfaceId: number): boolean;
  // Bind a decoration surface to a window (or clear it with null). The decoration
  // draws directly below its window's content in the unified stack (computeBaseStack),
  // so it is z-bound to the window. Triggers a stack rebuild. No-op if the surface
  // is not a mapped window.
  setDecorationSurface(windowId: number, decoSurfaceId: number | null): void;
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

export function createWm(compositor: CompositorSink, output: Output, rebuild?: () => void): Wm {
  // windows: stack order, back-to-front.
  const windows: Window[] = [];
  const wm: WmState = { output, windows };

  function pushStack(): void {
    // Prefer the full rebuild (windows interleaved with their decorations +
    // subsurfaces + popups via computeBaseStack/rebuildStackWithPopups), the single
    // owner of the content stack. Without a hook (bare WM in GPU-free unit tests),
    // fall back to a direct setStack that still interleaves each window's decoration
    // directly below its content, and skips gated windows.
    if (rebuild) { rebuild(); return; }
    const ids: number[] = [];
    for (const w of windows) {
      if (w.contentGated) continue;
      if (w.decorationSurfaceId !== undefined) ids.push(w.decorationSurfaceId);
      ids.push(w.surfaceId);
    }
    compositor.setStack(ids);
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

    setContentGated(surfaceId, gated) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return;
      if (!!win.contentGated === gated) return;   // no change
      win.contentGated = gated;
      pushStack();   // re-push without/with this window; a fuller rebuild (popups/
                     // subsurfaces) follows on the next sweep and also filters gated.
    },

    isContentGated(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win?.contentGated === true;
    },

    setDecorationSurface(windowId, decoSurfaceId) {
      const win = windows.find((w) => w.surfaceId === windowId);
      if (!win) return;
      const next = decoSurfaceId === null ? undefined : decoSurfaceId;
      if (win.decorationSurfaceId === next) return;   // no change
      win.decorationSurfaceId = next;
      pushStack();   // re-interleave the decoration below its window's content
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
