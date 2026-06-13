// Window manager state holder (durable).
//
// Owns the window list + stacking order and pushes layout/stack to the
// compositor sink. The geometry policy (where windows go) lives in
// layout-driver.ts (the resolver) + the bundled layout plugin. The
// behavioral state of each window (presentation, layoutMode, constraints,
// parent) lives here, mutated through propose().
//
// propose() is the single entry point for behavioral-state changes. It
// emits 'window.proposed' (interceptable), commits the final candidate,
// emits 'window.committed' (observe-only), and schedules a relayout when
// geometry-affecting fields changed.
//
// Structural operations (addWindow, unmapWindow, setInsets, etc.) stay
// direct calls because they manage membership and decoration, not state.

import type { Resource } from "../types.js";
import type { CompositorSink } from "../protocols/ctx.js";
import type { LayoutResult, LayoutReason } from "@overdraw/layout-types";
import type { LayoutDriver, LayoutSnapshot, LayoutApplyTarget } from "./layout-driver.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import { WINDOW_EVENT } from "../events/types.js";
import type {
  WindowRelayoutEvent,
  WindowState,
  Presentation,
  ProposalReason,
  WindowProposedEvent,
  WindowCommittedEvent,
} from "../events/types.js";

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
  // so each decoration is z-bound to its own window. Absent = none.
  decorationSurfaceId?: number;
  // Content gating: true while the window is held out of the draw stack
  // waiting for its decoration's first frame, so content + decoration appear
  // together (atomic).
  contentGated?: boolean;
  // True once the client has committed presentable content (the map-on-first-
  // content signal). A window is in the layout (and configured) from addWindow,
  // but only drawn once it has content.
  hasContent?: boolean;
  // Behavioral state (presentation, layoutMode, layoutData, constraints,
  // parent, restoreRect). Mutated only through propose().
  windowState: WindowState;
  // Freeform per-window state bag. Plugins store concept-specific data here
  // under namespaced keys ('workspace.id', 'rules.tags', ...). Core does not
  // interpret the values; any structured-clone-safe value is accepted at
  // the SDK boundary. Mutations emit 'window.state-bag-changed'.
  state: Map<string, unknown>;
}

// Default behavioral state for a freshly added window. Mutating the
// returned object is safe (it's a fresh literal per call).
export function defaultWindowState(): WindowState {
  return {
    presentation: "managed",
    layoutMode: null,
    layoutData: undefined,
    constraints: { minSize: null, maxSize: null },
    parent: null,
    restoreRect: null,
  };
}

export interface WmState { output: Output; windows: Window[]; }

// Configure sink: ask the protocol layer to send a sized configure to a window's
// toplevel. Wired by installProtocols.
export type ConfigureSink = (surfaceId: number, contentW: number, contentH: number) => void;

// Decoration-resize sink: fired when a decorated window's OUTER tile changes
// (move and/or size).
export type DecorationResizeSink = (windowId: number, outerRect: Rect, contentRect: Rect, insets: Insets) => void;

// What setInsets grants back: the (possibly clamped) insets, the outer rect (the
// decoration's region = content rect grown by the insets), and the content rect
// (unchanged).
export interface InsetGrant { insets: Insets; outerRect: Rect; contentRect: Rect; }

// A field-subset of WindowState. propose() merges this into the current
// state, runs the candidate through the proposed-event chain, then commits.
// Fields omitted from the proposal stay at their current value.
export interface WindowStateProposal {
  presentation?: Presentation;
  layoutMode?: string | null;
  layoutData?: unknown;
  constraints?: {
    minSize?: { width: number; height: number } | null;
    maxSize?: { width: number; height: number } | null;
  };
  parent?: number | null;
}

export interface Wm {
  state: WmState;
  // Proactive: called at get_toplevel (role assignment), BEFORE the client has
  // content. Inserts the window into the layout (as the new master) and
  // SCHEDULES a layout pass. Idempotent for an already-added surface. The
  // returned rect is the placeholder sentinel until layout has settled.
  addWindow(surfaceId: number, surfaceRec: SurfaceHandle): Rect;
  windowHasContent(surfaceId: number): Rect | undefined;
  unmapWindow(surfaceId: number): void;
  settled(): Promise<void>;
  windowAt(x: number, y: number): Window | null;
  setInsets(surfaceId: number, insets: Insets): InsetGrant | undefined;
  outerRectOf(surfaceId: number): Rect | undefined;
  rectOf(surfaceId: number): Rect | undefined;
  setContentGated(surfaceId: number, gated: boolean): void;
  isContentGated(surfaceId: number): boolean;
  setDecorationSurface(windowId: number, decoSurfaceId: number | null): void;

  // Propose a behavioral-state change. Builds a candidate by merging the
  // proposal onto the current state, runs the candidate through the
  // 'window.proposed' interceptor chain, commits the final candidate to
  // win.windowState, emits 'window.committed', and schedules a relayout
  // when geometry-affecting fields changed.
  //
  // Resolves AFTER the state is committed and any needed relayout has
  // been scheduled (NOT after the relayout settles). Returns the
  // committed state, or null if the window doesn't exist.
  propose(
    surfaceId: number,
    proposal: WindowStateProposal,
    reason: ProposalReason,
  ): Promise<WindowState | null>;

  // Snapshot of a window's behavioral state; null if unknown.
  getWindowState(surfaceId: number): WindowState | null;

  // Freeform per-window state bag. setState returns true if the value
  // actually changed (so the caller can decide whether to emit a change
  // event), false otherwise.
  setState(surfaceId: number, key: string, value: unknown): boolean;
  getState(surfaceId: number, key: string): unknown;
  deleteState(surfaceId: number, key: string): boolean;
  getStateAll(surfaceId: number): { [key: string]: unknown };

  getSnapshot(surfaceId: number): WindowSnapshot | null;
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
  windowState: WindowState;
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

function contentOf(win: Window): Rect {
  return win.insets ? shrink(win.outer, win.insets) : { ...win.outer };
}

// Validate that an arbitrary value matches the Rect shape with finite numbers.
function isRect(v: unknown): v is Rect {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { [k: string]: unknown };
  return Number.isFinite(r.x) && Number.isFinite(r.y)
      && Number.isFinite(r.width) && Number.isFinite(r.height);
}

// Deep-ish clone of WindowState for the proposed/committed payloads.
// Sufficient because we never include `layoutData` in deep-clone (it's
// opaque; pass-through); other fields are primitives or fixed-shape
// objects we copy explicitly.
function cloneState(s: WindowState): WindowState {
  return {
    presentation: s.presentation,
    layoutMode: s.layoutMode,
    layoutData: s.layoutData,
    constraints: {
      minSize: s.constraints.minSize ? { ...s.constraints.minSize } : null,
      maxSize: s.constraints.maxSize ? { ...s.constraints.maxSize } : null,
    },
    parent: s.parent,
    restoreRect: s.restoreRect ? { ...s.restoreRect } : null,
  };
}

// Validate an arbitrary payload's `candidate` field after the interceptor
// chain. An interceptor may return garbage; if shape is wrong we fall back
// to the original candidate. Returns the validated state or null.
function validateState(v: unknown): WindowState | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as { [k: string]: unknown };
  const p = o.presentation;
  if (p !== "managed" && p !== "maximized" && p !== "fullscreen" && p !== "minimized") {
    return null;
  }
  if (o.layoutMode !== null && typeof o.layoutMode !== "string") return null;
  const c = o.constraints;
  if (typeof c !== "object" || c === null) return null;
  const cc = c as { [k: string]: unknown };
  // minSize / maxSize: null or {width, height}.
  for (const k of ["minSize", "maxSize"] as const) {
    const val = cc[k];
    if (val !== null) {
      if (typeof val !== "object" || val === null) return null;
      const sz = val as { [k: string]: unknown };
      if (!Number.isFinite(sz.width) || !Number.isFinite(sz.height)) return null;
    }
  }
  if (o.parent !== null && typeof o.parent !== "number") return null;
  if (o.restoreRect !== null && !isRect(o.restoreRect)) return null;
  // layoutData is opaque -- accept anything.
  // We've validated each known field above; the cast here marks the value
  // as a well-formed WindowState for downstream code.
  // eslint-disable-next-line no-restricted-syntax
  return o as unknown as WindowState;
}

// Fields whose change requires a layout pass.
const GEOMETRY_FIELDS: ReadonlyArray<keyof WindowState> = [
  "presentation", "layoutMode", "layoutData", "constraints",
];

// Diff two WindowState values; returns the list of differing field names.
function diffState(prev: WindowState, next: WindowState): Array<keyof WindowState> {
  const out: Array<keyof WindowState> = [];
  if (prev.presentation !== next.presentation) out.push("presentation");
  if (prev.layoutMode !== next.layoutMode) out.push("layoutMode");
  // layoutData identity-compare; plugins are expected to replace, not mutate.
  if (prev.layoutData !== next.layoutData) out.push("layoutData");
  if (!constraintsEqual(prev.constraints, next.constraints)) out.push("constraints");
  if (prev.parent !== next.parent) out.push("parent");
  if (!restoreRectEqual(prev.restoreRect, next.restoreRect)) out.push("restoreRect");
  return out;
}

function constraintsEqual(a: WindowState["constraints"], b: WindowState["constraints"]): boolean {
  return sizeEqual(a.minSize, b.minSize) && sizeEqual(a.maxSize, b.maxSize);
}

function sizeEqual(
  a: { width: number; height: number } | null,
  b: { width: number; height: number } | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.width === b.width && a.height === b.height;
}

function restoreRectEqual(a: Rect | null, b: Rect | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Merge a proposal onto the current state. Returns a new WindowState; does
// not mutate `current`.
function mergeProposal(current: WindowState, p: WindowStateProposal): WindowState {
  const next = cloneState(current);
  if (p.presentation !== undefined) next.presentation = p.presentation;
  if (p.layoutMode !== undefined) next.layoutMode = p.layoutMode;
  if ("layoutData" in p) next.layoutData = p.layoutData;
  if (p.constraints !== undefined) {
    if (p.constraints.minSize !== undefined) {
      next.constraints.minSize = p.constraints.minSize === null
        ? null
        : { ...p.constraints.minSize };
    }
    if (p.constraints.maxSize !== undefined) {
      next.constraints.maxSize = p.constraints.maxSize === null
        ? null
        : { ...p.constraints.maxSize };
    }
  }
  if (p.parent !== undefined) next.parent = p.parent;
  return next;
}

export interface WmOptions {
  rebuild?: () => void;
  configure?: ConfigureSink;
  decorationResize?: DecorationResizeSink;
  layoutDriverFactory?: (target: LayoutApplyTarget, snapshot: () => LayoutSnapshot) => LayoutDriver;
  // Plugin-visible event bus. When set:
  //   - applyLayout emits 'window.relayout' per affected window before
  //     mutating its outer tile, awaiting interceptors.
  //   - propose() emits 'window.proposed' (interceptable) and
  //     'window.committed' (observe-only).
  // Omitting it skips both emit paths (GPU-free tests with no bus).
  pluginBus?: DynamicBus;
}

// Window state convenience helpers re-exported here so callers reading the
// WM module don't need a parallel events/types.js import.
export type { Presentation, WindowState, ProposalReason } from "../events/types.js";

// Per-handler ceiling for window.relayout + window.proposed interceptors.
const INTERCEPTOR_TIMEOUT_MS = 100;

export function createWm(
  compositor: CompositorSink,
  output: Output,
  optsOrRebuild?: WmOptions | (() => void),
  configure?: ConfigureSink,
): Wm {
  let rebuild: (() => void) | undefined;
  let decorationResize: DecorationResizeSink | undefined;
  let layoutDriverFactory: WmOptions["layoutDriverFactory"];
  let pluginBus: DynamicBus | undefined;
  if (optsOrRebuild && typeof optsOrRebuild === "object") {
    rebuild = optsOrRebuild.rebuild;
    configure = optsOrRebuild.configure ?? configure;
    decorationResize = optsOrRebuild.decorationResize;
    layoutDriverFactory = optsOrRebuild.layoutDriverFactory;
    pluginBus = optsOrRebuild.pluginBus;
  } else {
    rebuild = optsOrRebuild as (() => void) | undefined;
  }
  const windows: Window[] = [];
  const wm: WmState = { output, windows };

  function pushStack(): void {
    if (rebuild) { rebuild(); return; }
    const ids: number[] = [];
    for (const w of windows) {
      if (w.contentGated || !w.hasContent) continue;
      if (w.decorationSurfaceId !== undefined) ids.push(w.decorationSurfaceId);
      ids.push(w.surfaceId);
    }
    compositor.setStack(ids);
  }

  // Apply a LayoutResult: emit window.relayout, then update each window's
  // outer rect, push the compositor's setSurfaceLayout, fire configure
  // where size changed, and update bound decorations.
  async function applyLayout(result: LayoutResult, _reason: LayoutReason): Promise<void> {
    void _reason;
    const byId = new Map<number, { id: number; outer: Rect }>();
    for (const r of result.rects) byId.set(r.id, r);
    const snapshotWindows = [...windows];
    for (const win of snapshotWindows) {
      const r = byId.get(win.surfaceId);
      if (!r) continue;
      const prevContent = contentOf(win);
      const prevOuter = win.outer;
      let newOuter: Rect = { ...r.outer };

      if (pluginBus) {
        const initial: WindowRelayoutEvent = {
          surfaceId: win.surfaceId,
          oldOuter: { ...prevOuter },
          newOuter: { ...newOuter },
        };
        const finalPayload = await pluginBus.emit(WINDOW_EVENT.relayout, initial,
          { timeoutMs: INTERCEPTOR_TIMEOUT_MS });
        if (!windows.includes(win)) continue;
        const ev = finalPayload as WindowRelayoutEvent | undefined;
        if (ev && isRect(ev.newOuter)) newOuter = { ...ev.newOuter };
      }

      win.outer = newOuter;
      const content = contentOf(win);
      win.rect = content;
      if (win.hasContent) {
        compositor.setSurfaceLayout(win.surfaceId, content.x, content.y, content.width, content.height);
      }
      if (configure && (content.width !== prevContent.width || content.height !== prevContent.height)) {
        configure(win.surfaceId, content.width, content.height);
      }
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

  // Build a LayoutSnapshot from the current WM state. Carries presentation
  // so the driver's resolver can dispatch mode-specific rects without
  // calling the plugin.
  function snapshot(): LayoutSnapshot {
    const snapshotWindows: import("./layout-driver.js").LayoutSnapshotWindow[] =
      windows.map((w) => ({
        id: w.surfaceId,
        role: "toplevel" as const,
        presentation: w.windowState.presentation,
        layoutMode: w.windowState.layoutMode ?? undefined,
        layoutData: w.windowState.layoutData,
        constraints: {
          minSize: w.windowState.constraints.minSize ?? undefined,
          maxSize: w.windowState.constraints.maxSize ?? undefined,
        },
        currentRect: { ...w.outer },
        ...(w.windowState.restoreRect ? { restoreRect: { ...w.windowState.restoreRect } } : {}),
      }));
    return { output: { width: output.width, height: output.height }, windows: snapshotWindows };
  }

  const target: LayoutApplyTarget = { apply: applyLayout };
  const driver: LayoutDriver = layoutDriverFactory
    ? layoutDriverFactory(target, snapshot)
    : { schedule: () => { /* no-op */ }, settled: () => Promise.resolve() };

  return {
    state: wm,

    addWindow(surfaceId, surfaceRec) {
      const existing = windows.find((w) => w.surfaceId === surfaceId);
      if (existing) return contentOf(existing);
      const win: Window = {
        surfaceId,
        outer: { x: 0, y: 0, width: -1, height: -1 },
        rect: { x: 0, y: 0, width: -1, height: -1 },
        surfaceRec,
        windowState: defaultWindowState(),
        state: new Map<string, unknown>(),
      };
      windows.unshift(win);
      driver.schedule("mapped");
      return win.rect;
    },

    windowHasContent(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      if (!win.hasContent) {
        win.hasContent = true;
        compositor.setSurfaceLayout(win.surfaceId, win.rect.x, win.rect.y, win.rect.width, win.rect.height);
        pushStack();
      }
      return { ...win.rect };
    },

    unmapWindow(surfaceId) {
      const i = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (i < 0) return;
      windows.splice(i, 1);
      driver.schedule("unmapped");
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
      return win ? { ...win.outer } : undefined;
    },

    rectOf(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win ? { ...win.rect } : undefined;
    },

    setContentGated(surfaceId, gated) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return;
      if (!!win.contentGated === gated) return;
      win.contentGated = gated;
      pushStack();
    },

    isContentGated(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win?.contentGated === true;
    },

    setDecorationSurface(windowId, decoSurfaceId) {
      const win = windows.find((w) => w.surfaceId === windowId);
      if (!win) return;
      const next = decoSurfaceId === null ? undefined : decoSurfaceId;
      if (win.decorationSurfaceId === next) return;
      win.decorationSurfaceId = next;
      if (next !== undefined && win.outer.width > 0 && win.outer.height > 0) {
        compositor.setSurfaceLayout(next, win.outer.x, win.outer.y,
                                    win.outer.width, win.outer.height);
      }
      pushStack();
    },

    windowAt(x, y) {
      for (let i = windows.length - 1; i >= 0; i--) {
        const win = windows[i];
        const r = win.rect;
        if (x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
          return win;
      }
      return null;
    },

    async propose(surfaceId, proposal, reason) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return null;
      const current = cloneState(win.windowState);
      let candidate = mergeProposal(current, proposal);

      if (pluginBus) {
        const initial: WindowProposedEvent = {
          surfaceId, reason, current,
          candidate: cloneState(candidate),
        };
        const finalPayload = await pluginBus.emit(WINDOW_EVENT.proposed, initial,
          { timeoutMs: INTERCEPTOR_TIMEOUT_MS });
        if (!windows.includes(win)) return null; // unmapped during await
        const ev = finalPayload as WindowProposedEvent | undefined;
        const modified = ev ? validateState(ev.candidate) : null;
        if (modified) candidate = cloneState(modified);
      }

      const changed = diffState(current, candidate);
      if (changed.length === 0) return cloneState(current);

      win.windowState = candidate;

      if (pluginBus) {
        const ev: WindowCommittedEvent = {
          surfaceId, reason,
          previous: current,
          current: cloneState(candidate),
          changed: [...changed],
        };
        pluginBus.emit(WINDOW_EVENT.committed, ev);
      }

      // Schedule a relayout when geometry-relevant fields changed.
      if (changed.some((f) => GEOMETRY_FIELDS.includes(f))) {
        driver.schedule("state-changed");
      }

      return cloneState(candidate);
    },

    getWindowState(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win ? cloneState(win.windowState) : null;
    },

    setState(surfaceId, key, value) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return false;
      const existed = win.state.has(key);
      const prev = win.state.get(key);
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
      return win ? snapshotOf(win) : null;
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
    windowState: {
      presentation: win.windowState.presentation,
      layoutMode: win.windowState.layoutMode,
      layoutData: win.windowState.layoutData,
      constraints: {
        minSize: win.windowState.constraints.minSize
          ? { ...win.windowState.constraints.minSize } : null,
        maxSize: win.windowState.constraints.maxSize
          ? { ...win.windowState.constraints.maxSize } : null,
      },
      parent: win.windowState.parent,
      restoreRect: win.windowState.restoreRect
        ? { ...win.windowState.restoreRect } : null,
    },
    state,
  };
  if (win.insets) snap.insets = { ...win.insets };
  if (win.decorationSurfaceId !== undefined) snap.decorationSurfaceId = win.decorationSurfaceId;
  return snap;
}
