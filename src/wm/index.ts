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
import { masterStackLayout, DEFAULT_LAYOUT, type LayoutParams } from "./placement.js";

export type { LayoutParams } from "./placement.js";

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
  // The CONTENT rect (where the client draws). In the tiling model this is the
  // window's OUTER tile shrunk by its decoration insets: the layout owns the
  // outer tile; decoration eats into it; the client is configured to `rect`.
  rect: Rect;
  // The OUTER tile assigned by the layout (decoration-inclusive). On-screen by
  // construction (the layout clamps to the output). Decoration draws here; the
  // content rect sits inside it offset by the insets.
  outer: Rect;
  surfaceRec: SurfaceHandle;
  // Decoration insets reserved inside the outer tile. Absent = none (content ==
  // outer).
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
  // True once the client has committed presentable content (the map-on-first-
  // content signal). A window is in the layout (and configured) from addWindow,
  // but only drawn once it has content.
  hasContent?: boolean;
}

export interface WmState { output: Output; windows: Window[]; layout: LayoutParams; }

// Configure sink: ask the protocol layer to send a sized configure to a window's
// toplevel (xdg_toplevel.configure + xdg_surface.configure with a fresh serial).
// Wired by installProtocols. The WM calls this whenever a window's content size
// changes (layout recompute on add/remove, or inset change).
export type ConfigureSink = (surfaceId: number, contentW: number, contentH: number) => void;

// What setInsets grants back: the (possibly clamped) insets, the outer rect (the
// decoration's region = content rect grown by the insets), and the content rect
// (unchanged). The decoration surface is placed at outerRect.
export interface InsetGrant { insets: Insets; outerRect: Rect; contentRect: Rect; }

export interface Wm {
  state: WmState;
  // Proactive: called at get_toplevel (role assignment), BEFORE the client has
  // content. Inserts the window into the layout (as the new master), recomputes
  // tiles for the whole set, and configures every window whose content size
  // changed (including the new one). The window is not drawn until it commits
  // content (windowHasContent). Returns the new window's content rect.
  addWindow(surfaceId: number, surfaceRec: SurfaceHandle): Rect;
  // The window committed its first presentable content: add it to the draw stack.
  // Geometry was already assigned by addWindow. Returns the content rect, or
  // undefined if the window is not tracked.
  windowHasContent(surfaceId: number): Rect | undefined;
  unmapWindow(surfaceId: number): void;
  windowAt(x: number, y: number): Window | null;
  // Reserve decoration insets INSIDE a window's outer tile. SUBTRACTIVE: the
  // window's content rect = its outer tile shrunk by the insets, so the
  // decoration is always on-screen (the outer tile is on-screen by construction).
  // The client is reconfigured to the (shrunk) content size. Returns the granted
  // geometry, or undefined if the surface is not a tracked window. Idempotent-
  // replace: a second call sets the new insets.
  setInsets(surfaceId: number, insets: Insets): InsetGrant | undefined;
  // The outer tile of a window (the decoration's region), or the content rect when
  // it has no insets. Used for decoration placement + (future) outer hit-testing.
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

// The content rect = the outer tile shrunk by the insets (subtractive): origin
// moves down-right by (left, top); size shrinks by (left+right, top+bottom),
// clamped non-negative. The decoration occupies the band between outer and content.
function shrink(outer: Rect, i: Insets): Rect {
  return {
    x: outer.x + i.left,
    y: outer.y + i.top,
    width: Math.max(0, outer.width - i.left - i.right),
    height: Math.max(0, outer.height - i.top - i.bottom),
  };
}

// The content rect for a window given its current outer tile + insets.
function contentOf(win: Window): Rect {
  return win.insets ? shrink(win.outer, win.insets) : { ...win.outer };
}

export function createWm(
  compositor: CompositorSink,
  output: Output,
  rebuild?: () => void,
  configure?: ConfigureSink,
  layout: LayoutParams = DEFAULT_LAYOUT,
): Wm {
  // windows: layout/stack order. Index 0 is the master (front); a newly added
  // window is inserted at the front (becomes master). Draw order is back-to-front
  // = reverse of this list (master drawn last/on-top is NOT desired; see pushStack).
  const windows: Window[] = [];
  const wm: WmState = { output, windows, layout };

  function pushStack(): void {
    // Prefer the full rebuild (windows interleaved with their decorations +
    // subsurfaces + popups via computeBaseStack/rebuildStackWithPopups), the single
    // owner of the content stack. Without a hook (bare WM in GPU-free unit tests),
    // fall back to a direct setStack that still interleaves each window's decoration
    // directly below its content, and skips gated/contentless windows.
    if (rebuild) { rebuild(); return; }
    const ids: number[] = [];
    for (const w of windows) {
      if (w.contentGated || !w.hasContent) continue;
      if (w.decorationSurfaceId !== undefined) ids.push(w.decorationSurfaceId);
      ids.push(w.surfaceId);
    }
    compositor.setStack(ids);
  }

  // Recompute every window's outer tile from the current count + order, update
  // content rects, push layout for windows that have content, and configure any
  // window whose content size changed. The single place geometry is assigned.
  function relayout(): void {
    const tiles = masterStackLayout(windows.length, output, layout);
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      const prevContent = contentOf(win);
      win.outer = tiles[i];
      const content = contentOf(win);
      win.rect = content;
      // Drawn position follows the content rect; only meaningful once mapped.
      if (win.hasContent) {
        compositor.setSurfaceLayout(win.surfaceId, content.x, content.y, content.width, content.height);
      }
      // Configure the client to the new content size if it changed.
      if (configure && (content.width !== prevContent.width || content.height !== prevContent.height)) {
        configure(win.surfaceId, content.width, content.height);
      }
    }
  }

  return {
    state: wm,

    // Proactive: insert at the front (new window becomes master), recompute the
    // whole layout, configure all windows whose content size changed. Geometry is
    // assigned here, before the client has content.
    addWindow(surfaceId, surfaceRec) {
      const existing = windows.find((w) => w.surfaceId === surfaceId);
      if (existing) return contentOf(existing); // idempotent
      const win: Window = {
        surfaceId,
        // Provisional sentinel (-1 size) so relayout() always detects a change for
        // the new window and sends its first configure, even when its computed tile
        // happens to match the output size (single-window case).
        outer: { x: 0, y: 0, width: -1, height: -1 },
        rect: { x: 0, y: 0, width: -1, height: -1 },
        surfaceRec,
      };
      windows.unshift(win); // front = master
      relayout();           // assigns outer/rect + configures the new window + reflows others
      return win.rect;
    },

    // First content commit: mark drawable + add to the stack. Geometry already set.
    windowHasContent(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      if (!win.hasContent) {
        win.hasContent = true;
        // Push its layout now that it is drawable, then (re)build the stack.
        compositor.setSurfaceLayout(win.surfaceId, win.rect.x, win.rect.y, win.rect.width, win.rect.height);
        pushStack();
      }
      return { ...win.rect };
    },

    unmapWindow(surfaceId) {
      const i = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (i < 0) return;
      windows.splice(i, 1);
      relayout();   // remaining windows reflow + get reconfigured
      pushStack();
    },

    setInsets(surfaceId, insets) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      const granted: Insets = {
        top: Math.max(0, insets.top), right: Math.max(0, insets.right),
        bottom: Math.max(0, insets.bottom), left: Math.max(0, insets.left),
      };
      const prevContent = contentOf(win);
      win.insets = granted;
      const contentRect = contentOf(win);
      win.rect = contentRect;
      const outerRect = { ...win.outer };
      // Content shrank inside the fixed outer tile: reposition + reconfigure.
      if (win.hasContent) {
        compositor.setSurfaceLayout(win.surfaceId, contentRect.x, contentRect.y, contentRect.width, contentRect.height);
      }
      if (configure && (contentRect.width !== prevContent.width || contentRect.height !== prevContent.height)) {
        configure(win.surfaceId, contentRect.width, contentRect.height);
      }
      return { insets: granted, outerRect, contentRect };
    },

    outerRectOf(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      return { ...win.outer };
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
