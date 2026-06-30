// Window-state event payloads. Shared contract between the in-core typed bus
// (events/bus.ts) and the core->plugin wire (the plugin Worker dispatches these
// to sdk.window callbacks). Defined once so the in-core object shape and the
// postMessage wire shape cannot drift.
//
// These are the "window-state stream" producers from architecture.md ("First
// decoration milestone": onMap/onUnmap + title/app_id-changed). map/unmap are
// lifecycle; change is field-level (coalesced per frame).

// Structured-clone-safe value (the postMessage transport, not JSON, so bigint is
// allowed). Mirrors the plugin envelope's Json without importing it -- events/ is
// foundational and must not depend on plugins/. The guards below enforce that the
// payloads stay assignable to this so they remain forwardable to a plugin Worker.
type Cloneable =
  | null | boolean | number | string | bigint
  | Cloneable[] | { [k: string]: Cloneable };

// Event names. Kept as a const map so emitter (core) and dispatcher (worker)
// reference identical strings.
export const WINDOW_EVENT = {
  map: "window.map",
  unmap: "window.unmap",
  change: "window.change",
  // Per-window state-bag mutation. The freeform plugin-namespaced key/value
  // store on each window (sdk.windows.setState). Separate from window.change
  // (lower-frequency, typed) and from window.committed (behavioral state).
  stateBagChanged: "window.state-bag-changed",
  // Pre-action interceptable event: someone wants to change a window's
  // behavioral state (tiling, exclusive, visible, layoutMode, layoutData,
  // constraints, parent, clientRequests). Interceptors receive the
  // current state and a candidate; they may modify the candidate
  // (return a new payload) or revert it (return the candidate with the
  // disputed field set back to current = veto). After interceptors
  // resolve, the final candidate is committed.
  proposed: "window.proposed",
  // Post-commit observe-only event: a window's behavioral state was just
  // committed. Carries previous + current + which fields changed.
  committed: "window.committed",
  // Pre-action interceptable event fired at the initial commit (after
  // get_toplevel + any client-declared set_maximized/set_min_size/etc.
  // requests, before the first xdg_toplevel.configure goes out). Carries
  // the accumulated client-declared `initialState` so a window-rules
  // plugin can override it. After interceptors resolve, the final state
  // is committed and the configure goes out. Subscribers that want to
  // observe "the window now exists" without intercepting should use
  // window.map (fires at first content).
  preconfigure: "window.preconfigure",
  // Pre-action lifecycle event: the WM is about to change a window's outer
  // tile. Fired BEFORE the compositor receives the new rect or xdg_toplevel
  // sees the configure. Await-capable: an interceptor may modify the new
  // rect, or run async work (e.g. set a transform that pre-snaps the surface
  // for an entry animation) and the WM awaits before pushing. Bounded by a
  // 100ms per-handler timeout. core-plugin-api.md §3.1.
  relayout: "window.relayout",
  // Phase 9a: a mapped toplevel has unmapped (client destroyed it or
  // disconnected) and the compositor has minted a phantom surface
  // holding a snapshot of its last visible state. The phantom sits
  // at the closing window's prior screen rect, above the content
  // layer; its lifetime is plugin-driven (via sdk.windows.destroyPhantom)
  // or the compositor's 10s backstop. core-plugin-api.md §9.
  closing: "window.closing",
  // First content commit of a mapped toplevel, gated. Fires only if a
  // 'window-opening' plugin is registered; the window is held out of the
  // draw stack until the plugin calls sdk.windows.releaseOpeningGate or
  // the backstop fires. The plugin sets initial per-surface render
  // state synchronously so the first visible frame is already
  // mid-animation. See WindowOpeningEvent.
  opening: "window.opening",
} as const;

// Stack-level events: one emit per layout pass, scoped to the full WM stack
// rather than a single window. The per-window `window.relayout` events fire
// FIRST (one per affected window in the pass, sequentially awaited); then
// `stack.relayout` fires ONCE with the post-override batch view. Plugins
// that animate group transitions (e.g. master-stack retile) consume the
// batch; plugins that override a single window's rect consume the per-window
// stream.
export const STACK_EVENT = {
  relayout: "stack.relayout",
} as const;

// `type` (not `interface`) so the payloads carry an implicit index signature and
// stay assignable to Cloneable (interfaces do not). The guards below enforce it.
export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// The kind of mapped surface. `toplevel` is the normal xdg_toplevel case;
// `layer-shell` is a zwlr_layer_surface_v1 surface (status bars, wallpapers,
// notifications). Matches the value set on LayoutWindow.role.
export type WindowMapRole = "toplevel" | "layer-shell";

// Emitted when a window maps (first content). `rect` is the core-decided
// placement (output px). `appId`/`title` are the toplevel's, resolved at emit
// time; either may be null (a client may set_app_id after its first commit --
// the window.change event then carries the update). For layer-shell surfaces,
// both are null (layer-shell carries a `namespace` instead of app_id/title;
// not surfaced on this event).
//
// `role` discriminates toplevel vs layer-shell so subscribers (status bars,
// workspace plugins, etc.) can branch without looking up the surface
// elsewhere. Omitted on emit defaults to "toplevel" at the consumer.
export type WindowMapEvent = {
  surfaceId: number;
  // The output this window was placed on (the WM's primaryOutputId at
  // addWindow time, or whatever an explicit handler picked). Carried on map
  // so subscribers (workspace, status bar, ...) don't have to look it up.
  outputId: number;
  rect: WindowRect;
  appId: string | null;
  title: string | null;
  role?: WindowMapRole;
};

// Emitted when a mapped toplevel is destroyed/unmapped.
export type WindowUnmapEvent = {
  surfaceId: number;
};

// Which fields of a mapped window changed since the last emit. Window
// behavioral state (tiling, exclusive, visible, layoutMode, ...) is NOT a
// change field -- those go through 'window.committed'. This event is for
// the metadata stream: title, appId, focus activation.
export type WindowChangeField = "title" | "appId" | "activated";

// Emitted (coalesced per frame) when a mapped toplevel's metadata changes.
// `changed` lists the fields; the current values are included so a consumer
// never has to re-query. `activated` is keyboard-focus (active window).
export type WindowChangeEvent = {
  surfaceId: number;
  changed: WindowChangeField[];
  appId: string | null;
  title: string | null;
  activated: boolean;
};

// Emitted when a per-window state-bag entry changes (sdk.windows.setState or
// deleteState). `value` is the new value, or null when the key was deleted
// (null/undefined collapse on the wire; explicit `deleted: true` differentiates
// a delete from setting null).
export type WindowStateBagChangedEvent = {
  surfaceId: number;
  key: string;
  value: unknown;
  deleted: boolean;
};

// Per-window behavioral state. Compositor-decided axes plus a stash of
// client wishes:
//   - `tiling`     -- which lane the window lives in within the layout
//                     partition (managed = tile-flow; floating = free).
//   - `exclusive`  -- does this window own the workspace by itself
//                     (maximized = tileRegion; fullscreen = full output).
//   - `visible`    -- whether the window is drawn at all (false ≡ minimized).
//   - `modal`      -- this window blocks interaction with its parent chain
//                     (focus is tethered; input on the parent is gated).
//                     A modal child of an absent parent (orphan) is treated
//                     as a top-level floating modal (no parent to gate; just
//                     stays on top of the floating peak).
//   - `parent`     -- the transient-for relationship (xdg_toplevel.set_parent,
//                     WM_TRANSIENT_FOR, xdg_foreign set_parent_of). Affects
//                     stacking (children raise with their parent under the
//                     "raise-with" rule -- see wm/index.ts assignZForMap).
//   - `layoutMode` / `layoutData` -- open vocabulary owned by the active
//                                    layout plugin; opaque to core.
//   - `constraints` -- protocol-defined fields from xdg_toplevel.set_min_size
//                      / set_max_size.
//   - `clientRequests` -- the client's STATED WISHES, set synchronously by
//                         xdg_toplevel.set_*, xdg_dialog.set_modal, etc.
//                         The compositor's policy seam (window.preconfigure
//                         for pre-content, and the resolveDecisions step on
//                         later proposals) reads these and decides whether
//                         to honor them on the decision axes above. The
//                         renderer + the configure-states encoder NEVER read
//                         these.
export type Tiling = "managed" | "floating";
export type Exclusive = "none" | "maximized" | "fullscreen";

export type ClientRequests = {
  wantsMaximized: boolean;
  wantsFullscreen: boolean;
  wantsMinimized: boolean;
  wantsModal: boolean;
};

export type WindowState = {
  // Compositor decisions (what to render; what to send in configure;
  // what to gate focus + input on):
  tiling: Tiling;
  exclusive: Exclusive;
  visible: boolean;
  modal: boolean;
  // Client wishes (read by the policy seam; not by the renderer):
  clientRequests: ClientRequests;
  layoutMode: string | null;
  layoutData: unknown;
  constraints: {
    minSize: { width: number; height: number } | null;
    maxSize: { width: number; height: number } | null;
  };
  parent: number | null;
  // The rect to restore to when leaving exclusive (maximized/fullscreen)
  // back to non-exclusive. Captured at the propose() that transitions
  // INTO exclusive and consumed at the propose() that transitions back
  // out. null until the first such transition.
  restoreRect: { x: number; y: number; width: number; height: number } | null;
};

// Why a proposal was made. Helps interceptors distinguish client intent
// from automated rules from user input. Status bars / audit logs may also
// branch on this.
export type ProposalReason =
  | "client-request"    // xdg_toplevel.set_* from a wayland client
  | "plugin"            // sdk.windows.propose from a plugin
  | "user-input"        // hotkey / pointer grab (plugin-driven, flagged
                        //   so policy plugins can prefer it over rules)
  | "window-rule"       // a window-rules plugin applying its policy
  | "core";             // core's own self-propose

// Pre-commit interceptable event. `current` is the window's state right
// now; `candidate` is what the WM would commit. An interceptor returning a
// modified payload with a different `candidate` redirects the commit; an
// interceptor returning the candidate unchanged is observe-only. Reverting
// a disputed field in `candidate` back to its value in `current` is the
// veto pattern.
export type WindowProposedEvent = {
  surfaceId: number;
  reason: ProposalReason;
  current: WindowState;
  candidate: WindowState;
};

// Post-commit observe-only event. `previous` is what the window had before;
// `current` is what it has now; `changed` lists the fields that actually
// differ (post-arbitration -- if an interceptor reverted a field, it won't
// appear here even though it was in the original proposal).
export type WindowCommittedEvent = {
  surfaceId: number;
  reason: ProposalReason;
  previous: WindowState;
  current: WindowState;
  changed: ReadonlyArray<keyof WindowState>;
};

// Pre-action interceptable event fired at the initial commit. `initialState`
// is the accumulated client-declared state at the moment the client commits
// its xdg_surface for the first time. Interceptors may modify it (return
// the payload with a different `initialState`); the final value is what the
// WM commits and what the first xdg_toplevel.configure reflects.
//
// `appId` and `title` may be null (the client may not have set them yet);
// later changes arrive via window.change. For xwayland windows the manage
// step is held until the WM_CLASS/title property reads land, so `appId`/
// `title` reflect the real values here (not null) when the client set them.
//
// `xwayland` is true for X11 clients (appId is the WM_CLASS class), false for
// native wayland toplevels. A window-rules plugin uses it to branch.
export type WindowPreconfigureEvent = {
  surfaceId: number;
  appId: string | null;
  title: string | null;
  xwayland: boolean;
  initialState: WindowState;
};

// Emitted before the WM mutates a window's outer tile.
//
// Covers three lifecycle transitions in addition to the original "rect
// changed" case:
//   - CREATED: a window just entered the WM (first-content commit before its
//     layout pass settles). oldOuter === null && oldOutputId === null.
//     newOuter / newOutputId are the freshly-assigned values.
//   - RETILED: rect change while the window stays in the stack. Both old and
//     new are non-null. Cross-output move is the same event with
//     oldOutputId !== newOutputId.
//   - DESTROYED: the window has been removed from the WM (unmap / client
//     destroy). newOuter === null && newOutputId === null. oldOuter /
//     oldOutputId are the window's last assigned values. `phantomSurfaceId`
//     is set when the closing-driver minted a phantom for the disappearing
//     window's last visible state (the surface id the plugin animates instead
//     of the gone-already real surface).
//
// `tiling` is the window's tiling mode at the moment of the event. For
// CREATED entries the value reflects the WM's resolved tiling after the
// preconfigure interceptor chain (a window-rules plugin may have flipped a
// floating dialog from "floating" to "managed" or vice versa). For DESTROYED
// entries it's the window's last tiling before unmap.
//
// `reason` is the layout pass's reason. Useful for plugins that branch on
// e.g. "output-resized" (resize without animation) vs. "mapped" (animate from
// off-screen).
//
// An interceptor may return the same shape with a different `newOuter` to
// redirect the relayout. Overrides on DESTROYED entries (newOuter null) are
// ignored -- a destroyed window can't be redirected. Returning undefined is
// observe-only.
export type WindowRelayoutEvent = {
  surfaceId: number;
  oldOuter: WindowRect | null;
  oldOutputId: number | null;
  newOuter: WindowRect | null;
  newOutputId: number | null;
  tiling: Tiling;
  reason: import("@overdraw/layout-types").LayoutReason;
  // Present only when newOuter is null AND the closing-driver minted a
  // phantom for the disappearing window's last visible state. The plugin
  // animates this surface (not the original, which is gone) and calls
  // sdk.windows.destroyPhantom when the animation completes.
  phantomSurfaceId?: number;
};

// Fired ONCE per layout pass after all per-window WindowRelayoutEvent emits
// settle. Carries every window that participated in the pass (created,
// retiled, destroyed) as a single batch -- gives plugins a coordinated view
// for cross-window animations (e.g. all tiled windows shrinking in lockstep
// when a new window joins the master-stack). Observer-only; per-window
// overrides happen via the individual WindowRelayoutEvent emits earlier in
// the pass.
//
// Cross-output moves are first-class: an entry with oldOutputId !==
// newOutputId is the same window transitioning between outputs. The plugin
// can drive a single animation from oldOuter to newOuter regardless of which
// outputs each belongs to (rects are in compositor coords).
export type StackRelayoutEvent = {
  reason: import("@overdraw/layout-types").LayoutReason;
  // The post-override values: rect modifications from per-window
  // WindowRelayoutEvent interceptors are reflected here.
  windows: Array<{
    surfaceId: number;
    oldOuter: WindowRect | null;
    oldOutputId: number | null;
    newOuter: WindowRect | null;
    newOutputId: number | null;
    tiling: Tiling;
    phantomSurfaceId?: number;
  }>;
};

// Phase 9a: emitted after a mapped toplevel has unmapped (client
// destroyed it or disconnected). `phantomSurfaceId` is a fresh
// compositor surface entry the core minted to display a snapshot
// of the closing window's last visible state at its prior screen
// rect, on top of the content layer. The plugin (typically the head
// of the 'closing-animation' namespace priority chain) manipulates
// this surface via the regular per-surface SDK (setOpacity,
// setTransform, animations.run, transitions.run with it as a scene
// input). Lifetime: plugin calls sdk.windows.destroyPhantom when
// done, OR the compositor's 10s backstop fires.
//
// `originalSurfaceId` is the now-gone toplevel's id (for plugins
// that want to correlate with a prior window.map event's data,
// e.g. a status bar that tracked the window).
//
// `rect` is the closing window's outer rect at unmap time. Same
// as `phantomSurfaceId`'s initial layout; included so plugins
// have it without an extra fetch.
//
// appId/title are the closing toplevel's, snapshotted at unmap
// time. Either may be null (a client may set_app_id after first
// commit; if it never did, both are null).
export type WindowClosingEvent = {
  phantomSurfaceId: number;
  originalSurfaceId: number;
  rect: WindowRect;
  appId: string | null;
  title: string | null;
};

// Emitted at first-content commit of a mapped toplevel, BEFORE the window
// enters the draw stack, IFF a plugin claims the 'window-opening'
// namespace. While the event is being delivered, the window is held out
// of the compositor's stack by a content gate (wm.setContentGated). The
// plugin synchronously sets initial per-surface render state (transform
// / opacity / etc.) so the very first frame the user sees is already
// mid-animation, then calls sdk.windows.releaseOpeningGate(surfaceId)
// to release the gate. A backstop timer (10s default) force-releases
// if the plugin never does, so a buggy / stuck plugin can't keep a
// window invisible indefinitely.
//
// The plugin then runs its animation asynchronously toward identity
// via sdk.animations.run -- the gate has already been released so the
// animation plays over visible frames.
//
// `outerRect` is the window's outer rect at the time of first content
// (= the layout-driver's assignment for this tile). `outputRect` is
// the rect of the output the window is mapped on, in compositor
// coordinates, so a plugin computing "slide in from the output edge"
// can do the math without a separate outputs lookup. `appId` / `title`
// may be null (client hasn't set them yet).
export type WindowOpeningEvent = {
  surfaceId: number;
  outerRect: WindowRect;
  outputId: number;
  outputRect: WindowRect;
  // The window's tiling lane ("managed" tiled vs "floating"), so the opening
  // animation can pick its entry (slide-in for tiled, fade/scale for floating)
  // without a separate state lookup.
  tiling: Tiling;
  appId: string | null;
  title: string | null;
};

// Decoration-provider events (core -> the matched provider plugin).
export const DECORATION_EVENT = {
  assigned: "decoration.assigned",
  deregistered: "decoration.deregistered",
  resized: "decoration.resized",
} as const;

// Emitted to a decoration-provider plugin when a mapped window matches its
// registered app_id pattern (match-once; first-registered match wins). The
// plugin now "owns" decorating this window: piece 2/3 will let it requestInsets
// + draw. rect is the window's current outer rect (output px).
export type DecorationAssignedEvent = {
  surfaceId: number;
  appId: string | null;
  title: string | null;
  rect: WindowRect;
};

// Emitted to a provider that was permanently deregistered by the core (currently:
// it failed to draw an assigned window's decoration within the timeout). The
// provider receives no further assignments unless it re-registers. `windowId` is
// the window whose first-frame deadline was missed.
export type DecorationDeregisteredEvent = {
  reason: string;
  windowId: number;
};

// Emitted to a decoration-provider plugin when its assigned window's OUTER tile
// changed (the tiling WM resized/moved the window: a sibling mapped/unmapped,
// the insets changed, etc.). The plugin should redraw at the new outer rect
// (destroy + recreate the ring; the ring is fixed-size at alloc).
export type DecorationResizedEvent = {
  windowId: number;
  outerRect: WindowRect;
  contentRect: WindowRect;
  insets: { top: number; right: number; bottom: number; left: number };
};

// Compile-time assertion that the plugin-forwarded payloads stay clone-safe. If a
// field is ever added that is not structured-clone-safe, the build fails rather
// than silently passing a non-cloneable value over postMessage.
//
// WindowState contains `layoutData: unknown` which is not statically
// Cloneable; the plugin author is responsible for keeping it clone-safe.
// The proposed/committed events therefore carry an unknown field and we
// can't assert them here. The bus enforces clone-safety at emit time
// (structured-clone throws on non-cloneable values).
type AssignableToCloneable<T extends Cloneable> = T;
export type _MapIsCloneable = AssignableToCloneable<WindowMapEvent>;
export type _UnmapIsCloneable = AssignableToCloneable<WindowUnmapEvent>;
export type _ChangeIsCloneable = AssignableToCloneable<WindowChangeEvent>;
export type _RelayoutIsCloneable = AssignableToCloneable<WindowRelayoutEvent>;
export type _StackRelayoutIsCloneable = AssignableToCloneable<StackRelayoutEvent>;
export type _ClosingIsCloneable = AssignableToCloneable<WindowClosingEvent>;
export type _OpeningIsCloneable = AssignableToCloneable<WindowOpeningEvent>;
export type _AssignedIsCloneable = AssignableToCloneable<DecorationAssignedEvent>;
export type _DeregisteredIsCloneable = AssignableToCloneable<DecorationDeregisteredEvent>;
export type _ResizedIsCloneable = AssignableToCloneable<DecorationResizedEvent>;
