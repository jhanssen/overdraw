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
  WindowPreconfigureEvent,
} from "../events/types.js";

export interface Rect { x: number; y: number; width: number; height: number; }

// One output the WM lays windows out on. The `rect` is the output's region in
// the global logical coordinate space (logicalPosition + logicalSize); each
// output renders its sub-rectangle of that space. `scale` is the HiDPI factor;
// the layout plugin receives it and may use it to derive minimum-size
// thresholds.
export interface WmOutput {
  id: number;
  rect: Rect;
  scale: number;
}

// Edge insets (output px). Decoration reserves border space around a window.
export interface Insets { top: number; right: number; bottom: number; left: number; }

// The WM only needs the surface's resource (for input routing / client id); it
// does not depend on the protocol layer's SurfaceRecord. Anything carrying a
// `resource` satisfies this.
export interface SurfaceHandle { resource: Resource; }

export interface Window {
  surfaceId: number;
  // Which output this window is laid out on. Set at addWindow (defaulting to
  // the primary live output); updated by setWindowOutput when an explicit move
  // crosses a boundary, or by setFloatingRect when an interactive drag carries
  // the window into another output's rect. The layout-driver partitions
  // windows by this field and runs the plugin once per output.
  outputId: number;
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
  // Per-window mutation queue. Async operations on win.windowState
  // (propose, markInitialCommitComplete) chain on this so a second call
  // doesn't read stale state mid-microtask from an in-flight first call.
  // Each operation: await pendingMutation; do work; set pendingMutation
  // to its own completion. Resolves once the operation has committed
  // (state mutated; events emitted).
  pendingMutation?: Promise<void>;
  // The outer rect to use when presentation === 'floating'. Captured
  // when the window first transitions into 'floating' (defaulting to
  // the current outer so it stays visually in place); updated per-frame
  // during an interactive move/resize grab; preserved across
  // floating <-> managed transitions so a window restoring to floating
  // appears where the user last put it.
  floatingRect?: Rect;
  // True while the window is between get_toplevel and the initial commit.
  // While set, applyLayout assigns the rect but skips firing configure -- so
  // a client that calls set_maximized between get_toplevel and the initial
  // commit gets a SINGLE first configure carrying the final state + dims.
  // markInitialCommitComplete() clears the flag, emits window.proposed (with
  // initialState reflecting the accumulated client-declared state), commits
  // any modifications, and forces a configure with the resolved size.
  // Default false; production opts in via addWindow(..., {deferInitialCommit:true}).
  pendingInitialCommit?: boolean;
  // Set when markInitialCommitComplete has sent the throwaway 0x0 first
  // configure and the real tile size is still owed. windowHasContent() sends
  // that size as the SECOND configure (a resize) once the client commits
  // content -- clients that ignore the geometry of their first configure
  // (some media players size to their own content) honor the resize.
  pendingSizeConfigure?: boolean;
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

// The WM's per-output table, keyed by `outputId`. Always non-empty: at least
// the primary live output, or the virtual fallback when no real output exists.
// Replaced wholesale by setOutputs; each output's `rect` is its slice of the
// global logical coordinate space.
export interface WmState { outputs: Map<number, WmOutput>; windows: Window[]; }

// Configure sink: ask the protocol layer to send a sized configure to a window's
// toplevel. Returns the configure serial (for the resize transaction to match
// against the client's ack), or null if no configure was sent. Wired by
// installProtocols.
export type ConfigureSink = (surfaceId: number, contentW: number, contentH: number) => number | null;

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
  // Trigger a layout pass with the given reason. Used by callers outside the
  // WM that affect the tile region (notably layer-shell reserved-zone changes:
  // a new exclusive zone shrinks the tile region for every managed window).
  // Coalesces with in-flight passes via the driver's existing scheduling.
  schedule(reason: import("@overdraw/layout-types").LayoutReason): void;
  // Replace the WM's output set. The new set must be non-empty (the WM
  // requires ≥1 output at all times -- the virtual fallback is what the host
  // installs when no real output exists). Windows whose outputId is not in
  // the new set are reassigned to the primary (lowest id) of the new set so
  // no window is orphaned. Schedules an output-resized relayout.
  setOutputs(outputs: ReadonlyArray<WmOutput>): void;
  // The id of the primary output -- the lowest id in state.outputs, used as
  // the default home for newly-mapped windows. Throws if the WM has no
  // outputs (the construction invariant forbids this).
  primaryOutputId(): number;
  // Explicitly reassign a window to a different output. Schedules a relayout
  // (both the old and new outputs may need to repartition). No-op if the
  // window doesn't exist or is already on the target output.
  setWindowOutput(surfaceId: number, outputId: number): void;
  // Proactive: called at get_toplevel (role assignment), BEFORE the client has
  // content. Inserts the window into the layout (as the new master) and
  // schedules a layout pass. Idempotent for an already-added surface. The
  // returned rect is the placeholder sentinel until layout has settled.
  //
  // opts.deferInitialCommit (default false): hold the first configure until
  // markInitialCommitComplete() is called. The layout pass still runs and
  // the rect is assigned, but configure() is suppressed so client-declared
  // state arriving between get_toplevel and the initial commit can fold
  // into a single first configure. Tests calling addWindow directly omit
  // this; the production xdg_surface.get_toplevel handler opts in.
  addWindow(
    surfaceId: number,
    surfaceRec: SurfaceHandle,
    opts?: { deferInitialCommit?: boolean; outputId?: number },
  ): Rect;
  // Mark the initial-commit phase complete for a deferred window: emit
  // window.proposed with the accumulated state as the candidate so a
  // window-rules plugin can intercept, commit any modifications, and force
  // a configure with the resolved content size. No-op when the window
  // doesn't exist or wasn't in the deferred-commit phase.
  //
  // Carries appId + title in the emitted event so window-rules plugins can
  // dispatch off them. The caller (wl_surface.commit when it detects an
  // initial commit) supplies them.
  markInitialCommitComplete(
    surfaceId: number,
    info: { appId: string | null; title: string | null },
  ): Promise<void>;
  // Synchronously send the throwaway 0x0 first configure (with the resolved
  // state array) so the xdg-shell handshake completes within the client's
  // initial-commit dispatch. Sets pendingSizeConfigure so the real tile size
  // follows as a second configure. No-op if the window isn't in the
  // deferred-initial-commit phase or already got its first configure.
  sendInitialConfigure(surfaceId: number): void;
  windowHasContent(surfaceId: number): Rect | undefined;
  unmapWindow(surfaceId: number): void;
  settled(): Promise<void>;
  // Topmost window containing the point. Walks the stack front-to-back.
  // The optional `accept` predicate is consulted on each candidate; when
  // it returns false, the search continues to the next window underneath.
  // Used by hit-testing to respect wl_surface input regions: when the
  // point is inside a window's rect but outside its input region, the
  // search falls through to the window below.
  windowAt(
    x: number, y: number,
    accept?: (win: Window, localX: number, localY: number) => boolean,
  ): Window | null;
  setInsets(surfaceId: number, insets: Insets): InsetGrant | undefined;
  outerRectOf(surfaceId: number): Rect | undefined;
  rectOf(surfaceId: number): Rect | undefined;
  // Which output the given window is laid out on. Undefined when the window
  // doesn't exist. The window.map emitter uses this to populate the event's
  // outputId field without taking a full snapshot.
  outputIdOf(surfaceId: number): number | undefined;
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

  // Set the floating rect for a window. Used by the pointer-grab path
  // to update geometry per motion event; bypasses the proposal pipeline
  // because per-frame interactive drags are continuous geometric
  // updates, not policy decisions. The window must be in 'floating'
  // presentation for the rect to take effect (otherwise the resolver
  // ignores it -- the rect is still stored for later transitions).
  // Triggers a relayout pass.
  setFloatingRect(surfaceId: number, rect: Rect): void;
  // Read a window's stored floating rect, or null if none.
  getFloatingRect(surfaceId: number): Rect | null;

  // Freeform per-window state bag. setState returns true if the value
  // actually changed (so the caller can decide whether to emit a change
  // event), false otherwise.
  setState(surfaceId: number, key: string, value: unknown): boolean;
  getState(surfaceId: number, key: string): unknown;
  deleteState(surfaceId: number, key: string): boolean;
  getStateAll(surfaceId: number): { [key: string]: unknown };

  getSnapshot(surfaceId: number): WindowSnapshot | null;
  listSnapshots(): WindowSnapshot[];

  // Surface ids of the mapped, non-minimized toplevels in stack order
  // (master-front; index 0 is the master). The basis for keyboard focus
  // cycling and the reorder ops.
  focusOrder(): number[];

  // Reorder the window list relative to one surface:
  //   'promote'    move it to the master slot (front of the list);
  //   'swap-next'  exchange it with the next toplevel toward the stack tail;
  //   'swap-prev'  exchange it with the previous toplevel toward the head.
  // Neighbours are chosen among focusOrder() windows (mapped, non-minimized).
  // swap-* do not wrap at the ends. Returns true and schedules a relayout +
  // restacks when the order changed; false (no-op) otherwise.
  reorder(surfaceId: number, op: "promote" | "swap-next" | "swap-prev"): boolean;

  // The protocol layer calls this on a toplevel's content commit, with the
  // highest configure serial the client has acked. It releases that window's
  // held resize (if its configured serial is satisfied) and applies the
  // transaction once every held window is ready. No-op when nothing is held
  // for the surface.
  notifyToplevelCommit(surfaceId: number, ackedSerial: number | null): void;
}

// Structured-clone-safe snapshot of a window's observable state. The shape
// that flows over the worker wire (sdk.windows.get / list) and the typed
// event payloads. surfaceRec / Resource are NOT included (not cloneable).
export interface WindowSnapshot {
  surfaceId: number;
  outputId: number;
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
  // Ordered per-output visible-window lists, master-front. Called at
  // snapshot() time; the result drives which windows the layout-driver
  // lays out on each output. The workspace plugin keeps the underlying
  // map in sync via setOutputStack; main.ts wires this callback to read
  // from state.outputToplevelStacks. Tests without a workspace plugin can
  // omit it -- the WM then defaults to "every mapped window on the
  // primary output" so non-workspace harnesses still produce a layout.
  outputContent?: () => ReadonlyMap<number, ReadonlyArray<number>>;
}

// Convenience: build the WM's per-output map from a list of descriptors,
// preserving iteration order so primaryOutputId() is deterministic when ids
// are unsorted.
function outputsMap(outputs: ReadonlyArray<WmOutput>): Map<number, WmOutput> {
  const m = new Map<number, WmOutput>();
  for (const o of outputs) m.set(o.id, { id: o.id, rect: { ...o.rect }, scale: o.scale });
  return m;
}

// Window state convenience helpers re-exported here so callers reading the
// WM module don't need a parallel events/types.js import.
export type { Presentation, WindowState, ProposalReason } from "../events/types.js";

// Per-handler ceiling for window.relayout + window.proposed interceptors.
const INTERCEPTOR_TIMEOUT_MS = 100;

export function createWm(
  compositor: CompositorSink,
  outputs: ReadonlyArray<WmOutput>,
  opts?: WmOptions,
): Wm {
  if (outputs.length === 0) {
    throw new Error("createWm: outputs must be non-empty");
  }
  const rebuild = opts?.rebuild;
  const configure = opts?.configure;
  const decorationResize = opts?.decorationResize;
  const layoutDriverFactory = opts?.layoutDriverFactory;
  const pluginBus = opts?.pluginBus;
  const outputContent = opts?.outputContent;
  const windows: Window[] = [];
  const wm: WmState = { outputs: outputsMap(outputs), windows };
  // The primary is the lowest live id; computed on demand to track setOutputs.
  function primaryOutputId(): number {
    let lo = Infinity;
    for (const id of wm.outputs.keys()) if (id < lo) lo = id;
    if (lo === Infinity) throw new Error("internal: WM has no outputs");
    return lo;
  }
  // Resolve an explicit/optional outputId to a concrete live id. Unknown ids
  // collapse to the primary; the WM never silently drops a window onto a
  // nonexistent output.
  function resolveOutputId(requested: number | undefined): number {
    if (requested === undefined) return primaryOutputId();
    if (wm.outputs.has(requested)) return requested;
    return primaryOutputId();
  }

  // Resize transaction (reorder relayouts only). A window that changes size must
  // not jump to its new tile before it has re-rendered at the new size, or it
  // flashes at the wrong size/position for a frame. Instead the new geometry is
  // HELD here: the window keeps its current drawn rect until it acks the
  // configure and commits a matching buffer, then every held window is applied
  // together in one batch (an atomic swap, so two windows trading places never
  // overlap). A timeout applies whatever is held if a client is slow. Repeated
  // reorders merge into the same held set, so a burst of swaps never flickers --
  // the drawn geometry only moves once the input settles and clients catch up.
  interface PendingResize {
    outer: Rect;
    content: Rect;
    // Serial of the configure last sent for this held size, or null for a
    // move-only hold (no re-render needed).
    serial: number | null;
    // The content size `serial` configured -- lets a merged reorder skip
    // re-configuring an already-asked size.
    cfgW: number;
    cfgH: number;
    // Move-only holds need no re-render and are always ready. A resize hold is
    // ready once the client has acked the configure AND the compositor reports
    // a drawable buffer at the new size (surfaceReadyAt) -- the latter matters
    // because dmabuf imports are async, so a commit alone doesn't mean drawable.
    moveOnly: boolean;
    acked: boolean;
  }
  const pendingResizes = new Map<number, PendingResize>();
  function pendingReady(id: number, p: PendingResize): boolean {
    if (p.moveOnly) return true;
    if (!p.acked) return false;
    return compositor.surfaceReadyAt
      ? compositor.surfaceReadyAt(id, p.content.width, p.content.height)
      : true;
  }
  let txTimer: ReturnType<typeof setTimeout> | null = null;
  const TX_TIMEOUT_MS = 150;

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

  function clearTxTimer(): void {
    if (txTimer !== null) { clearTimeout(txTimer); txTimer = null; }
  }

  // Push one window's held geometry to the compositor: content layout, the
  // decoration's outer layout, and the decoration-resize hook. Mirrors the
  // immediate apply path in applyLayout.
  function pushGeometry(win: Window, outer: Rect, content: Rect): void {
    const prevOuter = win.outer;
    win.outer = outer;
    win.rect = content;
    if (win.hasContent) {
      compositor.setSurfaceLayout(win.surfaceId, content.x, content.y, content.width, content.height);
    }
    const outerMoved = prevOuter.x !== outer.x || prevOuter.y !== outer.y
                    || prevOuter.width !== outer.width || prevOuter.height !== outer.height;
    if (win.decorationSurfaceId !== undefined && outerMoved) {
      compositor.setSurfaceLayout(win.decorationSurfaceId, outer.x, outer.y, outer.width, outer.height);
      if (decorationResize && win.insets) {
        decorationResize(win.surfaceId, { ...outer }, { ...content }, { ...win.insets });
      }
    }
  }

  // Apply every held window's geometry in one batch (atomic from the on-screen
  // point of view: a single render sees them all moved) and clear the
  // transaction.
  function applyPendingGeometry(): void {
    clearTxTimer();
    const entries = [...pendingResizes];
    pendingResizes.clear();
    for (const [id, p] of entries) {
      // Thaw (resume the live buffer) and set the new geometry in the same
      // batch, so the freshly-rendered content and the new size land together.
      compositor.thawSurface?.(id);
      const win = windows.find((w) => w.surfaceId === id);
      if (win) pushGeometry(win, p.outer, p.content);
    }
  }

  // Apply the held set once every member is ready (acked + committed its new
  // size, or move-only). A not-yet-ready member keeps the whole batch waiting.
  function maybeApplyTransaction(): void {
    if (pendingResizes.size === 0) { clearTxTimer(); return; }
    for (const [id, p] of pendingResizes) { if (!pendingReady(id, p)) return; }
    applyPendingGeometry();
  }

  function armTxTimer(): void {
    if (txTimer !== null) return;
    txTimer = setTimeout(() => { txTimer = null; applyPendingGeometry(); }, TX_TIMEOUT_MS);
    txTimer.unref?.();
  }

  // The compositor pokes this when a frozen surface's new buffer becomes
  // drawable; re-check whether the held batch can now apply.
  compositor.setFrozenReadyHandler?.((id) => {
    if (pendingResizes.has(id)) maybeApplyTransaction();
  });

  // Apply a LayoutResult: emit window.relayout, then update each window's
  // outer rect, push the compositor's setSurfaceLayout, fire configure where
  // size changed, and update bound decorations. For a "reorder" relayout the
  // geometry is routed through the resize transaction (held until the client
  // re-renders) instead of being applied immediately.
  async function applyLayout(result: LayoutResult, reason: LayoutReason): Promise<void> {
    const useTx = reason === "reorder" && !!configure;
    const byId = new Map<number, { id: number; outer: Rect }>();
    for (const r of result.rects) byId.set(r.id, r);
    const snapshotWindows = [...windows];
    let txTouched = false;
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

      const newContent = win.insets ? shrink(newOuter, win.insets) : { ...newOuter };
      const sizeChanged = newContent.width !== prevContent.width || newContent.height !== prevContent.height;
      const moved = prevOuter.x !== newOuter.x || prevOuter.y !== newOuter.y
                 || prevOuter.width !== newOuter.width || prevOuter.height !== newOuter.height;

      if (useTx && win.hasContent && !win.pendingInitialCommit) {
        // Transaction path: hold the new geometry; (re)configure on a size that
        // differs from what the client was last asked for. The window keeps its
        // current drawn rect until applyPendingGeometry.
        const pend = pendingResizes.get(win.surfaceId);
        const lastCfgW = pend ? pend.cfgW : prevContent.width;
        const lastCfgH = pend ? pend.cfgH : prevContent.height;
        if (newContent.width !== lastCfgW || newContent.height !== lastCfgH) {
          // configure is non-null here (useTx requires it); guard for the type.
          const serial = configure
            ? configure(win.surfaceId, newContent.width, newContent.height) : null;
          pendingResizes.set(win.surfaceId, {
            outer: newOuter, content: newContent,
            serial, cfgW: newContent.width, cfgH: newContent.height, moveOnly: false, acked: false,
          });
          // Hold the surface's current frame while it re-renders at the new size.
          compositor.freezeSurface?.(win.surfaceId);
          txTouched = true;
        } else if (pend) {
          pend.outer = newOuter;
          pend.content = newContent;
          txTouched = true;
        } else if (moved) {
          pendingResizes.set(win.surfaceId, {
            outer: newOuter, content: newContent, serial: null,
            cfgW: newContent.width, cfgH: newContent.height, moveOnly: true, acked: true,
          });
          txTouched = true;
        }
        continue;
      }

      // Immediate path (non-reorder reasons, or initial / not-yet-content
      // windows). Suppress configure during the deferred-initial-commit phase.
      if (!moved && !sizeChanged) continue;
      win.outer = newOuter;
      const content = contentOf(win);
      win.rect = content;
      if (win.hasContent) {
        compositor.setSurfaceLayout(win.surfaceId, content.x, content.y, content.width, content.height);
      }
      if (configure && !win.pendingInitialCommit && sizeChanged) {
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

    if (useTx) {
      // Drop holds for windows no longer in this layout result.
      for (const id of [...pendingResizes.keys()]) {
        if (!byId.has(id)) {
          pendingResizes.delete(id);
          compositor.thawSurface?.(id);
          txTouched = true;
        }
      }
      if (txTouched) {
        if ([...pendingResizes].some(([id, p]) => !pendingReady(id, p))) armTxTimer();
        maybeApplyTransaction();
      }
    }
  }

  // Build a LayoutSnapshot from the current WM state. The windows map
  // carries every mapped window keyed by surfaceId; outputContent (from the
  // workspace plugin via the WmOptions callback) drives which subset is
  // laid out on each output and in what order.
  function snapshot(): LayoutSnapshot {
    const windowMap = new Map<number, import("./layout-driver.js").LayoutSnapshotWindow>();
    for (const w of windows) {
      windowMap.set(w.surfaceId, {
        id: w.surfaceId,
        role: "toplevel" as const,
        outputId: w.outputId,
        presentation: w.windowState.presentation,
        layoutMode: w.windowState.layoutMode ?? undefined,
        layoutData: w.windowState.layoutData,
        constraints: {
          minSize: w.windowState.constraints.minSize ?? undefined,
          maxSize: w.windowState.constraints.maxSize ?? undefined,
        },
        currentRect: { ...w.outer },
        ...(w.floatingRect ? { floatingRect: { ...w.floatingRect } } : {}),
        ...(w.windowState.restoreRect ? { restoreRect: { ...w.windowState.restoreRect } } : {}),
      });
    }
    const outputDescs: Array<{ id: number; rect: Rect; scale: number }> = [];
    for (const o of wm.outputs.values()) {
      outputDescs.push({ id: o.id, rect: { ...o.rect }, scale: o.scale });
    }
    // Workspace plugin's view, or a fallback when no plugin is wired:
    // every known window on the primary output, in master-front insertion
    // order. The fallback keeps GPU-free tests (no workspace plugin) and
    // pre-workspace bring-up paths producing a layout. Pre-content windows
    // are included so their rect is ready by the time their first commit
    // lands (windowHasContent just flips the gate; no relayout needed).
    let content: ReadonlyMap<number, ReadonlyArray<number>>;
    if (outputContent) {
      content = outputContent();
    } else {
      const ids = windows.map((w) => w.surfaceId);
      const m = new Map<number, ReadonlyArray<number>>();
      if (ids.length > 0) m.set(primaryOutputId(), ids);
      content = m;
    }
    return { outputs: outputDescs, windows: windowMap, outputContent: content };
  }

  const target: LayoutApplyTarget = { apply: applyLayout };
  const driver: LayoutDriver = layoutDriverFactory
    ? layoutDriverFactory(target, snapshot)
    : { schedule: () => { /* no-op */ }, settled: () => Promise.resolve() };

  return {
    state: wm,

    schedule(reason) {
      driver.schedule(reason);
    },

    addWindow(surfaceId, surfaceRec, opts) {
      const existing = windows.find((w) => w.surfaceId === surfaceId);
      if (existing) return contentOf(existing);
      const win: Window = {
        surfaceId,
        outputId: resolveOutputId(opts?.outputId),
        outer: { x: 0, y: 0, width: -1, height: -1 },
        rect: { x: 0, y: 0, width: -1, height: -1 },
        surfaceRec,
        windowState: defaultWindowState(),
        state: new Map<string, unknown>(),
      };
      if (opts?.deferInitialCommit) win.pendingInitialCommit = true;
      windows.unshift(win);
      driver.schedule("mapped");
      return win.rect;
    },

    primaryOutputId,

    setOutputs(newOutputs) {
      if (newOutputs.length === 0) {
        throw new Error("setOutputs: outputs must be non-empty");
      }
      wm.outputs = outputsMap(newOutputs);
      // Reassign any window whose output disappeared. The new primary takes
      // them; their outer rect will be reflowed when the layout pass runs.
      const primary = primaryOutputId();
      for (const w of windows) {
        if (!wm.outputs.has(w.outputId)) w.outputId = primary;
      }
      driver.schedule("output-resized");
    },

    setWindowOutput(surfaceId, outputId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return;
      if (!wm.outputs.has(outputId)) return;
      if (win.outputId === outputId) return;
      win.outputId = outputId;
      driver.schedule("state-changed");
    },

    windowHasContent(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      if (!win.hasContent) {
        win.hasContent = true;
        compositor.setSurfaceLayout(win.surfaceId, win.rect.x, win.rect.y, win.rect.width, win.rect.height);
        pushStack();
        // Real tile size as the second configure (a resize) after the throwaway
        // 0x0 sent at the initial commit. See pendingSizeConfigure.
        if (win.pendingSizeConfigure && configure) {
          win.pendingSizeConfigure = false;
          const content = contentOf(win);
          configure(win.surfaceId, content.width, content.height);
        }
      }
      return { ...win.rect };
    },

    unmapWindow(surfaceId) {
      const i = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (i < 0) return;
      windows.splice(i, 1);
      if (pendingResizes.delete(surfaceId)) { compositor.thawSurface?.(surfaceId); maybeApplyTransaction(); }
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

    outputIdOf(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win?.outputId;
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

    windowAt(x, y, accept) {
      // Hit-test the visible windows only. The workspace plugin's per-output
      // ordered list (outputContent) drives visibility; without it, fall back
      // to every WM window (test harnesses without a workspace plugin). The
      // master-front order is preserved: index 0 of an output's list is the
      // master, which in dwm-style tilers is typically the visually on-top
      // window of its tile region. (For non-overlapping tiled layouts the
      // master-front order matches hit-test order; floating windows on top
      // are at index 0 by layout-plugin convention.)
      const content = outputContent ? outputContent() : null;
      if (content) {
        for (const ids of content.values()) {
          for (const id of ids) {
            const win = windows.find((w) => w.surfaceId === id);
            if (!win) continue;
            const r = win.rect;
            if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) continue;
            if (accept) {
              const localX = x - r.x;
              const localY = y - r.y;
              if (!accept(win, localX, localY)) continue;
            }
            return win;
          }
        }
        return null;
      }
      // No workspace plugin: walk every window in declared order.
      for (let i = 0; i < windows.length; i++) {
        const win = windows[i];
        const r = win.rect;
        if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) continue;
        if (accept) {
          const localX = x - r.x;
          const localY = y - r.y;
          if (!accept(win, localX, localY)) continue;
        }
        return win;
      }
      return null;
    },

    async propose(surfaceId, proposal, reason) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return null;
      // Before the initial commit, the throwaway 0x0 first configure is sent
      // SYNCHRONOUSLY (sendInitialConfigure) and its states array is read from
      // win.windowState. A set_maximized / set_fullscreen that arrived in the
      // same wayland-batch goes through this async pipeline, which only writes
      // windowState after a microtask hop -- too late for that first configure.
      // Stamp the client-declared presentation synchronously so the first
      // configure carries it; the async pass below still runs the
      // proposed-interceptor + layout for the sized second configure.
      if (win.pendingInitialCommit && proposal.presentation !== undefined) {
        win.windowState = { ...win.windowState, presentation: proposal.presentation };
      }
      // Serialize against any in-flight mutation on this window so a
      // second caller doesn't read stale state mid-microtask. Two
      // requests in the same wayland-batch (e.g. set_maximized then
      // initial commit) would otherwise race on win.windowState.
      const prior = win.pendingMutation;
      let resolveSelf!: () => void;
      win.pendingMutation = new Promise<void>((res) => { resolveSelf = res; });
      try {
        if (prior) await prior;
        if (!windows.includes(win)) return null;

        const current = cloneState(win.windowState);
        let candidate = mergeProposal(current, proposal);
        const wasFloating = current.presentation === "floating";
        const becomingFloating = candidate.presentation === "floating";

        if (pluginBus) {
          const initial: WindowProposedEvent = {
            surfaceId, reason, current,
            candidate: cloneState(candidate),
          };
          const finalPayload = await pluginBus.emit(WINDOW_EVENT.proposed, initial,
            { timeoutMs: INTERCEPTOR_TIMEOUT_MS });
          if (!windows.includes(win)) return null;
          const ev = finalPayload as WindowProposedEvent | undefined;
          const modified = ev ? validateState(ev.candidate) : null;
          if (modified) candidate = cloneState(modified);
        }

        const changed = diffState(current, candidate);
        if (changed.length === 0) return cloneState(current);

        // Capture the initial floating rect when a window enters
        // 'floating' for the first time. The window stays visually in
        // place across the transition: its current outer becomes the
        // floating rect.
        if (!wasFloating && becomingFloating && win.floatingRect === undefined) {
          win.floatingRect = { ...win.outer };
        }

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

        if (changed.some((f) => GEOMETRY_FIELDS.includes(f))) {
          driver.schedule("state-changed");
        }
        return cloneState(candidate);
      } finally {
        resolveSelf();
      }
    },

    sendInitialConfigure(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win || !win.pendingInitialCommit || win.pendingSizeConfigure) return;
      if (configure) {
        configure(win.surfaceId, 0, 0);
        win.pendingSizeConfigure = true;
      }
    },

    async markInitialCommitComplete(surfaceId, info) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win || !win.pendingInitialCommit) return;
      // Serialize like propose -- any in-flight proposes (e.g.
      // set_maximized called between get_toplevel and the initial
      // commit) must commit before we read state.
      const prior = win.pendingMutation;
      let resolveSelf!: () => void;
      win.pendingMutation = new Promise<void>((res) => { resolveSelf = res; });
      try {
        if (prior) await prior;
        if (!windows.includes(win) || !win.pendingInitialCommit) return;

        let finalState: WindowState = cloneState(win.windowState);
        if (pluginBus) {
          const initial: WindowPreconfigureEvent = {
            surfaceId,
            appId: info.appId, title: info.title,
            initialState: cloneState(win.windowState),
          };
          const finalPayload = await pluginBus.emit(WINDOW_EVENT.preconfigure, initial,
            { timeoutMs: INTERCEPTOR_TIMEOUT_MS });
          if (!windows.includes(win)) return;
          const ev = finalPayload as WindowPreconfigureEvent | undefined;
          const modified = ev ? validateState(ev.initialState) : null;
          if (modified) finalState = cloneState(modified);
        }

        const previous = cloneState(win.windowState);
        const changed = diffState(previous, finalState);
        if (changed.length > 0) {
          win.windowState = finalState;
          if (pluginBus) {
            const ev: WindowCommittedEvent = {
              surfaceId, reason: "window-rule",
              previous,
              current: cloneState(finalState),
              changed: [...changed],
            };
            pluginBus.emit(WINDOW_EVENT.committed, ev);
          }
        }

        // Clear the flag BEFORE scheduling so the configure suppression
        // in applyLayout doesn't fire for the post-rule pass.
        win.pendingInitialCommit = false;

        if (changed.some((f) => GEOMETRY_FIELDS.includes(f))) {
          driver.schedule("state-changed");
        }
        // Always await settled before the forced configure: a prior
        // propose may have scheduled a layout pass we haven't picked up
        // yet; without this, the configure fires with a stale rect (the
        // placeholder -1,-1 from addWindow if the pass hasn't run, or
        // the pre-state-change rect if it has).
        await driver.settled();
        if (!windows.includes(win)) return;

        // The throwaway 0x0 first configure is normally sent synchronously by
        // sendInitialConfigure (in the initial-commit dispatch) so a
        // single-roundtrip client sees it. Send it here only as a fallback --
        // e.g. a direct test caller, or if no configure had gone out yet. The
        // real tile size follows as a SECOND configure from windowHasContent
        // once the client has content (a resize). The 0x0 carries the resolved
        // state array (maximized/tiled) so the client knows it is tiled.
        if (configure && !win.pendingSizeConfigure) {
          configure(win.surfaceId, 0, 0);
          win.pendingSizeConfigure = true;
        }
      } finally {
        resolveSelf();
      }
    },

    getWindowState(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win ? cloneState(win.windowState) : null;
    },

    setFloatingRect(surfaceId, rect) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return;
      win.floatingRect = { ...rect };
      // Boundary-crossing: if the rect's center now lies inside a different
      // output's rect, reassign. Using the center (rather than full-
      // containment) keeps the reassignment well-defined for a window whose
      // rect straddles two outputs -- the dominant output owns it.
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      let target = win.outputId;
      for (const o of wm.outputs.values()) {
        const r = o.rect;
        if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) {
          target = o.id;
          break;
        }
      }
      if (target !== win.outputId) win.outputId = target;
      driver.schedule("state-changed");
    },

    getFloatingRect(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win?.floatingRect ? { ...win.floatingRect } : null;
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

    focusOrder() {
      // Visible windows only, master-front per output (workspace plugin's
      // ordering). Across outputs we walk by ascending outputId for a
      // deterministic enumeration. Fall back to every WM window when no
      // workspace plugin is wired.
      const out: number[] = [];
      const content = outputContent ? outputContent() : null;
      if (content) {
        const ordered = [...content.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, ids] of ordered) {
          for (const id of ids) {
            const win = windows.find((w) => w.surfaceId === id);
            if (!win) continue;
            if (win.hasContent && win.windowState.presentation !== "minimized") {
              out.push(win.surfaceId);
            }
          }
        }
        return out;
      }
      for (const w of windows) {
        if (w.hasContent && w.windowState.presentation !== "minimized") {
          out.push(w.surfaceId);
        }
      }
      return out;
    },

    reorder(surfaceId, op) {
      const idx = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (idx < 0) return false;

      if (op === "promote") {
        if (idx === 0) return false;
        const [win] = windows.splice(idx, 1);
        windows.unshift(win);
        driver.schedule("reorder");
        pushStack();
        return true;
      }

      // swap-next / swap-prev: swap with the adjacent focusable neighbour.
      // Build the focusable subset's array indices so a contentless or
      // minimized window between two tiles isn't treated as a neighbour.
      const focusable: number[] = [];
      for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        if (w.hasContent && w.windowState.presentation !== "minimized") focusable.push(i);
      }
      const pos = focusable.indexOf(idx);
      if (pos < 0) return false;
      const neighbourPos = op === "swap-next" ? pos + 1 : pos - 1;
      if (neighbourPos < 0 || neighbourPos >= focusable.length) return false;
      const j = focusable[neighbourPos];
      [windows[idx], windows[j]] = [windows[j], windows[idx]];
      driver.schedule("reorder");
      pushStack();
      return true;
    },

    notifyToplevelCommit(surfaceId, ackedSerial) {
      const p = pendingResizes.get(surfaceId);
      if (!p || p.moveOnly || p.acked) return;
      if (p.serial !== null && ackedSerial !== null && ackedSerial >= p.serial) {
        p.acked = true;
        maybeApplyTransaction();
      }
    },
  };
}

function snapshotOf(win: Window): WindowSnapshot {
  const state: { [key: string]: unknown } = {};
  for (const [k, v] of win.state.entries()) state[k] = v;
  const snap: WindowSnapshot = {
    surfaceId: win.surfaceId,
    outputId: win.outputId,
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
