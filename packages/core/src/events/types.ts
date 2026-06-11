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
  // Per-window state-bag mutation (core-plugin-api.md §3). Separate from
  // window.change because the state bag is high-cardinality (any plugin-
  // defined key) and would otherwise drown the lower-frequency typed
  // change stream. Plugins observing state mutations subscribe directly to
  // 'window.state-changed'.
  stateChanged: "window.state-changed",
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
} as const;

// `type` (not `interface`) so the payloads carry an implicit index signature and
// stay assignable to Cloneable (interfaces do not). The guards below enforce it.
export type WindowRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// Emitted when a toplevel maps (first content). `rect` is the core-decided
// placement (output px). `appId`/`title` are the toplevel's, resolved at emit
// time; either may be null (a client may set_app_id after its first commit --
// the window.change event then carries the update).
export type WindowMapEvent = {
  surfaceId: number;
  rect: WindowRect;
  appId: string | null;
  title: string | null;
};

// Emitted when a mapped toplevel is destroyed/unmapped.
export type WindowUnmapEvent = {
  surfaceId: number;
};

// Which fields of a mapped window changed since the last emit. Extend as the
// WM gains additional observable state. The four hint fields
// (floating/fullscreen/maximized/minimized) are populated by plugin setters
// today; client-side xdg_toplevel.set_* requests are still no-ops (status.md
// "Read first") so they remain false until those handlers land.
export type WindowChangeField =
  | "title" | "appId" | "activated"
  | "floating" | "fullscreen" | "maximized" | "minimized";

// Emitted (coalesced per frame) when a mapped toplevel's observable state
// changes. `changed` lists the fields; the current values are included so a
// consumer never has to re-query. `activated` is keyboard-focus (active window).
// Hint fields (floating/fullscreen/maximized/minimized) accompany the snapshot
// so subscribers see the full state without a separate fetch.
export type WindowChangeEvent = {
  surfaceId: number;
  changed: WindowChangeField[];
  appId: string | null;
  title: string | null;
  activated: boolean;
  floating: boolean;
  fullscreen: boolean;
  maximized: boolean;
  minimized: boolean;
};

// Emitted when a per-window state-bag entry changes (sdk.windows.setState or
// deleteState). `value` is the new value, or null when the key was deleted
// (null/undefined collapse on the wire; explicit `deleted: true` differentiates
// a delete from setting null).
export type WindowStateChangedEvent = {
  surfaceId: number;
  key: string;
  value: unknown;
  deleted: boolean;
};

// Emitted before the WM mutates a mapped toplevel's outer tile. `oldOuter` is
// the rect the window has right now; `newOuter` is what the WM is about to
// install. An interceptor may return the same shape with a different
// `newOuter` to redirect the relayout, or return undefined (observe-only) and
// optionally perform side effects (e.g. setTransform) before the WM proceeds.
export type WindowRelayoutEvent = {
  surfaceId: number;
  oldOuter: WindowRect;
  newOuter: WindowRect;
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
type AssignableToCloneable<T extends Cloneable> = T;
export type _MapIsCloneable = AssignableToCloneable<WindowMapEvent>;
export type _UnmapIsCloneable = AssignableToCloneable<WindowUnmapEvent>;
export type _ChangeIsCloneable = AssignableToCloneable<WindowChangeEvent>;
export type _RelayoutIsCloneable = AssignableToCloneable<WindowRelayoutEvent>;
export type _ClosingIsCloneable = AssignableToCloneable<WindowClosingEvent>;
export type _AssignedIsCloneable = AssignableToCloneable<DecorationAssignedEvent>;
export type _DeregisteredIsCloneable = AssignableToCloneable<DecorationDeregisteredEvent>;
export type _ResizedIsCloneable = AssignableToCloneable<DecorationResizedEvent>;
