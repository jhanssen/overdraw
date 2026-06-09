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
import type { LayoutWindow, LayoutResult, LayoutReason } from "@overdraw/layout-types";
import type { LayoutDriver, LayoutSnapshot, LayoutApplyTarget } from "./layout-driver.js";

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Output { width: number; height: number; }

// Edge insets (output px). Decoration reserves border space around a window.
export interface Insets { top: number; right: number; bottom: number; left: number; }

// The WM only needs the surface's resource (for input routing / client id); it
// does not depend on the protocol layer's SurfaceRecord. Anything carrying a
// `resource` satisfies this.
export interface SurfaceHandle { resource: Resource; }

// Per-window hint state (core-plugin-api.md §1). Booleans representing
// client-driven (set_floating/set_fullscreen/...) and plugin-driven state
// (a hotkey plugin toggling floating). Stored verbatim so layout plugins
// can read them as inputs; the WM itself does not act on them.
// xdg_toplevel.set_* requests do not populate these yet -- those handlers
// are still no-ops (status.md "Read first").
export interface WindowHints {
  floating: boolean;
  fullscreen: boolean;
  maximized: boolean;
  minimized: boolean;
}

export type HintField = keyof WindowHints;
export const HINT_FIELDS: ReadonlyArray<HintField> =
  ["floating", "fullscreen", "maximized", "minimized"];

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
  // Hint state (see WindowHints). All four default to false on map.
  hints: WindowHints;
  // Freeform per-window state bag (core-plugin-api.md §1 "Per-window state
  // bag"). Plugins store concept-specific data here under namespaced keys
  // ('workspace.id', 'rules.tags', ...). Core does not interpret the values;
  // any structured-clone-safe value is accepted at the SDK boundary. Mutations
  // are observable via the 'window.state-changed' event.
  state: Map<string, unknown>;
}

export interface WmState { output: Output; windows: Window[]; }

// Configure sink: ask the protocol layer to send a sized configure to a window's
// toplevel (xdg_toplevel.configure + xdg_surface.configure with a fresh serial).
// Wired by installProtocols. The WM calls this whenever a window's content size
// changes (layout recompute on add/remove, or inset change).
export type ConfigureSink = (surfaceId: number, contentW: number, contentH: number) => void;

// Decoration-resize sink: fired when a decorated window's OUTER tile changes
// (move and/or size). Two things happen on a sink callback:
//   1. The compositor's surface layout for the decoration surface is updated by
//      the WM directly (so the existing decoration texture composites at the
//      new rect even before the plugin redraws -- prevents pixel corruption).
//   2. The decoration broker forwards the new geometry to the owning plugin as
//      a `decoration.resized` event so the plugin can redraw at the new size
//      (destroy-old-ring + create-new-ring; the ring is fixed-size at alloc).
// The sink is installed by main.ts (and the decoration GPU tests) via
// createWm({ decorationResize: ... }); the WM has no direct dependency on the
// broker.
export type DecorationResizeSink = (windowId: number, outerRect: Rect, contentRect: Rect, insets: Insets) => void;

// What setInsets grants back: the (possibly clamped) insets, the outer rect (the
// decoration's region = content rect grown by the insets), and the content rect
// (unchanged). The decoration surface is placed at outerRect.
export interface InsetGrant { insets: Insets; outerRect: Rect; contentRect: Rect; }

export interface Wm {
  state: WmState;
  // Proactive: called at get_toplevel (role assignment), BEFORE the client has
  // content. Inserts the window into the layout (as the new master) and
  // SCHEDULES a layout pass. The pass runs asynchronously through the layout
  // driver; results are applied (push setSurfaceLayout to the compositor +
  // fire configure) when compute() resolves. Idempotent for an already-added
  // surface.
  //
  // The returned rect is the window's CURRENT content rect (the placeholder
  // sentinel until the first layout settles, then the assigned content rect).
  // Callers needing the settled rect should `await wm.settled()` first.
  addWindow(surfaceId: number, surfaceRec: SurfaceHandle): Rect;
  // The window committed its first presentable content: add it to the draw stack.
  // Returns the current content rect (the placeholder until layout has
  // settled, then the assigned rect). Returns undefined when the window
  // isn't tracked.
  windowHasContent(surfaceId: number): Rect | undefined;
  unmapWindow(surfaceId: number): void;
  // Resolves when the layout has fully settled (no compute pending or in
  // flight). After addWindow / unmapWindow / setInsets, callers waiting on
  // post-layout geometry should await this.
  settled(): Promise<void>;
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

  // Hint state setters (core-plugin-api.md §1). Return true if the field
  // actually changed (so the caller can decide whether to emit a change
  // event), false if the value matched the current one or the window doesn't
  // exist.
  setHint(surfaceId: number, field: HintField, value: boolean): boolean;
  // Snapshot of a window's hints; returns null if unknown.
  getHints(surfaceId: number): WindowHints | null;

  // Freeform per-window state bag (core-plugin-api.md §1). Returns true if
  // the stored value changed (so an event should fire); false if unchanged
  // or the window doesn't exist. Pass `undefined` (via deleteState) to
  // remove a key; setting null is allowed and distinct from delete.
  setState(surfaceId: number, key: string, value: unknown): boolean;
  // Read a single state-bag value; undefined when unset or window unknown.
  getState(surfaceId: number, key: string): unknown;
  // Remove a state-bag key. Returns true if a value was removed.
  deleteState(surfaceId: number, key: string): boolean;
  // Snapshot of all state-bag entries for a window. Empty object when none /
  // when unknown.
  getStateAll(surfaceId: number): { [key: string]: unknown };

  // Snapshot of a window, suitable for sdk.windows.get / serialization over
  // the postMessage wire. Returns null when unknown. Excludes implementation
  // bookkeeping (surfaceRec).
  getSnapshot(surfaceId: number): WindowSnapshot | null;
  // Snapshot of every tracked window (sdk.windows.list).
  listSnapshots(): WindowSnapshot[];
}

// Structured-clone-safe snapshot of a window's observable state. The shape
// that flows over the worker wire (sdk.windows.get / list) and the typed
// event payloads. surfaceRec / Resource are NOT included (not cloneable).
export interface WindowSnapshot {
  surfaceId: number;
  rect: Rect;
  outer: Rect;
  insets?: Insets;
  decorationSurfaceId?: number;
  hasContent: boolean;
  contentGated: boolean;
  hints: WindowHints;
  state: { [key: string]: unknown };
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

// Options for createWm. `rebuild` and `configure` are present in every prod path
// (installProtocols installs them); unit tests omit them. `decorationResize`
// fires when a decorated window's OUTER tile changes (move/resize); the broker
// uses it to forward a `decoration.resized` event to the owning plugin so it
// can redraw its ring at the new size.
//
// `layoutDriverFactory` builds the driver once the WM has an apply-target
// (the WM passes itself in). Tests pass an inline driver (synchronous fake
// layout); main.ts passes a runtime-backed driver. When omitted, the WM
// constructs a no-op driver: schedule() does nothing, settled() resolves
// immediately. That mode is used by the existing GPU-free tests that don't
// care about layout output and don't want a runtime spinning up.
export interface WmOptions {
  rebuild?: () => void;
  configure?: ConfigureSink;
  decorationResize?: DecorationResizeSink;
  layoutDriverFactory?: (target: LayoutApplyTarget, snapshot: () => LayoutSnapshot) => LayoutDriver;
}

export function createWm(
  compositor: CompositorSink,
  output: Output,
  optsOrRebuild?: WmOptions | (() => void),
  configure?: ConfigureSink,
): Wm {
  // Backwards-compatible parameter shape: callers may pass either the new
  // WmOptions object as the third arg, or the previous (rebuild, configure)
  // positional pair. installProtocols + the GPU test harnesses use the new
  // shape; the pre-existing GPU-free unit tests still use the old one.
  let rebuild: (() => void) | undefined;
  let decorationResize: DecorationResizeSink | undefined;
  let layoutDriverFactory: WmOptions["layoutDriverFactory"];
  if (optsOrRebuild && typeof optsOrRebuild === "object") {
    rebuild = optsOrRebuild.rebuild;
    configure = optsOrRebuild.configure ?? configure;
    decorationResize = optsOrRebuild.decorationResize;
    layoutDriverFactory = optsOrRebuild.layoutDriverFactory;
  } else {
    rebuild = optsOrRebuild as (() => void) | undefined;
  }
  // windows: layout/stack order. Index 0 is the master (front); a newly added
  // window is inserted at the front (becomes master). Draw order is back-to-front
  // = reverse of this list (master drawn last/on-top is NOT desired; see pushStack).
  const windows: Window[] = [];
  const wm: WmState = { output, windows };

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

  // Apply a LayoutResult: update each window's outer rect to match, push the
  // compositor's setSurfaceLayout for mapped windows, fire configure where
  // size changed, and update bound decorations. Windows omitted from the
  // result keep their previous geometry (a layout that wants to hide a
  // window should leave it out; the driver doesn't auto-hide).
  function applyLayout(result: LayoutResult, _reason: LayoutReason): void {
    void _reason;
    // Index by id for O(1) lookup; layouts may return rects in arbitrary order.
    const byId = new Map<number, { id: number; outer: Rect }>();
    for (const r of result.rects) byId.set(r.id, r);
    for (const win of windows) {
      const r = byId.get(win.surfaceId);
      if (!r) continue;   // layout omitted this window: leave its geometry
      const prevContent = contentOf(win);
      const prevOuter = win.outer;
      win.outer = { ...r.outer };
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
      // Decoration follow-up: the OUTER tile changed -> reposition the existing
      // decoration surface NOW + fire the decoration-resize sink so the owning
      // plugin can redraw at the new size.
      const outerMoved = prevOuter.x !== win.outer.x || prevOuter.y !== win.outer.y
                      || prevOuter.width !== win.outer.width || prevOuter.height !== win.outer.height;
      if (win.decorationSurfaceId !== undefined && outerMoved) {
        compositor.setSurfaceLayout(win.decorationSurfaceId,
          win.outer.x, win.outer.y, win.outer.width, win.outer.height);
        if (decorationResize && win.insets) {
          decorationResize(win.surfaceId, { ...win.outer }, { ...content }, { ...win.insets });
        }
      }
    }
  }

  // Build a LayoutSnapshot from the current WM state. Called by the driver
  // each compute(). Caller never holds the references; immutable for the
  // duration of one compute.
  function snapshot(): LayoutSnapshot {
    const layoutWindows: LayoutWindow[] = windows.map((w) => ({
      id: w.surfaceId,
      role: "toplevel" as const,
      hints: {
        floating: w.hints.floating,
        wantsFullscreen: w.hints.fullscreen,
        wantsMaximized: w.hints.maximized,
        wantsMinimized: w.hints.minimized,
      },
      currentRect: { ...w.outer },
    }));
    return { output: { width: output.width, height: output.height }, windows: layoutWindows };
  }

  // Build the driver. When no factory is provided, use a stub that does
  // nothing (schedule is a no-op, settled() resolves immediately). This is
  // the mode for GPU-free unit tests that don't exercise layout output but
  // need a working WM for stack / focus / insets bookkeeping.
  const target: LayoutApplyTarget = { apply: applyLayout };
  const driver: LayoutDriver = layoutDriverFactory
    ? layoutDriverFactory(target, snapshot)
    : { schedule: () => { /* no-op */ }, settled: () => Promise.resolve() };

  return {
    state: wm,

    // Proactive: insert at the front (new window becomes master) and SCHEDULE
    // a layout pass. The pass runs through the layout driver asynchronously;
    // when its compute() resolves, the driver calls applyLayout(), which
    // assigns outer/rect and fires configure for any window whose content size
    // changed (including the new one).
    //
    // The returned rect is the placeholder sentinel until layout settles;
    // callers needing the assigned rect should `await wm.settled()`.
    addWindow(surfaceId, surfaceRec) {
      const existing = windows.find((w) => w.surfaceId === surfaceId);
      if (existing) return contentOf(existing); // idempotent
      const win: Window = {
        surfaceId,
        // Provisional sentinel (-1 size) so the first layout pass always
        // detects a change for the new window and sends its first configure,
        // even when its computed tile happens to match the output size.
        outer: { x: 0, y: 0, width: -1, height: -1 },
        rect: { x: 0, y: 0, width: -1, height: -1 },
        surfaceRec,
        hints: { floating: false, fullscreen: false, maximized: false, minimized: false },
        state: new Map<string, unknown>(),
      };
      windows.unshift(win); // front = master
      driver.schedule("mapped");
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
      driver.schedule("unmapped");   // remaining windows reflow when compute resolves
      pushStack();
    },

    settled() { return driver.settled(); },

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

    setHint(surfaceId, field, value) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return false;
      if (win.hints[field] === value) return false;
      win.hints[field] = value;
      return true;
    },

    getHints(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win ? { ...win.hints } : null;
    },

    setState(surfaceId, key, value) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return false;
      const existed = win.state.has(key);
      const prev = win.state.get(key);
      // Equality semantics: identity check is enough for primitives; for
      // objects, plugins are expected to replace (not mutate in place). A
      // false-positive "changed" event when the same object is re-set is
      // acceptable.
      if (existed && prev === value) return false;
      win.state.set(key, value);
      return true;
    },

    getState(surfaceId, key) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win ? win.state.get(key) : undefined;
    },

    deleteState(surfaceId, key) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return false;
      return win.state.delete(key);
    },

    getStateAll(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return {};
      const out: { [key: string]: unknown } = {};
      for (const [k, v] of win.state.entries()) out[k] = v;
      return out;
    },

    getSnapshot(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return null;
      return snapshotOf(win);
    },

    listSnapshots() {
      return windows.map(snapshotOf);
    },
  };
}

function snapshotOf(win: Window): WindowSnapshot {
  const state: { [key: string]: unknown } = {};
  for (const [k, v] of win.state.entries()) state[k] = v;
  const snap: WindowSnapshot = {
    surfaceId: win.surfaceId,
    rect: { ...win.rect },
    outer: { ...win.outer },
    hasContent: !!win.hasContent,
    contentGated: !!win.contentGated,
    hints: { ...win.hints },
    state,
  };
  if (win.insets) snap.insets = { ...win.insets };
  if (win.decorationSurfaceId !== undefined) snap.decorationSurfaceId = win.decorationSurfaceId;
  return snap;
}
