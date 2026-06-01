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

// Which fields of a mapped window changed since the last emit. Extend as the WM
// gains real maximized/fullscreen/geometry state (those are no-ops today).
export type WindowChangeField = "title" | "appId" | "activated";

// Emitted (coalesced per frame) when a mapped toplevel's observable state
// changes. `changed` lists the fields; the current values are included so a
// consumer never has to re-query. `activated` is keyboard-focus (active window).
export type WindowChangeEvent = {
  surfaceId: number;
  changed: WindowChangeField[];
  appId: string | null;
  title: string | null;
  activated: boolean;
};

// Decoration-provider events (core -> the matched provider plugin).
export const DECORATION_EVENT = {
  assigned: "decoration.assigned",
  deregistered: "decoration.deregistered",
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

// Compile-time assertion that the plugin-forwarded payloads stay clone-safe. If a
// field is ever added that is not structured-clone-safe, the build fails rather
// than silently passing a non-cloneable value over postMessage.
type AssignableToCloneable<T extends Cloneable> = T;
export type _MapIsCloneable = AssignableToCloneable<WindowMapEvent>;
export type _UnmapIsCloneable = AssignableToCloneable<WindowUnmapEvent>;
export type _ChangeIsCloneable = AssignableToCloneable<WindowChangeEvent>;
export type _AssignedIsCloneable = AssignableToCloneable<DecorationAssignedEvent>;
export type _DeregisteredIsCloneable = AssignableToCloneable<DecorationDeregisteredEvent>;
