// Window manager state holder (durable).
//
// Owns the window list + stacking order and pushes layout/stack to the
// compositor sink. The geometry policy (where windows go) lives in
// layout-driver.ts (the resolver) + the bundled layout plugin. The
// behavioral state of each window (tiling, exclusive, visible, layoutMode,
// constraints, parent, clientRequests) lives here, mutated through
// propose().
//
// propose() is the single entry point for behavioral-state changes. It
// emits 'window.proposed' (interceptable), commits the final candidate,
// emits 'window.committed' (observe-only), and schedules a relayout when
// geometry-affecting fields changed.
//
// Structural operations (addWindow, unmapWindow, setInsets, etc.) stay
// direct calls because they manage membership and decoration, not state.

import type { Resource } from "../types.js";
import { log as coreLog } from "../log.js";
import type { CompositorSink } from "../protocols/ctx.js";
import type { LayoutResult, LayoutReason } from "@overdraw/layout-types";
import type { LayoutDriver, LayoutSnapshot, LayoutApplyTarget } from "./layout-driver.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import { WINDOW_EVENT, STACK_EVENT } from "../events/types.js";
import {
  createSurfaceTransactionBroker,
  type SurfaceTransactionBroker,
} from "../surface-transaction.js";
import type {
  WindowRelayoutEvent,
  StackRelayoutEvent,
  WindowState,
  Tiling,
  Exclusive,
  ClientRequests,
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
  // Z-order index inside the compositor's content layer (higher = on
  // top). Tiled toplevels share a single z value (they don't overlap,
  // so internal order is irrelevant; one click raises the whole
  // tiled stack together). Floating windows each get their own z >=
  // the tiled value; modal dialogs sit at z > their parent. See
  // raiseWindow() for the maintenance rules; computeBaseStack sorts
  // by ascending z to build the draw stack.
  z: number;
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
  // Content gating: the window is held out of the draw stack as long as
  // this set is non-empty. Multiple owners can engage independently
  // (decoration broker waits for first decoration frame; opening driver
  // waits for the opening-animation plugin to release after setting
  // initial transform/opacity). Each owner uses a distinct string key
  // and is responsible for its own release; the gate clears only when
  // every owner has released.
  contentGateOwners?: Set<string>;
  // True once the client has committed presentable content (the map-on-first-
  // content signal). A window is in the layout (and configured) from addWindow,
  // but only drawn once it has content.
  hasContent?: boolean;
  // The client's window-type prefers floating (X11 _NET_WM_WINDOW_TYPE
  // splash/dialog/utility). Stamped from propose(); consumed by the
  // default-floating policy at first content, alongside parent/fixed-size.
  floatByType?: boolean;
  // Highest xdg_surface.ack_configure serial the client has acked (from
  // notifyToplevelCommit). Used by the open path to detect the mapping commit.
  lastAckedSerial?: number;
  // Set while the open is held waiting for the client to ack the latest
  // configure serial sent before map (so the first drawn frame is a buffer
  // rendered at the tile size, not the client's default from the 0x0 handshake).
  // Released by notifyToplevelCommit when the ack lands, or by a backstop timer.
  awaitingMapAck?: boolean;
  // The output the window is currently placed on, cached after each
  // applyLayout pass. window.relayout / stack.relayout consumers see this
  // as `oldOutputId` (the prior placement). Updated to the new output at
  // the end of each pass. null = unplaced (e.g. workspace plugin hasn't
  // claimed it for any output yet).
  outputId?: number | null;
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
    tiling: "managed",
    exclusive: "none",
    visible: true,
    modal: false,
    clientRequests: {
      wantsMaximized: false,
      wantsFullscreen: false,
      wantsMinimized: false,
      wantsModal: false,
    },
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

// Configure sink: ask the protocol layer to (re)configure a window to a
// content rect. Position is carried for the xwayland case (the X window
// needs to be moved AND resized on the wire); the xdg path ignores position
// and just sends the size in xdg_toplevel.configure. Returns a serial number
// for the xdg case (so the WM's resize transaction can match the client's
// ack), or null when no ack is expected -- xwayland (no ack_configure
// equivalent) or no-op cases. Wired by installProtocols.
export type ConfigureFn = (
  surfaceId: number,
  x: number, y: number,
  contentW: number, contentH: number,
) => number | null;

// Pure-move sink: a window changed root position without resizing. For xdg
// this is a no-op (xdg-shell hides position from clients); for xwayland the
// X client expects a ConfigureNotify telling it the new root coords. Wired
// by installProtocols alongside ConfigureFn.
export type ConfigureMoveFn = (
  surfaceId: number,
  x: number, y: number,
  contentW: number, contentH: number,
) => void;

// Bundle the two; the WM holds one ConfigureSink and calls .configure on
// size-change paths, .configureMove on pure-move paths.
export interface ConfigureSink {
  configure: ConfigureFn;
  configureMove: ConfigureMoveFn;
}

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
//
// `tiling`, `exclusive`, `visible` are the compositor's decisions; a plugin
// (or core) writes them directly. Client requests (xdg_toplevel.set_*)
// arrive as `clientRequests` and go through resolveDecisions() to become
// decision-axis writes.
export interface WindowStateProposal {
  tiling?: Tiling;
  exclusive?: Exclusive;
  visible?: boolean;
  modal?: boolean;
  clientRequests?: Partial<ClientRequests>;
  layoutMode?: string | null;
  layoutData?: unknown;
  constraints?: {
    minSize?: { width: number; height: number } | null;
    maxSize?: { width: number; height: number } | null;
  };
  parent?: number | null;
  // A structural hint (like `parent`/`constraints`), not a decision axis: the
  // client's window-type prefers floating. See Window.floatByType.
  floatByType?: boolean;
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
  // installs when no real output exists). Schedules an output-resized
  // relayout. Rehoming windows stranded on a removed output is NOT done
  // here: window->output placement is the workspace plugin's domain (see
  // addWindow below); its output.removed handling migrates the orphaned
  // workspaces before/alongside this call.
  setOutputs(outputs: ReadonlyArray<WmOutput>): void;
  // Replace the explicit island set the layout-driver iterates
  // (docs/canvas-design.md §5). null reverts to the implicit one-island-
  // per-output derivation from outputContent. Schedules a relayout when
  // the set actually changed; returns whether it did. The workspace-
  // namespace plugin is the single writer (via windows.set-islands).
  setIslands(
    islands: ReadonlyArray<import("./layout-driver.js").LayoutIsland> | null,
  ): boolean;
  // The id of the primary output -- the lowest id in state.outputs, used as
  // the default home for newly-mapped windows. Throws if the WM has no
  // outputs (the construction invariant forbids this).
  primaryOutputId(): number;
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
  //
  // The WM does NOT track "which output is this window on" -- that is the
  // workspace plugin's domain (the layout-driver reads ordered visible
  // windows per output from outputContent). The output a newly-mapped
  // window lands on is decided in the protocol layer (xdg_surface.get_
  // toplevel: spawn-follows-pointer) and carried in the window.map event
  // payload to the workspace plugin's onMap handler.
  addWindow(
    surfaceId: number,
    surfaceRec: SurfaceHandle,
    opts?: { deferInitialCommit?: boolean },
  ): Rect;
  // Mark the initial-commit phase complete for a deferred window: emit
  // window.proposed with the accumulated state as the candidate so a
  // window-rules plugin can intercept, commit any modifications, and force
  // a configure with the resolved content size. No-op when the window
  // doesn't exist or wasn't in the deferred-commit phase.
  //
  // Carries appId + title in the emitted event so window-rules plugins can
  // dispatch off them. The caller (wl_surface.commit when it detects an
  // initial commit) supplies them. The window is placed into a workspace at
  // first content (windowHasContent), not here, so its tiling lane is
  // resolved before it enters the layout.
  markInitialCommitComplete(
    surfaceId: number,
    info: { appId: string | null; title: string | null; xwayland?: boolean },
  ): Promise<void>;
  // Synchronously send the throwaway 0x0 first configure (with the resolved
  // state array) so the xdg-shell handshake completes within the client's
  // initial-commit dispatch. Sets pendingSizeConfigure so the real tile size
  // follows as a second configure. No-op if the window isn't in the
  // deferred-initial-commit phase or already got its first configure.
  sendInitialConfigure(surfaceId: number): void;
  // contentSize: the client's natural content size at first content (its
  // committed window geometry, else its buffer in logical px). A window that
  // resolves to floating is sized from it (clamped to min/max) so it renders
  // 1:1 instead of being stretched into a compositor-chosen rect.
  windowHasContent(surfaceId: number, contentSize?: { width: number; height: number }): Rect | undefined;
  unmapWindow(surfaceId: number, opts?: { phantomSurfaceId?: number }): void;
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
  // Engage the content gate for `surfaceId` under `owner`. While any
  // owner is engaged, the window is held out of the draw stack. Each
  // owner is a distinct string key (e.g. "decoration", "opening");
  // calling engage twice with the same key is idempotent.
  engageContentGate(surfaceId: number, owner: string): void;
  // Release `owner`'s hold on the content gate. The window enters the
  // draw stack only when EVERY owner has released. Calling release
  // for an owner that wasn't engaged is a no-op (idempotent).
  releaseContentGate(surfaceId: number, owner: string): void;
  // True iff at least one owner is currently holding the gate.
  isContentGated(surfaceId: number): boolean;
  setDecorationSurface(windowId: number, decoSurfaceId: number | null): void;

  // Raise a window to the top of its z-bucket. If the target is a
  // modal dialog (windowState.parent != null), the raise redirects up
  // the modal chain to the first non-modal ancestor; that ancestor is
  // raised, and the modal subtree below it (this dialog plus any
  // nested modals) is renormalized to stay above. Click-to-raise
  // calls this; focus changes do NOT (focus and raise are decoupled).
  // No-op when the window doesn't exist.
  raiseWindow(surfaceId: number): void;

  // Raise every floating window above the tiled stack, preserving the
  // floating windows' relative order. Tiled windows share one z, so
  // raising a tiled window lifts the whole tile stack over the floating
  // layer; this reverses that, bringing all floating windows back on top.
  // No-op when there are no floating windows.
  raiseAllFloating(): void;

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
  // updates, not policy decisions. The window must be in the floating
  // lane (tiling === "floating") and non-exclusive for the rect to
  // take effect (otherwise the resolver ignores it -- the rect is
  // still stored for later transitions). Triggers a relayout pass.
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
  // The output the window is currently placed on (cached after each layout
  // pass). null = unplaced (no layout pass has assigned it yet).
  outputId: number | null;
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

// True iff at least one owner is currently holding the content gate.
function isGated(win: Window): boolean {
  return win.contentGateOwners !== undefined && win.contentGateOwners.size > 0;
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
    tiling: s.tiling,
    exclusive: s.exclusive,
    visible: s.visible,
    modal: s.modal,
    clientRequests: { ...s.clientRequests },
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
  if (o.tiling !== "managed" && o.tiling !== "floating") return null;
  if (o.exclusive !== "none" && o.exclusive !== "maximized" && o.exclusive !== "fullscreen") return null;
  if (typeof o.visible !== "boolean") return null;
  if (typeof o.modal !== "boolean") return null;
  const cr = o.clientRequests;
  if (typeof cr !== "object" || cr === null) return null;
  const crr = cr as { [k: string]: unknown };
  for (const k of ["wantsMaximized", "wantsFullscreen", "wantsMinimized", "wantsModal"] as const) {
    if (typeof crr[k] !== "boolean") return null;
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
  "tiling", "exclusive", "visible", "layoutMode", "layoutData", "constraints",
];

// Fields whose change requires a stacking pass (z-recompute + raise of any
// child chains). Disjoint from GEOMETRY_FIELDS so a stacking-only change
// (e.g. set_modal post-content) doesn't trigger a full relayout.
const STACKING_FIELDS: ReadonlyArray<keyof WindowState> = [
  "parent", "modal",
];

// Diff two WindowState values; returns the list of differing field names.
function diffState(prev: WindowState, next: WindowState): Array<keyof WindowState> {
  const out: Array<keyof WindowState> = [];
  if (prev.tiling !== next.tiling) out.push("tiling");
  if (prev.exclusive !== next.exclusive) out.push("exclusive");
  if (prev.visible !== next.visible) out.push("visible");
  if (prev.modal !== next.modal) out.push("modal");
  if (!clientRequestsEqual(prev.clientRequests, next.clientRequests)) out.push("clientRequests");
  if (prev.layoutMode !== next.layoutMode) out.push("layoutMode");
  // layoutData identity-compare; plugins are expected to replace, not mutate.
  if (prev.layoutData !== next.layoutData) out.push("layoutData");
  if (!constraintsEqual(prev.constraints, next.constraints)) out.push("constraints");
  if (prev.parent !== next.parent) out.push("parent");
  if (!restoreRectEqual(prev.restoreRect, next.restoreRect)) out.push("restoreRect");
  return out;
}

function clientRequestsEqual(a: ClientRequests, b: ClientRequests): boolean {
  return a.wantsMaximized === b.wantsMaximized
      && a.wantsFullscreen === b.wantsFullscreen
      && a.wantsMinimized === b.wantsMinimized
      && a.wantsModal === b.wantsModal;
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
  if (p.tiling !== undefined) next.tiling = p.tiling;
  if (p.exclusive !== undefined) next.exclusive = p.exclusive;
  if (p.visible !== undefined) next.visible = p.visible;
  if (p.modal !== undefined) next.modal = p.modal;
  if (p.clientRequests !== undefined) {
    if (p.clientRequests.wantsMaximized !== undefined) {
      next.clientRequests.wantsMaximized = p.clientRequests.wantsMaximized;
    }
    if (p.clientRequests.wantsFullscreen !== undefined) {
      next.clientRequests.wantsFullscreen = p.clientRequests.wantsFullscreen;
    }
    if (p.clientRequests.wantsMinimized !== undefined) {
      next.clientRequests.wantsMinimized = p.clientRequests.wantsMinimized;
    }
    if (p.clientRequests.wantsModal !== undefined) {
      next.clientRequests.wantsModal = p.clientRequests.wantsModal;
    }
  }
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

// Apply the default policy that maps clientRequests onto the decision axes.
// This runs AFTER the proposed-interceptor chain (so a plugin sees the
// post-merge candidate including the new clientRequests and may pre-empt
// the resolution by writing tiling/exclusive/visible directly). The
// candidate passed in here is the one the WM is about to commit; the
// returned state reflects the policy-resolved decisions.
//
// `phase` distinguishes pre-first-content from post-first-content. Pre-
// content `wantsMaximized` is suppressed by default (the GTK boilerplate
// case the doc calls out); post-content set_maximized is honored.
//
// Plugins that want full control of this logic intercept window.proposed
// and write the decision axes directly; resolveDecisions only fills the
// gap when the proposal's diff is on clientRequests alone.
type PolicyPhase = "pre-content" | "post-content";

function resolveDecisions(
  prev: WindowState,
  candidate: WindowState,
  phase: PolicyPhase,
): WindowState {
  const out = cloneState(candidate);
  const prevReq = prev.clientRequests;
  const req = candidate.clientRequests;
  const decisionDirectlySet =
    prev.tiling !== candidate.tiling
    || prev.exclusive !== candidate.exclusive
    || prev.visible !== candidate.visible
    || prev.modal !== candidate.modal;
  if (decisionDirectlySet) return out;

  // wantsFullscreen wins over wantsMaximized (matches EWMH precedence).
  if (req.wantsFullscreen !== prevReq.wantsFullscreen) {
    out.exclusive = req.wantsFullscreen ? "fullscreen" : "none";
  } else if (req.wantsMaximized !== prevReq.wantsMaximized) {
    if (req.wantsMaximized) {
      // Default policy: pre-content set_maximized from a client is
      // suppressed (GTK/Qt startup boilerplate that demands maximize
      // before the user has seen the window). A window-rules plugin
      // intercepting window.preconfigure may override.
      if (phase === "post-content") out.exclusive = "maximized";
    } else if (out.exclusive === "maximized") {
      out.exclusive = "none";
    }
  }

  if (req.wantsMinimized !== prevReq.wantsMinimized) {
    // wantsMinimized is only honored post-content (a window can't be
    // minimized before it exists). On unset, restore visibility.
    if (req.wantsMinimized) {
      if (phase === "post-content") out.visible = false;
    } else {
      out.visible = true;
    }
  }

  // wantsModal is honored at both phases. xdg_dialog_v1 is the typical
  // source; a window-rules plugin may pre-empt by writing `modal`
  // directly (caught by the decisionDirectlySet guard above).
  if (req.wantsModal !== prevReq.wantsModal) {
    out.modal = req.wantsModal;
  }

  return out;
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
  // Optional shared surface-transaction broker. When provided, the WM
  // routes its resize-tx through it (and the cross-output handler shares
  // the same broker so holds on a single surface from both sources
  // coexist). When absent, the WM constructs an internal broker -- fine
  // for GPU-free unit tests that build a WM standalone.
  surfaceTx?: SurfaceTransactionBroker;
  // Focus driver hook for modal tethering. When a modal child takes
  // effect (modal map, or modal=true transition on a live window) and
  // the focused window is in the modal's parent chain, the WM calls
  // this with the modal's surfaceId so the seat hands keyboard focus
  // over. Symmetrically on modal close / modal=false transition: the
  // WM calls back with the parent's surfaceId. Tests / harnesses that
  // don't wire a seat can omit it (focus tethering is then a no-op).
  // The hook returns the surfaceId that currently has keyboard focus
  // (null when no focus), so the WM can check whether tethering is
  // needed at all. requestFocus(id) applies focus.
  currentFocusedSurfaceId?: () => number | null;
  requestFocus?: (surfaceId: number | null) => void;
  // Opening-driver hook: called at the first-content edge of a mapped
  // toplevel, after the window is added to the WM and its rect is
  // assigned but BEFORE pushStack. Should return true if the
  // window's appearance was claimed by a plugin (the driver engaged
  // the content gate via setContentGated; pushStack will skip it
  // until the gate clears). Return false (or omit the hook) for the
  // instant-map default. Tests / harnesses that don't wire a runtime
  // omit it; map is then always instant.
  beforeMap?: (surfaceId: number) => boolean;
  // Side-effect-free predicate: is an open ANIMATION active (a 'window-opening'
  // plugin registered)? The map-ack hold (wait for the client to ack the
  // tile-size configure before mapping) only engages when this is true, so a
  // window with no open animation maps immediately. Omitted -> never hold.
  hasOpeningAnimation?: () => boolean;
}

// Convenience: build the WM's per-output map from a list of descriptors,
// preserving iteration order so primaryOutputId() is deterministic when ids
// are unsorted.
function outputsMap(outputs: ReadonlyArray<WmOutput>): Map<number, WmOutput> {
  const m = new Map<number, WmOutput>();
  for (const o of outputs) m.set(o.id, { id: o.id, rect: { ...o.rect }, scale: o.scale });
  return m;
}

// Resolve the output a (mapped) parent toplevel is currently on, by
// scanning the workspace plugin's outputContent map for its surfaceId.
// Returns null when the parent is unknown, not yet placed, or no
// workspace plugin is wired.
function resolveParentOutputId(
  parentSurfaceId: number | null,
  outputContent: (() => ReadonlyMap<number, ReadonlyArray<number>>) | undefined,
): number | null {
  if (parentSurfaceId === null || !outputContent) return null;
  const content = outputContent();
  for (const [outputId, ids] of content) {
    if (ids.includes(parentSurfaceId)) return outputId;
  }
  return null;
}

// Window state convenience helpers re-exported here so callers reading the
// WM module don't need a parallel events/types.js import.
export type {
  Tiling, Exclusive, ClientRequests, WindowState, ProposalReason,
} from "../events/types.js";

// Re-exported for the test that wants to assert modal-tether behavior
// against a known modal. Internal helpers (childrenOf, rootOfChain,
// raiseStackedDescendants, topmostModalDescendant) are not exported;
// tests exercise them through the public surface (propose / raiseWindow
// / windowAt).

// Per-handler ceiling for window.relayout + window.proposed interceptors.
const INTERCEPTOR_TIMEOUT_MS = 100;

// Backstop for the open map-ack hold: map a window even if it never acks the
// tile-size configure, so a buggy client can't stay invisible indefinitely.
const MAP_ACK_BACKSTOP_MS = 500;

export function createWm(
  compositor: CompositorSink,
  outputs: ReadonlyArray<WmOutput>,
  opts?: WmOptions,
): Wm {
  if (outputs.length === 0) {
    throw new Error("createWm: outputs must be non-empty");
  }
  const rebuild = opts?.rebuild;
  // The last (size) configure serial sent to each surface, captured by wrapping
  // the configure sink. The open path uses it to find a window's "mapping
  // commit": the first client commit that acks the latest serial we sent while
  // the window was still unmapped is the buffer rendered for our tile size; we
  // hold the open animation until then so it never plays on a stale-size buffer.
  const lastConfigureSerial = new Map<number, number>();
  const rawConfigure = opts?.configure;
  const configure: ConfigureSink | undefined = rawConfigure
    ? {
        configure: (id, x, y, w, h) => {
          const serial = rawConfigure.configure(id, x, y, w, h);
          if (serial !== null) lastConfigureSerial.set(id, serial);
          return serial;
        },
        configureMove: rawConfigure.configureMove,
      }
    : undefined;
  const decorationResize = opts?.decorationResize;
  const layoutDriverFactory = opts?.layoutDriverFactory;
  const pluginBus = opts?.pluginBus;
  const outputContent = opts?.outputContent;
  const currentFocusedSurfaceId = opts?.currentFocusedSurfaceId;
  const requestFocus = opts?.requestFocus;
  const beforeMap = opts?.beforeMap;
  const hasOpeningAnimation = opts?.hasOpeningAnimation;
  // Shared broker if one was provided; otherwise a private one wired to
  // this compositor sink. The broker absorbs freeze/thaw/timer/frozen-
  // ready plumbing; the WM keeps the resize-specific data (configure
  // serial, target size, etc.) in pendingResizes.
  const surfaceTx: SurfaceTransactionBroker = opts?.surfaceTx
    ?? createSurfaceTransactionBroker(compositor);
  // Per-surface backstop timers for the map-ack hold: if a client never acks
  // the tile-size configure, map it anyway after this so a buggy client can't
  // stay invisible forever.
  const mapAckBackstops = new Map<number, ReturnType<typeof setTimeout>>();
  const windows: Window[] = [];
  const wm: WmState = { outputs: outputsMap(outputs), windows };

  // Z-order state. tiledZ is the single z value shared by every
  // tiled (master-stack) window: tiled windows don't overlap each
  // other, so internal order is irrelevant, but the whole tiled
  // stack moves as a unit when any tiled window is raised. Floating
  // and modal windows each get their own z above the tiled value
  // (see assignZForMap and raiseWindow). Starts at 0 so the very
  // first tiled window sits at z=0.
  let tiledZ = 0;

  // Re-derive tiledZ + the floating high-water mark from the current
  // window list. Run after any z mutation so subsequent z assignments
  // (new map, raise) reflect the actual peak.
  // High-water mark for "above the tile stack" windows. Includes
  // floating windows AND modals (a modal of a tiled parent sits at
  // parent.z + 1 = tiledZ + 1, which is above the tile stack and
  // should count toward the peak so subsequent floats/modals land
  // above it).
  function maxFloatingZ(): number {
    let m = tiledZ;
    for (const w of windows) {
      const isAboveTile =
        w.windowState.tiling === "floating" || w.windowState.modal;
      if (isAboveTile && w.z > m) m = w.z;
    }
    return m;
  }

  // Direct children of `parentSurfaceId` -- every window whose
  // windowState.parent points at it. Unfiltered (modal + non-modal).
  function childrenOf(parentSurfaceId: number): Window[] {
    const out: Window[] = [];
    for (const w of windows) {
      if (w.windowState.parent === parentSurfaceId) out.push(w);
    }
    return out;
  }

  // The "raise-with" rule. A child raises along with its parent when
  // EITHER the child is modal (modal always tops the parent) OR the
  // parent is managed (a tiled parent + its dialog form one logical
  // unit; raising the tile raises the dialog). The negation -- a
  // non-modal child of a floating parent -- has independent z and is
  // left alone on parent raise; the user can interact with both
  // windows freely and re-stack them by clicking either.
  function raisesWithParent(child: Window, parent: Window): boolean {
    return child.windowState.modal || parent.windowState.tiling === "managed";
  }

  // Walk up the parent chain from `start` across raise-with links
  // only. Stops at the first link that doesn't raise (a non-modal
  // child of a floating parent) -- that ancestor is the raise target.
  // Used to redirect a click on a tethered child up to the window that
  // owns the stack.
  function rootOfChain(start: Window): Window {
    let cur = start;
    for (let i = 0; i < 64; i++) {
      const parentId = cur.windowState.parent;
      if (parentId === null) return cur;
      const parent = windows.find((w) => w.surfaceId === parentId);
      if (!parent) return cur;
      if (!raisesWithParent(cur, parent)) return cur;
      cur = parent;
    }
    return cur;
  }

  // After raising `root`, walk descendants and re-elevate every child
  // that raises with its parent. A non-modal child of a floating
  // parent is skipped (independent z).
  function raiseStackedDescendants(root: Window): void {
    function visit(parent: Window): void {
      const targetZ = parent.z + 1;
      for (const child of childrenOf(parent.surfaceId)) {
        if (raisesWithParent(child, parent)) {
          if (child.z <= parent.z) child.z = targetZ;
        }
        visit(child);
      }
    }
    visit(root);
  }

  // Walk the parent chain of `start` (unrestricted by raise-with) and
  // return every ancestor including `start` itself, oldest-first. Used
  // by focus tethering: when a modal becomes active, check whether the
  // current focus target is anywhere in the chain.
  function chainOf(start: Window): Window[] {
    const out: Window[] = [];
    let cur: Window | null = start;
    for (let i = 0; i < 64; i++) {
      if (!cur) break;
      out.push(cur);
      const parentId: number | null = cur.windowState.parent;
      if (parentId === null) break;
      cur = windows.find((w) => w.surfaceId === parentId) ?? null;
    }
    return out;
  }

  // Topmost visible modal descendant of `parentSurfaceId` (transitive,
  // modal-only). null if none. Used by input gating (windowAt redirect)
  // and focus tethering (block focus on parent that has open modal).
  function topmostModalDescendant(parentSurfaceId: number): Window | null {
    let best: Window | null = null;
    function visit(parent: Window): void {
      for (const child of childrenOf(parent.surfaceId)) {
        if (child.windowState.modal && child.windowState.visible
            && child.hasContent && !isGated(child)) {
          if (!best || child.z > best.z) best = child;
        }
        visit(child);
      }
    }
    const start = windows.find((w) => w.surfaceId === parentSurfaceId);
    if (start) visit(start);
    return best;
  }

  // Apply the focus-tethering rule for a window that just became modal
  // (or was just mapped as modal). If any ancestor in the modal's
  // parent chain currently has keyboard focus, transfer focus to the
  // modal. If focus is somewhere else entirely (or no focus driver),
  // do nothing -- the modal opens quietly.
  function tetherFocusOnModal(modal: Window): void {
    if (!requestFocus || !currentFocusedSurfaceId) return;
    if (!modal.windowState.modal) return;
    if (!modal.windowState.visible) return;
    const focused = currentFocusedSurfaceId();
    if (focused === null || focused === modal.surfaceId) return;
    // Walk up modal's parent chain; if focused is anywhere in it,
    // tether.
    const chain = chainOf(modal);
    for (const ancestor of chain) {
      if (ancestor.surfaceId === modal.surfaceId) continue;
      if (ancestor.surfaceId === focused) {
        requestFocus(modal.surfaceId);
        return;
      }
    }
  }

  // Apply the focus-untether rule for a modal that just lost modality
  // (modal=false transition, or unmap). If the focused window is the
  // modal itself, return focus to the first live parent in its chain.
  // If the chain is dead / orphan, clear focus.
  function untetherFocusOnUnmodal(modal: Window, modalSurfaceId: number): void {
    if (!requestFocus || !currentFocusedSurfaceId) return;
    const focused = currentFocusedSurfaceId();
    if (focused !== modalSurfaceId) return;
    const parentId = modal.windowState.parent;
    if (parentId === null) { requestFocus(null); return; }
    const parent = windows.find((w) => w.surfaceId === parentId);
    if (!parent) { requestFocus(null); return; }
    requestFocus(parent.surfaceId);
  }

  // Assign z on map. Five cases:
  //   modal && parent live      -> max(parent.z, maxFloatingZ()) + 1
  //   modal && (no parent)      -> maxFloatingZ() + 1  (orphan modal)
  //   tiling===managed          -> tiledZ              (joins tile stack)
  //   floating && parent managed-> max(parent.z, maxFloatingZ()) + 1
  //   floating && (no parent or parent floating) -> maxFloatingZ() + 1
  // After placing the window, `raiseStackedDescendants` runs so a
  // newly-mapped node carrying a chain of own descendants (rare on
  // map, but possible if a plugin pre-populates state) is consistent.
  function assignZForMap(win: Window): void {
    const parentId = win.windowState.parent;
    const parent = parentId !== null
      ? windows.find((w) => w.surfaceId === parentId) ?? null
      : null;
    const isModal = win.windowState.modal;
    const isFloating = win.windowState.tiling === "floating";
    if (isModal && parent) {
      win.z = Math.max(parent.z, maxFloatingZ()) + 1;
    } else if (!isFloating && !isModal) {
      win.z = tiledZ;
    } else if (parent && raisesWithParent(win, parent)) {
      win.z = Math.max(parent.z, maxFloatingZ()) + 1;
    } else {
      win.z = maxFloatingZ() + 1;
    }
    raiseStackedDescendants(win);
  }
  // The primary is the lowest live id; computed on demand to track setOutputs.
  function primaryOutputId(): number {
    let lo = Infinity;
    for (const id of wm.outputs.keys()) if (id < lo) lo = id;
    if (lo === Infinity) throw new Error("internal: WM has no outputs");
    return lo;
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
    // Serial of the configure last sent for this held size, or null when no
    // serial-based ack is expected (move-only holds; xwayland resizes, which
    // have no ack_configure equivalent and gate on buffer dims only).
    serial: number | null;
    // The content size `serial` configured -- lets a merged reorder skip
    // re-configuring an already-asked size.
    cfgW: number;
    cfgH: number;
    // Move-only holds need no re-render and are always ready. A resize hold is
    // ready once the client has acked the configure (when requireAck) AND the
    // compositor reports a drawable buffer at the new size (surfaceReadyAt --
    // matters because dmabuf imports are async, so a commit alone doesn't
    // mean drawable).
    moveOnly: boolean;
    acked: boolean;
    // True for xdg windows (acked when ack_configure with the matching serial
    // lands); false for xwayland windows, where no ack exists and the hold
    // releases on the buffer-dims gate alone.
    requireAck: boolean;
  }
  // The WM-local resize-data store, separate from the broker's hold
  // registry. The broker's ready() closure reads back from this map so a
  // coalescing relayout (mutate-in-place rather than re-begin) is picked
  // up automatically.
  const pendingResizes = new Map<number, PendingResize>();
  // Shared batchKey: every WM resize-tx hold goes in the same batch, so
  // they apply atomically (two windows trading places never overlap).
  const WM_TX_BATCH = "wm-tx";
  // Windows removed since the last applyLayout pass. applyLayout iterates
  // these as DESTROYED entries (newOuter null) so plugins see the full
  // batch of transitions in stack.relayout: created, retiled, destroyed.
  // Cleared at the end of each applyLayout pass.
  type RemovedWindow = {
    surfaceId: number;
    lastOuter: Rect;
    lastOutputId: number | null;
    tiling: Tiling;
    phantomSurfaceId: number | null;
  };
  const removedThisPass: RemovedWindow[] = [];
  function pendingReady(id: number): boolean {
    const p = pendingResizes.get(id);
    if (!p) return true;
    if (p.moveOnly) return true;
    if (p.requireAck && !p.acked) return false;
    if (!compositor.surfaceReadyAt) return true;
    // Gate the apply on the surface presenting at the new LOGICAL size. A
    // viewport/fractional-scale client controls its own buffer resolution, so
    // logical size is the only sound readiness signal (a buffer-pixel scale
    // gate would never pass for such a client and would hold the tx forever).
    return compositor.surfaceReadyAt(id, p.content.width, p.content.height);
  }

  function pushStack(): void {
    if (rebuild) { rebuild(); return; }
    const ids: number[] = [];
    // When some window on a workspace has exclusive !== "none", it owns
    // the workspace and every peer is omitted from the draw stack
    // (matches the layout-driver's resolver, which only emits a rect
    // for the exclusive window on that output). Invisible windows
    // (visible === false) are also omitted regardless.
    const exclusiveByOutput = exclusiveWindowsByOutput();
    for (const w of windows) {
      if (isGated(w) || !w.hasContent) continue;
      if (!w.windowState.visible) continue;
      const ownerOutput = outputOf(w.surfaceId);
      if (ownerOutput !== null) {
        const exclusiveId = exclusiveByOutput.get(ownerOutput);
        if (exclusiveId !== undefined && exclusiveId !== w.surfaceId) continue;
      }
      if (w.decorationSurfaceId !== undefined) ids.push(w.decorationSurfaceId);
      ids.push(w.surfaceId);
    }
    compositor.setStack(ids);
  }

  // Resolve which window (if any) holds exclusive ownership of each
  // output. Iterates outputContent (the workspace plugin's per-output
  // visible-window order) and picks the first window in each list whose
  // `exclusive` is not "none" and whose `visible` is true.
  function exclusiveWindowsByOutput(): Map<number, number> {
    const out = new Map<number, number>();
    if (!outputContent) return out;
    const content = outputContent();
    for (const [outputId, ids] of content) {
      for (const id of ids) {
        const w = windows.find((x) => x.surfaceId === id);
        if (!w) continue;
        if (!w.windowState.visible) continue;
        if (w.windowState.exclusive !== "none") {
          out.set(outputId, id);
          break;
        }
      }
    }
    return out;
  }

  // Resolve the output a window currently lives on by scanning
  // outputContent. Returns null when no workspace plugin is wired or
  // the window is unplaced.
  function outputOf(surfaceId: number): number | null {
    if (!outputContent) return null;
    const content = outputContent();
    for (const [outputId, ids] of content) {
      if (ids.includes(surfaceId)) return outputId;
    }
    return null;
  }

  // Push one window's held geometry to the compositor: content layout, the
  // decoration's outer layout, and the decoration-resize hook. Mirrors the
  // immediate apply path in applyLayout.
  function pushGeometry(win: Window, outer: Rect, content: Rect): void {
    const prevOuter = win.outer;
    const prevContent = { ...win.rect };
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
    // Pure-move: position changed but size didn't. xwayland clients need a
    // ConfigureNotify with the new root coords (xdg-shell clients hide
    // position from their windows, so the sink's xdg branch is a no-op).
    // Guard prev-rect == placeholder (width <= 0): that is the first apply
    // after addWindow and is a size-establishing event, not a pure move.
    const hadPriorRect = prevContent.width > 0 && prevContent.height > 0;
    const contentMoved = prevContent.x !== content.x || prevContent.y !== content.y;
    const contentSized = prevContent.width !== content.width || prevContent.height !== content.height;
    if (configure && win.hasContent && hadPriorRect && contentMoved && !contentSized) {
      configure.configureMove(win.surfaceId, content.x, content.y, content.width, content.height);
    }
  }

  // Register a resize-tx hold for surfaceId. The broker freezes the
  // surface (if not already frozen by an earlier requirement, e.g. the
  // cross-output handler) and waits for ready() before applying. onApply
  // pushes the held geometry; the broker thaws afterwards.
  function beginResizeTx(surfaceId: number): void {
    surfaceTx.begin(surfaceId, {
      tag: "wm-tx",
      batchKey: WM_TX_BATCH,
      ready: () => pendingReady(surfaceId),
      onApply: () => {
        const p = pendingResizes.get(surfaceId);
        if (!p) return;
        pendingResizes.delete(surfaceId);
        const win = windows.find((w) => w.surfaceId === surfaceId);
        if (win) pushGeometry(win, p.outer, p.content);
      },
      onCancel: () => { pendingResizes.delete(surfaceId); },
    });
  }

  // Final step of the open sequence: drop the opening hold gates, run the
  // opening-driver hook (which may engage its own "opening" gate that the
  // animation plugin releases), and stack the window. Ordering matches the
  // gate invariant: beforeMap engages "opening" before the temp gate is
  // dropped, so the window is never momentarily un-gated.
  function mapOpenedWindow(win: Window): void {
    win.awaitingMapAck = false;
    const t = mapAckBackstops.get(win.surfaceId);
    if (t) { clearTimeout(t); mapAckBackstops.delete(win.surfaceId); }
    beforeMap?.(win.surfaceId);
    win.contentGateOwners?.delete("opening-ack");
    win.contentGateOwners?.delete("opening-pending-layout");
    pushStack();
    if (win.windowState.modal) tetherFocusOnModal(win);
  }

  // Shared tail of windowHasContent (both the settled-synchronous path and the
  // deferred continuation). Pushes the window's layout, sends the real tile-
  // size configure if it hasn't gone out yet, then maps the window -- but holds
  // the map until the client has acked the latest configure serial we sent
  // while it was unmapped (the "mapping commit"), so the open animation plays
  // on a buffer rendered at the tile size, not the client's default from the
  // 0x0 handshake. A client that already rendered correctly (acked the latest
  // serial on its first content commit) maps immediately -- no added delay.
  function openWindow(win: Window): void {
    compositor.setSurfaceLayout(win.surfaceId, win.rect.x, win.rect.y, win.rect.width, win.rect.height);
    if (win.pendingSizeConfigure && configure
        && win.outer.width > 0 && win.outer.height > 0) {
      win.pendingSizeConfigure = false;
      const content = contentOf(win);
      configure.configure(win.surfaceId, content.x, content.y, content.width, content.height);
    }
    const wantSerial = lastConfigureSerial.get(win.surfaceId);
    const acked = win.lastAckedSerial ?? -1;
    // Hold ONLY when an open animation will actually run (a window-opening
    // plugin is registered) AND there's an unacked size configure. Without an
    // animation there's nothing to protect, so the window maps immediately --
    // gating on beforeMap (the always-wired hook) instead would wrongly hold
    // every window. xwayland (no serial) also maps immediately.
    if (beforeMap && hasOpeningAnimation?.() && wantSerial !== undefined && acked < wantSerial) {
      if (!win.contentGateOwners) win.contentGateOwners = new Set();
      win.contentGateOwners.add("opening-ack");
      win.awaitingMapAck = true;
      if (!mapAckBackstops.has(win.surfaceId)) {
        const sid = win.surfaceId;
        const timer = setTimeout(() => {
          mapAckBackstops.delete(sid);
          const w = windows.find((x) => x.surfaceId === sid);
          if (w && w.awaitingMapAck) {
            coreLog.warn("core",
              `wm: map-ack backstop fired for surfaceId=${sid}; mapping anyway`);
            mapOpenedWindow(w);
          }
        }, MAP_ACK_BACKSTOP_MS);
        timer.unref?.();
        mapAckBackstops.set(sid, timer);
      }
      return;
    }
    mapOpenedWindow(win);
  }

  // Continuation for windowHasContent when the layout-driver pass that
  // assigns a window's real outer rect hadn't settled by the time
  // first-content arrived. Awaits driver.settled(), then runs the
  // setSurfaceLayout + beforeMap + pushStack sequence with the real
  // outer in place. The "opening-pending-layout" gate owner engaged
  // by windowHasContent keeps the window invisible until this
  // continuation releases it.
  //
  // Fallback: if the layout never produces a real outer (e.g. a
  // no-op driver in a minimal test harness), the continuation
  // releases the temp gate anyway and pushes with whatever
  // win.outer / win.rect currently hold. This preserves the
  // pre-fix behavior for that case (window enters the stack at
  // placeholder dims rather than being held invisible forever).
  async function runOpeningAfterLayoutSettles(win: Window): Promise<void> {
    try {
      await driver.settled();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      coreLog.err("core",
        `wm: opening-pending-layout settle threw: ${msg}; releasing gate`);
    }
    // The window may have unmapped while we awaited.
    if (!windows.includes(win)) {
      win.contentGateOwners?.delete("opening-pending-layout");
      return;
    }
    openWindow(win);
  }

  // Apply a LayoutResult: emit window.relayout, then update each window's
  // outer rect, push the compositor's setSurfaceLayout, fire configure where
  // size changed, and update bound decorations. For "reorder" and
  // "param-changed" relayouts the geometry is routed through the resize
  // transaction (held until the client re-renders) instead of being applied
  // immediately: both retile existing windows to new sizes, and applying
  // geometry before content leaves stretched buffers and misaligned
  // decoration cut-outs on screen (background showing through) until the
  // clients catch up -- continuously so under a held resize key.
  //
  // After all per-window window.relayout emits settle, emits a single
  // stack.relayout carrying the batch of transitions (created / retiled /
  // destroyed) so plugins coordinating cross-window animations see the
  // whole pass at once. removedThisPass (populated by unmapWindow) is
  // drained here as DESTROYED entries.
  async function applyLayout(result: LayoutResult, reason: LayoutReason): Promise<void> {
    const useTx = (reason === "reorder" || reason === "param-changed") && !!configure;
    const byId = new Map<number, { id: number; outer: Rect }>();
    for (const r of result.rects) byId.set(r.id, r);
    const snapshotWindows = [...windows];
    // Batch entries built up across the pass for the final stack.relayout
    // emit. Each entry reflects the POST-OVERRIDE state: per-window
    // window.relayout interceptors may have modified newOuter; this list
    // captures the final values the WM committed to.
    type BatchEntry = {
      surfaceId: number;
      oldOuter: Rect | null;
      oldOutputId: number | null;
      newOuter: Rect | null;
      newOutputId: number | null;
      tiling: Tiling;
      phantomSurfaceId?: number;
    };
    const batch: BatchEntry[] = [];

    for (const win of snapshotWindows) {
      const r = byId.get(win.surfaceId);
      if (!r) continue;
      const prevContent = contentOf(win);
      const prevOuter = win.outer;
      let newOuter: Rect = { ...r.outer };

      // CREATED entries have placeholder oldOuter ({0,0,-1,-1} from
      // addWindow). The per-window event reports oldOuter / oldOutputId
      // as null to signal "this is the window's first layout assignment."
      const isCreated = prevOuter.width <= 0 || prevOuter.height <= 0;
      const oldOutputId = isCreated ? null : (win.outputId ?? null);
      const newOutputId = outputOf(win.surfaceId);

      if (pluginBus) {
        const initial: WindowRelayoutEvent = {
          surfaceId: win.surfaceId,
          oldOuter: isCreated ? null : { ...prevOuter },
          oldOutputId,
          newOuter: { ...newOuter },
          newOutputId,
          tiling: win.windowState.tiling,
          reason,
        };
        const finalPayload = await pluginBus.emit(WINDOW_EVENT.relayout, initial,
          { timeoutMs: INTERCEPTOR_TIMEOUT_MS });
        if (!windows.includes(win)) continue;
        const ev = finalPayload as WindowRelayoutEvent | undefined;
        // Honor newOuter override only for non-destroy entries (a
        // destroyed window can't be redirected). Created and retile
        // entries pass through normally; the override is the layout
        // override seam.
        if (ev && ev.newOuter !== null && isRect(ev.newOuter)) newOuter = { ...ev.newOuter };
      }

      batch.push({
        surfaceId: win.surfaceId,
        oldOuter: isCreated ? null : { ...prevOuter },
        oldOutputId,
        newOuter: { ...newOuter },
        newOutputId,
        tiling: win.windowState.tiling,
      });

      const newContent = win.insets ? shrink(newOuter, win.insets) : { ...newOuter };
      const sizeChanged = newContent.width !== prevContent.width || newContent.height !== prevContent.height;
      const moved = prevOuter.x !== newOuter.x || prevOuter.y !== newOuter.y
                 || prevOuter.width !== newOuter.width || prevOuter.height !== newOuter.height;

      // Pre-tile state: addWindow seeds outer = {0,0,-1,-1} (the placeholder
      // sentinel). A "reorder" relayout that lands BEFORE the window has ever
      // been tiled (e.g. mapped relayout arrived before the workspace plugin's
      // setOutputStack populated outputToplevelStacks, then setOutputStack
      // ran and triggered this "reorder") has no prior geometry to hold --
      // routing this initial assignment through the resize transaction would
      // defer indefinitely, because the client never saw a real size to
      // re-render against. Treat width<=0 as "never tiled" and take the
      // immediate path so the window gets its first real rect.
      const hadPriorTile = prevOuter.width > 0 && prevOuter.height > 0;

      if (useTx && win.hasContent && !win.pendingInitialCommit && hadPriorTile) {
        // Transaction path: hold the new geometry; (re)configure on a size that
        // differs from what the client was last asked for. The window keeps its
        // current drawn rect until the broker applies the tx batch.
        const pend = pendingResizes.get(win.surfaceId);
        const lastCfgW = pend ? pend.cfgW : prevContent.width;
        const lastCfgH = pend ? pend.cfgH : prevContent.height;
        if (newContent.width !== lastCfgW || newContent.height !== lastCfgH) {
          // configure is non-null here (useTx requires it); guard for the type.
          // serial===null is the role signal: xdg returns a number (wait for
          // ack_configure), xwayland returns null (no ack -- gate on buffer
          // dims only).
          const serial = configure
            ? configure.configure(win.surfaceId, newContent.x, newContent.y,
                        newContent.width, newContent.height) : null;
          const requireAck = serial !== null;
          if (pend) {
            // Coalesce: mutate the existing entry. The broker's ready()
            // re-reads from the map so it picks up the new size + ack
            // requirement without re-registering.
            pend.outer = newOuter; pend.content = newContent;
            pend.serial = serial; pend.cfgW = newContent.width; pend.cfgH = newContent.height;
            pend.moveOnly = false; pend.acked = false; pend.requireAck = requireAck;
          } else {
            pendingResizes.set(win.surfaceId, {
              outer: newOuter, content: newContent,
              serial, cfgW: newContent.width, cfgH: newContent.height,
              moveOnly: false, acked: false, requireAck,
            });
            beginResizeTx(win.surfaceId);
          }
        } else if (pend) {
          pend.outer = newOuter;
          pend.content = newContent;
        } else if (moved) {
          pendingResizes.set(win.surfaceId, {
            outer: newOuter, content: newContent, serial: null,
            cfgW: newContent.width, cfgH: newContent.height,
            moveOnly: true, acked: true, requireAck: false,
          });
          beginResizeTx(win.surfaceId);
        }
        continue;
      }

      // Immediate path (non-reorder reasons, or initial / not-yet-content
      // windows). Suppress configure during the deferred-initial-commit phase.
      //
      // This pass is authoritative for the window's geometry. A resize-tx
      // hold left by an earlier pass captured a now-stale rect; the broker's
      // deadline force-apply (or a late client commit) would otherwise run
      // its onApply and push that stale rect on top of what we set here,
      // reverting the window to its pre-transition tile. That is what leaves
      // a hole in the layout when a tiled window is promoted to floating: the
      // remaining windows' reflow lands, then the stale hold yanks them back.
      // Retarget the hold to the new geometry so its eventual apply is a
      // no-op against this placement instead of a regression.
      const stalePend = pendingResizes.get(win.surfaceId);
      if (stalePend) {
        stalePend.outer = { ...newOuter };
        stalePend.content = { ...newContent };
        stalePend.moveOnly = false;
      }
      if (!moved && !sizeChanged) {
        // Cache the output id even when geometry didn't change (a workspace
        // move could change which output a window belongs to without
        // resizing). The transaction path skips the cache update and
        // applies it via pushGeometry instead.
        win.outputId = newOutputId;
        continue;
      }
      win.outer = newOuter;
      win.outputId = newOutputId;
      const content = contentOf(win);
      win.rect = content;
      if (win.hasContent) {
        compositor.setSurfaceLayout(win.surfaceId, content.x, content.y, content.width, content.height);
      }
      if (configure && !win.pendingInitialCommit && sizeChanged) {
        // This is the real tile-size configure. When a fresh window first
        // gets a real outer from the layout, it goes out here; clearing the
        // "owed" flag keeps windowHasContent from re-sending it
        // (pendingSizeConfigure is the single source of truth).
        win.pendingSizeConfigure = false;
        configure.configure(win.surfaceId, content.x, content.y, content.width, content.height);
      } else if (configure && !win.pendingInitialCommit && moved && win.hasContent) {
        // Pure move: configure.configure is for size changes only; route via
        // the move-only sink so xwayland clients get a ConfigureNotify and
        // xdg clients see a no-op.
        configure.configureMove(win.surfaceId, content.x, content.y, content.width, content.height);
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

    // Drain destroyed-this-pass windows. Each emits a per-window
    // window.relayout event with newOuter === null (DESTROYED) and a
    // phantomSurfaceId when the closing-driver minted one. The interceptor
    // chain runs but newOuter overrides on destroy entries are ignored;
    // the WM commits no rect change for these (the window is already
    // unmapped). After per-window emits, the destroyed entries appear in
    // the stack.relayout batch.
    const removedSnapshot = removedThisPass.splice(0, removedThisPass.length);
    for (const removed of removedSnapshot) {
      if (pluginBus) {
        const initial: WindowRelayoutEvent = {
          surfaceId: removed.surfaceId,
          oldOuter: { ...removed.lastOuter },
          oldOutputId: removed.lastOutputId,
          newOuter: null,
          newOutputId: null,
          tiling: removed.tiling,
          reason,
          ...(removed.phantomSurfaceId !== null
            ? { phantomSurfaceId: removed.phantomSurfaceId } : {}),
        };
        await pluginBus.emit(WINDOW_EVENT.relayout, initial,
          { timeoutMs: INTERCEPTOR_TIMEOUT_MS });
        // newOuter override is ignored (destroyed; no rect to install).
      }
      batch.push({
        surfaceId: removed.surfaceId,
        oldOuter: { ...removed.lastOuter },
        oldOutputId: removed.lastOutputId,
        newOuter: null,
        newOutputId: null,
        tiling: removed.tiling,
        ...(removed.phantomSurfaceId !== null
          ? { phantomSurfaceId: removed.phantomSurfaceId } : {}),
      });
    }

    // Emit the batch event once per pass. Observer-only; per-window
    // interceptors already ran above.
    if (pluginBus && batch.length > 0) {
      const stackEvent: StackRelayoutEvent = { reason, windows: batch };
      pluginBus.emit(STACK_EVENT.relayout, stackEvent);
    }

    if (useTx) {
      // Drop holds for windows no longer in this layout result.
      for (const id of [...pendingResizes.keys()]) {
        if (!byId.has(id)) surfaceTx.cancel(id);
      }
      // Coalescing path may have flipped existing entries' ready state
      // (e.g. a re-issued configure resets acked); poke the broker.
      surfaceTx.evaluate();
    }
  }

  // Build a LayoutSnapshot from the current WM state. The windows map
  // carries every mapped window keyed by surfaceId; outputContent (from the
  // workspace plugin via the WmOptions callback) drives which subset is
  // laid out on each output and in what order.
  // Explicit islands (docs/canvas-design.md §5), pushed by the workspace-
  // namespace plugin via windows.set-islands. null = derive one implicit
  // island per output from outputContent (the snapshot fallback below).
  let explicitIslands: ReadonlyArray<import("./layout-driver.js").LayoutIsland> | null = null;

  function islandsEqual(
    a: ReadonlyArray<import("./layout-driver.js").LayoutIsland> | null,
    b: ReadonlyArray<import("./layout-driver.js").LayoutIsland> | null,
  ): boolean {
    if (a === null || b === null) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x.id !== y.id || x.outputId !== y.outputId) return false;
      if ((x.rect === null) !== (y.rect === null)) return false;
      if (x.rect && y.rect
        && (x.rect.x !== y.rect.x || x.rect.y !== y.rect.y
          || x.rect.width !== y.rect.width || x.rect.height !== y.rect.height)) {
        return false;
      }
      if (x.members.length !== y.members.length) return false;
      for (let j = 0; j < x.members.length; j++) {
        if (x.members[j] !== y.members[j]) return false;
      }
    }
    return true;
  }

  function snapshot(): LayoutSnapshot {
    const windowMap = new Map<number, import("./layout-driver.js").LayoutSnapshotWindow>();
    for (const w of windows) {
      windowMap.set(w.surfaceId, {
        id: w.surfaceId,
        role: "toplevel" as const,
        tiling: w.windowState.tiling,
        exclusive: w.windowState.exclusive,
        visible: w.windowState.visible,
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
    // Implicit per-output islands (docs/canvas-design.md §5): one island
    // per output with content, id = outputId, rect = null (the driver
    // derives the tile region from the output minus reserved zones),
    // members = the workspace plugin's per-output visible order. Fallback
    // when no plugin is wired: every known window on the primary output,
    // in master-front insertion order -- keeps GPU-free tests and
    // pre-workspace bring-up producing a layout. Pre-content windows are
    // included so their rect is ready by the time their first commit
    // lands (windowHasContent just flips the gate; no relayout needed).
    const islands: Array<import("./layout-driver.js").LayoutIsland> = [];
    if (explicitIslands) {
      for (const isl of explicitIslands) {
        islands.push({
          id: isl.id, outputId: isl.outputId,
          rect: isl.rect ? { ...isl.rect } : null,
          members: [...isl.members],
        });
      }
    } else if (outputContent) {
      for (const [outputId, ids] of outputContent()) {
        islands.push({ id: outputId, outputId, rect: null, members: [...ids] });
      }
    } else {
      const ids = windows.map((w) => w.surfaceId);
      if (ids.length > 0) {
        const outputId = primaryOutputId();
        islands.push({ id: outputId, outputId, rect: null, members: ids });
      }
    }
    return { outputs: outputDescs, windows: windowMap, islands };
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
        z: tiledZ,
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
      driver.schedule("output-resized");
    },

    setIslands(islands) {
      const next = islands === null ? null : islands.map((i) => ({
        id: i.id, outputId: i.outputId,
        rect: i.rect ? { ...i.rect } : null,
        members: [...i.members],
      }));
      if (islandsEqual(explicitIslands, next)) return false;
      explicitIslands = next;
      driver.schedule("reorder");
      return true;
    },

    windowHasContent(surfaceId, contentSize) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return undefined;
      if (!win.hasContent) {
        win.hasContent = true;
        // Default-floating policy for windows the client signaled as
        // transient/fixed-size. By this point the client has sent
        // set_parent / set_min_size / set_max_size; those proposes run
        // through markInitialCommitComplete's await chain, but a client
        // that sends set_min_size AFTER the initial 0x0 configure (the
        // GTK4 pattern for About-style dialogs) only has those
        // constraints reflected here, after the first buffer commit.
        // Conditions:
        //   - parent set (xdg_toplevel.set_parent != null), OR
        //   - min and max are both non-zero AND either axis is locked
        //     (min == max on width OR height), OR
        //   - the client's window-type prefers floating (X11
        //     _NET_WM_WINDOW_TYPE splash/dialog/utility; win.floatByType).
        // A plugin's preconfigure interceptor would have already
        // overridden if it wanted to; this is a default that fires
        // only when the WM is still in the post-preconfigure
        // 'managed' state.
        const c = win.windowState.constraints;
        const minW = c.minSize?.width ?? 0;
        const minH = c.minSize?.height ?? 0;
        const maxW = c.maxSize?.width ?? 0;
        const maxH = c.maxSize?.height ?? 0;
        const fixedSize = minW !== 0 && minH !== 0
          && (minW === maxW || minH === maxH);
        let dialogPolicyMutated = false;
        if (win.windowState.tiling === "managed"
            && win.windowState.exclusive === "none"
            && (win.windowState.parent !== null || fixedSize || win.floatByType)) {
          win.windowState = { ...win.windowState, tiling: "floating" };
          dialogPolicyMutated = true;
        }
        // Size a floating window that has no rect yet: promoted just above by
        // the transient/fixed-size default, OR floated by a window rule at
        // preconfigure. A floating window with no floatingRect falls back to
        // the addWindow placeholder in the layout driver, so it renders
        // invisible. Size it from the client's own content size -- its
        // committed window geometry, else its buffer -- clamped to the
        // client's min/max, so it renders 1:1 at its natural size instead of
        // being stretched. Fall back to a locked axis / default when no
        // content size is known yet. Centered on the parent's output (else
        // primary). The floating rect is the OUTER tile, so when decoration
        // insets are already reserved (the decoration intercept's setInsets
        // runs at preconfigure) the outer is content + insets here, leaving
        // the content rect equal to the client's size.
        let floatingSized = false;
        if (win.windowState.tiling === "floating"
            && win.windowState.exclusive === "none"
            && win.floatingRect === undefined) {
          const clampAxis = (v: number, lo: number, hi: number): number => {
            let r = v;
            if (lo > 0) r = Math.max(r, lo);
            if (hi > 0) r = Math.min(r, hi);
            return r;
          };
          const cw = contentSize && contentSize.width > 0 ? contentSize.width : 0;
          const ch = contentSize && contentSize.height > 0 ? contentSize.height : 0;
          const fw = cw > 0 ? clampAxis(cw, minW, maxW)
            : (minW !== 0 && minW === maxW) ? minW : (minW || 800);
          const fh = ch > 0 ? clampAxis(ch, minH, maxH)
            : (minH !== 0 && minH === maxH) ? minH : (minH || 600);
          const insetLR = (win.insets?.left ?? 0) + (win.insets?.right ?? 0);
          const insetTB = (win.insets?.top ?? 0) + (win.insets?.bottom ?? 0);
          const outerW = fw + insetLR;
          const outerH = fh + insetTB;
          const targetOutputId = resolveParentOutputId(
            win.windowState.parent, outputContent)
            ?? primaryOutputId();
          const out = wm.outputs.get(targetOutputId);
          const ox = out?.rect.x ?? 0;
          const oy = out?.rect.y ?? 0;
          const ow = out?.rect.width ?? outerW;
          const oh = out?.rect.height ?? outerH;
          win.floatingRect = {
            x: ox + Math.max(0, Math.round((ow - outerW) / 2)),
            y: oy + Math.max(0, Math.round((oh - outerH) / 2)),
            width: outerW, height: outerH,
          };
          floatingSized = true;
        }
        // Assign z per the map-time rules (tiled joins the shared
        // tiledZ; floating sits above the floating peak; modal sits
        // above its parent). Runs AFTER the dialog policy promotion
        // above so a fresh dialog lands at the correct z. Without
        // this every newly-mapped window would keep the placeholder
        // z=0 from addWindow, putting it under everything.
        assignZForMap(win);
        // The layout pass that gives this window its real outer may
        // not have settled yet (markInitialCommitComplete kicks one
        // off but is fire-and-forget; a client whose first buffer
        // commit lands before that pass completes hits THIS point
        // with win.outer still at the {0,0,-1,-1} placeholder). If
        // we beforeMap + pushStack synchronously here, the
        // opening-driver fires window.opening with a bogus outer and
        // the compositor briefly draws the surface at placeholder
        // dimensions before applyLayout corrects it.
        //
        // Hold the window out of the draw stack under owner key
        // "opening-pending-layout" until the layout settles, then
        // run beforeMap + pushStack with the real outer. This is
        // independent of the opening-driver's own gate; both can be
        // engaged at the same time (multi-owner gate composes).
        if (dialogPolicyMutated || floatingSized) {
          driver.schedule("state-changed");
        }
        const layoutSettled = win.outer.width > 0 && win.outer.height > 0
                              && !dialogPolicyMutated && !floatingSized;
        if (layoutSettled || !beforeMap) {
          // Synchronous path: either the layout already gave us a real
          // outer (the normal case for windows that map after the WM
          // has been running), OR there's no opening-driver wired (the
          // unit-test scenario where the test harness skips the
          // protocol layer; we shouldn't defer the window indefinitely).
          //
          // In the no-beforeMap case the surface enters the draw stack
          // synchronously even at placeholder dims; the test harness
          // doesn't run a layout pass so the window's rect is whatever
          // addWindow seeded (compositor sink is also a stub there).
          openWindow(win);
        } else {
          // Layout not yet settled OR dialog policy will retrigger one,
          // AND a beforeMap callback is wired (production opening-driver
          // path). Engage a temp gate; defer beforeMap + pushStack to
          // the settle-then-run continuation. The window is held out
          // of the draw stack throughout, so it never composites at
          // the placeholder rect.
          if (!win.contentGateOwners) win.contentGateOwners = new Set();
          win.contentGateOwners.add("opening-pending-layout");
          void runOpeningAfterLayoutSettles(win);
        }
      }
      return { ...win.rect };
    },

    unmapWindow(surfaceId, opts) {
      const i = windows.findIndex((w) => w.surfaceId === surfaceId);
      if (i < 0) return;
      const unmapped = windows[i];
      // Capture the unmapped window's last placement for the next
      // applyLayout pass so it shows up as a DESTROYED entry in
      // window.relayout / stack.relayout. The phantomSurfaceId (when the
      // closing-driver minted one) flows through here so plugins
      // animating the disappearance can target it.
      removedThisPass.push({
        surfaceId,
        lastOuter: { ...unmapped.outer },
        lastOutputId: unmapped.outputId ?? null,
        tiling: unmapped.windowState.tiling,
        phantomSurfaceId: opts?.phantomSurfaceId ?? null,
      });
      // If the unmapped window is modal and currently focused, return
      // focus to the parent (or null if the parent is gone). Read state
      // BEFORE splicing -- untetherFocusOnUnmodal needs the parent ref.
      const wasModal = unmapped.windowState.modal;
      windows.splice(i, 1);
      // Cancel any pending resize-tx hold; the broker thaws and removes
      // the entry from pendingResizes via onCancel.
      if (surfaceTx.has(surfaceId)) surfaceTx.cancel(surfaceId);
      // Drop map-ack hold bookkeeping (the window never reached map).
      const mt = mapAckBackstops.get(surfaceId);
      if (mt) { clearTimeout(mt); mapAckBackstops.delete(surfaceId); }
      lastConfigureSerial.delete(surfaceId);
      driver.schedule("unmapped");
      pushStack();
      if (wasModal) untetherFocusOnUnmodal(unmapped, surfaceId);
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
      // For floating windows, GROW the outer so the content rect (=
      // what the client is configured to render at) is unchanged.
      // Tiled windows keep the existing "outer is authoritative;
      // decoration eats into it" semantics: the WM owns the outer
      // tile; setting insets shrinks the content. A floating window's
      // outer is sized to match the client's preferred content
      // (e.g. a fixed-size About dialog's set_min == set_max);
      // shrinking content there forces a configure the client refuses,
      // and the resulting buffer-rendered-larger-than-tile shows
      // hit-test misalignment + decoration overlap on the right /
      // bottom.
      if (win.windowState.tiling === "floating"
          && win.outer.width > 0 && win.outer.height > 0) {
        const insetLR = granted.left + granted.right;
        const insetTB = granted.top + granted.bottom;
        win.outer = {
          x: win.outer.x, y: win.outer.y,
          width: prevContent.width + insetLR,
          height: prevContent.height + insetTB,
        };
        if (win.floatingRect) {
          win.floatingRect = {
            x: win.floatingRect.x, y: win.floatingRect.y,
            width: win.outer.width, height: win.outer.height,
          };
        }
      }
      const contentRect = contentOf(win);
      win.rect = contentRect;
      const outerRect = { ...win.outer };
      if (win.hasContent) {
        compositor.setSurfaceLayout(win.surfaceId, contentRect.x, contentRect.y, contentRect.width, contentRect.height);
      }
      // Skip the configure when the outer rect is still the addWindow
      // placeholder (-1x-1); contentRect derived from it will be negative
      // and get clamped to 0x0 on the wire -- the client reads that as
      // "you pick" and ignores our intent. The layout pass that will run
      // shortly sends the real sized configure.
      if (configure && win.outer.width > 0 && win.outer.height > 0
          && (contentRect.width !== prevContent.width || contentRect.height !== prevContent.height)) {
        configure.configure(win.surfaceId, contentRect.x, contentRect.y,
                  contentRect.width, contentRect.height);
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

    engageContentGate(surfaceId, owner) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return;
      if (!win.contentGateOwners) win.contentGateOwners = new Set();
      if (win.contentGateOwners.has(owner)) return;  // idempotent
      const wasGated = win.contentGateOwners.size > 0;
      win.contentGateOwners.add(owner);
      if (!wasGated) pushStack();  // first owner engaged; restack needed
    },

    releaseContentGate(surfaceId, owner) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win || !win.contentGateOwners) return;
      if (!win.contentGateOwners.delete(owner)) return;  // wasn't engaged
      if (win.contentGateOwners.size === 0) {
        win.contentGateOwners = undefined;
        pushStack();  // last owner released; window joins the stack
      }
    },

    isContentGated(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      return win?.contentGateOwners !== undefined && win.contentGateOwners.size > 0;
    },

    setDecorationSurface(windowId, decoSurfaceId) {
      const win = windows.find((w) => w.surfaceId === windowId);
      if (!win) return;
      const next = decoSurfaceId === null ? undefined : decoSurfaceId;
      if (win.decorationSurfaceId === next) return;
      win.decorationSurfaceId = next;
      // Bind the decoration as an fx-follower so a window transform/opacity
      // reaches it (the compositor cascades over the group). It keeps its own
      // outer-rect layout, set below.
      compositor.setDecorationFx?.(windowId, next ?? null);
      if (next !== undefined && win.outer.width > 0 && win.outer.height > 0) {
        compositor.setSurfaceLayout(next, win.outer.x, win.outer.y,
                                    win.outer.width, win.outer.height);
      }
      pushStack();
    },

    raiseWindow(surfaceId) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return;
      // Walk up the chain across raise-with links only. A click on a
      // tethered child (modal, or non-modal child of a managed parent)
      // redirects to the topmost owner; a click on an independent
      // floating child (non-modal of a floating parent) raises just
      // that child.
      const root = rootOfChain(win);
      const isTiled = root.windowState.tiling === "managed";
      const highestFloating = maxFloatingZ();
      if (isTiled) {
        // Tiled stack: if the shared tiled z is already at the peak,
        // nothing to do beyond renormalizing descendant chains. Otherwise
        // raise the ENTIRE tiled stack to sit at highestFloating + 1;
        // every tiled window keeps a shared z.
        if (tiledZ <= highestFloating) {
          const newZ = highestFloating + 1;
          tiledZ = newZ;
          for (const w of windows) {
            if (w.windowState.tiling === "managed") w.z = newZ;
          }
        }
        // Raising tiled re-elevated EVERY tiled window's z, so EVERY
        // tiled window's descendant chain may now be below its (newly-
        // raised) parent. Renormalize every tiled window's chain, not
        // just the clicked one's. raiseStackedDescendants honors the
        // raise-with rule (modal-or-managed-parent only).
        for (const w of windows) {
          if (w.windowState.tiling === "managed") raiseStackedDescendants(w);
        }
      } else {
        // Floating root: if it's already on top, only renormalize its
        // own descendant chain. Otherwise bump it above the current peak.
        if (root.z <= highestFloating) {
          root.z = highestFloating + 1;
        }
        raiseStackedDescendants(root);
      }
      pushStack();
    },

    raiseAllFloating() {
      // Independent floating stacks (a floating window that is the root of
      // its own raise-with chain), in current z order, restacked just above
      // the shared tiled z. Ascending assignment preserves their relative
      // order; each chain's descendants renormalize to stay above their root.
      const roots = windows
        .filter((w) => w.windowState.tiling === "floating" && rootOfChain(w) === w)
        .sort((a, b) => a.z - b.z);
      if (roots.length === 0) return;
      let z = tiledZ;
      for (const w of roots) {
        w.z = ++z;
        raiseStackedDescendants(w);
      }
      pushStack();
    },

    windowAt(x, y, accept) {
      // Hit-test top-to-bottom in the SAME z-order the renderer composites
      // (computeBaseStack draws ascending z, bottom-to-top; we walk
      // descending), so a click lands on whatever is drawn on top. win.z is
      // the single source of truth for stacking -- a floating dialog sits
      // above its parent in z and so wins the hit even though it mapped later
      // than the parent. The workspace plugin's per-output list (outputContent)
      // only scopes VISIBILITY here: a window on a hidden workspace is absent
      // from it. Without a workspace plugin (test harnesses), every WM window
      // is a candidate.
      //
      // Modal gating: when the hit window has a live modal descendant, the
      // click is redirected to the topmost such descendant. This is the
      // strict-modality contract -- a click anywhere on a window that owns
      // an open modal targets the modal instead. Non-modal children do not
      // gate (a floating dialog of a floating parent is independently
      // clickable).
      const gate = (win: Window): Window => {
        const modal = topmostModalDescendant(win.surfaceId);
        return modal ?? win;
      };
      let candidates: Window[];
      const content = outputContent ? outputContent() : null;
      if (content) {
        candidates = [];
        const seen = new Set<number>();
        for (const ids of content.values()) {
          for (const id of ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            const win = windows.find((w) => w.surfaceId === id);
            if (win) candidates.push(win);
          }
        }
      } else {
        candidates = [...windows];
      }
      // Stable descending-z sort: ties keep candidate order (the tiled bucket
      // shares one z but never overlaps, so the tie order is immaterial).
      candidates.sort((a, b) => (b.z ?? 0) - (a.z ?? 0));
      for (const win of candidates) {
        const r = win.rect;
        if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) continue;
        if (accept) {
          const localX = x - r.x;
          const localY = y - r.y;
          if (!accept(win, localX, localY)) continue;
        }
        return gate(win);
      }
      return null;
    },

    async propose(surfaceId, proposal, reason) {
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (!win) return null;
      // Before the initial commit, the throwaway 0x0 first configure is sent
      // SYNCHRONOUSLY (sendInitialConfigure) and its states array is read from
      // win.windowState (tiling/exclusive/visible). A direct decision-axis
      // write that arrived in the same wayland-batch goes through this async
      // pipeline, which only writes windowState after a microtask hop -- too
      // late for that first configure. Stamp the client-declared decision
      // axes synchronously so the first configure carries them; the async
      // pass below still runs the proposed-interceptor + layout for the
      // sized second configure.
      if (win.pendingInitialCommit) {
        const stamp: Partial<WindowState> = {};
        if (proposal.tiling !== undefined) stamp.tiling = proposal.tiling;
        if (proposal.exclusive !== undefined) stamp.exclusive = proposal.exclusive;
        if (proposal.visible !== undefined) stamp.visible = proposal.visible;
        if (proposal.modal !== undefined) stamp.modal = proposal.modal;
        if (proposal.parent !== undefined) stamp.parent = proposal.parent;
        if (Object.keys(stamp).length > 0) {
          win.windowState = { ...win.windowState, ...stamp };
        }
        // Client requests arriving pre-content go through the policy seam
        // (resolveDecisions with phase="pre-content") synchronously so the
        // first configure reflects the decided state, not the raw request.
        if (proposal.clientRequests !== undefined) {
          const prevCR = win.windowState.clientRequests;
          const nextCR: ClientRequests = {
            wantsMaximized: proposal.clientRequests.wantsMaximized ?? prevCR.wantsMaximized,
            wantsFullscreen: proposal.clientRequests.wantsFullscreen ?? prevCR.wantsFullscreen,
            wantsMinimized: proposal.clientRequests.wantsMinimized ?? prevCR.wantsMinimized,
            wantsModal: proposal.clientRequests.wantsModal ?? prevCR.wantsModal,
          };
          const merged: WindowState = { ...win.windowState, clientRequests: nextCR };
          win.windowState = resolveDecisions(win.windowState, merged, "pre-content");
        }
      }
      // Same race for client-declared constraints (set_min_size /
      // set_max_size): a client (the GIMP splash, GTK About dialogs)
      // sends these together with its first-content commit, then the
      // map handler in protocols/index.ts synchronously calls
      // windowHasContent, which classifies the window based on whether
      // min == max in either axis. Without a synchronous stamp the
      // constraints aren't in windowState yet (still queued behind the
      // async proposed-interceptor pass), the fixed-size rule sees
      // zeros, and the window stays in the managed lane when it should
      // default to floating. Constraints are append-only data with no
      // downstream invariants beyond the floating classification;
      // stamping them eagerly is safe.
      if (proposal.constraints !== undefined) {
        win.windowState = {
          ...win.windowState,
          constraints: {
            ...win.windowState.constraints,
            ...proposal.constraints,
          },
        };
      }
      // Window-type float hint rides the same synchronous race as constraints:
      // the X11 _NET_WM_WINDOW_TYPE reply can arrive interleaved with the first
      // content commit, and windowHasContent (called synchronously from the map
      // handler) must see it. Stamp it eagerly onto the window record; it is a
      // hint, not a decision axis, so it never enters windowState.
      if (proposal.floatByType !== undefined) {
        win.floatByType = proposal.floatByType;
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

        // Apply default policy after the interceptor chain: if the
        // proposal only touched clientRequests (the typical
        // xdg_toplevel.set_* path) and no interceptor took a position,
        // resolveDecisions maps wants -> decisions per the default
        // policy. phase post-content (pre-content is handled
        // synchronously in the pendingInitialCommit branch above).
        const phase: PolicyPhase = win.pendingInitialCommit ? "pre-content" : "post-content";
        candidate = resolveDecisions(current, candidate, phase);

        const changed = diffState(current, candidate);
        if (changed.length === 0) return cloneState(current);

        const wasFloating = current.tiling === "floating";
        const becomingFloating = candidate.tiling === "floating";

        // Capture the initial floating rect when a window enters
        // the floating lane for the first time. The window stays
        // visually in place across the transition: its current
        // outer becomes the floating rect.
        if (!wasFloating && becomingFloating && win.floatingRect === undefined) {
          win.floatingRect = { ...win.outer };
        }

        // Capture restoreRect on entry into exclusive, restore on exit.
        const wasExclusive = current.exclusive !== "none";
        const becomingExclusive = candidate.exclusive !== "none";
        if (!wasExclusive && becomingExclusive && candidate.restoreRect === null) {
          candidate.restoreRect = { ...win.outer };
        }
        if (wasExclusive && !becomingExclusive && candidate.restoreRect !== null) {
          // restoreRect consumed; layout-driver will read it via the
          // snapshot for the destination lane (floating uses it as
          // floatingRect fallback). Clear so a subsequent re-entry
          // captures a fresh rect.
          candidate.restoreRect = null;
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
        // Stacking-axis change (parent or modal): recompute the
        // window's z and renormalize the chain. Skip if the window
        // hasn't reached first content yet (assignZForMap will run
        // from windowHasContent for that case).
        if (win.hasContent && changed.some((f) => STACKING_FIELDS.includes(f))) {
          assignZForMap(win);
          pushStack();
        }
        // Modal transitions: tether or untether focus.
        if (changed.includes("modal")) {
          if (candidate.modal && !current.modal) {
            tetherFocusOnModal(win);
          } else if (!candidate.modal && current.modal) {
            untetherFocusOnUnmodal(win, surfaceId);
          }
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
        configure.configure(win.surfaceId, 0, 0, 0, 0);
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

        // X11 has no xdg two-phase commit: sizing is owned by applyLayout,
        // so the handshake configures below are suppressed (a 0x0 configure
        // would reach the X client as a bogus 0x0 ConfigureNotify).
        const isXwayland = info.xwayland === true;
        let finalState: WindowState = cloneState(win.windowState);
        if (pluginBus) {
          const initial: WindowPreconfigureEvent = {
            surfaceId,
            appId: info.appId, title: info.title,
            xwayland: info.xwayland ?? false,
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

        // Ensure the throwaway 0x0 handshake configure has gone out. It is
        // normally sent synchronously by sendInitialConfigure (in the initial-
        // commit dispatch) so a single-roundtrip client sees it; this covers a
        // direct caller that skipped that. Sent BEFORE placement so the 0x0
        // always precedes the real tile size (the handshake invariant), and so
        // a later applyLayout clearing pendingSizeConfigure can't make this
        // fire a spurious trailing 0x0.
        if (configure && !isXwayland && !win.pendingSizeConfigure) {
          configure.configure(win.surfaceId, 0, 0, 0, 0);
          win.pendingSizeConfigure = true;
        }

        // A window is not placed into a workspace until its first content
        // commit (windowHasContent), so its tiling lane (tiled vs floating)
        // is resolved before it ever enters the layout: a window the
        // client signals as transient/fixed-size floats at that point and
        // never joins -- or reorders -- the tiled stack. The real tile-size
        // configure therefore goes out at first content, not in this
        // handshake; pendingSizeConfigure stays set here and windowHasContent
        // sends it once the window has a placed rect.

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

        // Real tile size, sent here only if placement did not already cause
        // applyLayout to send it (e.g. the window's outer was assigned before
        // this call, so the settle ran no size-changing pass). When placement
        // produced no real outer at all (no workspace plugin, or no spawn
        // output) pendingSizeConfigure stays set and windowHasContent sends
        // this configure at first content.
        if (configure && !isXwayland && win.pendingSizeConfigure
            && win.outer.width > 0 && win.outer.height > 0) {
          win.pendingSizeConfigure = false;
          const content = contentOf(win);
          configure.configure(win.surfaceId,
            content.x, content.y, content.width, content.height);
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
      // Boundary-crossing between outputs is a workspace-plugin concern
      // now: a future window-rules / interactive-drag policy will detect
      // the cross and call workspace.moveWindow to update membership. The
      // WM itself only tracks the rect.
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
            if (win.hasContent && win.windowState.visible) {
              out.push(win.surfaceId);
            }
          }
        }
        return out;
      }
      for (const w of windows) {
        if (w.hasContent && w.windowState.visible) {
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
        if (w.hasContent && w.windowState.visible) focusable.push(i);
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
      const win = windows.find((w) => w.surfaceId === surfaceId);
      if (win && ackedSerial !== null) {
        win.lastAckedSerial = Math.max(win.lastAckedSerial ?? -1, ackedSerial);
        // Map-ack hold: this commit acks our latest pre-map configure serial,
        // so it carries a buffer rendered at the tile size -- the mapping
        // commit. Release the open. If a newer configure went out since (e.g. a
        // re-place), lastConfigureSerial advanced and this ack is still behind,
        // so we keep waiting for the newer serial.
        if (win.awaitingMapAck) {
          const wantSerial = lastConfigureSerial.get(surfaceId);
          if (wantSerial !== undefined && ackedSerial >= wantSerial) {
            mapOpenedWindow(win);
          }
        }
      }
      const p = pendingResizes.get(surfaceId);
      if (!p || p.moveOnly || p.acked) return;
      if (p.serial !== null && ackedSerial !== null && ackedSerial >= p.serial) {
        p.acked = true;
        surfaceTx.evaluate();
      }
    },
  };
}

function snapshotOf(win: Window): WindowSnapshot {
  const state: { [key: string]: unknown } = {};
  for (const [k, v] of win.state.entries()) state[k] = v;
  const snap: WindowSnapshot = {
    surfaceId: win.surfaceId,
    outputId: win.outputId ?? null,
    rect: { ...win.rect },
    outer: { ...win.outer },
    hasContent: !!win.hasContent,
    contentGated: win.contentGateOwners !== undefined && win.contentGateOwners.size > 0,
    windowState: {
      tiling: win.windowState.tiling,
      exclusive: win.windowState.exclusive,
      visible: win.windowState.visible,
      modal: win.windowState.modal,
      clientRequests: { ...win.windowState.clientRequests },
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
