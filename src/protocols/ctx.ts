// Shared context passed to every protocol handler factory.
//
// `events` is the per-interface event-sender set (built from each generated
// module's makeEvents); it is typed loosely as EventsByInterface (the precise
// per-interface Events types live in the generated .d.ts; wiring handlers to
// them is a later pass). `state` is the shared compositor state; its core
// fields are typed, with dynamic per-protocol maps allowed via the index
// signature.

import type { Addon, Resource, EventsByInterface, WaylandFd } from "../types.js";
import type { Wm } from "../wm/index.js";

export interface SurfaceRecord {
  id: number;
  resource: Resource;
  role: string | null;
  // Double-buffered commit state. Requests accumulate into `pending`; commit
  // either APPLIES it (effective-desync) or CACHES it (effective-sync subsurface)
  // until the parent commits. See wl_surface.commit + applySurfaceState.
  pending: { buffer?: Resource | null; frameCallbacks?: Resource[] };
  committed: { buffer: Resource | null };
  cached?: { buffer?: Resource | null; frameCallbacks?: Resource[] };  // sync subsurface cache
  xdgSurface: XdgSurfaceRecord | null;
  mapped?: boolean;
  hasContent?: boolean;  // a buffer has been committed + uploaded at least once
  frameCallbacks?: Resource[];
  [key: string]: unknown;
}

export interface CompositorState {
  surfaces: Map<Resource, SurfaceRecord>;
  // surfaceId -> record, for native->JS lookups keyed by the integer id (e.g. the
  // imported-surface map-on-first-content sweep).
  surfacesById?: Map<number, SurfaceRecord>;
  nextSerial: number;
  serial(): number;
  wm?: Wm;
  seat?: SeatState;
  lastCommittedSurfaceId?: number;
  // Fire all surfaces' pending wl_surface.frame callbacks (set by installProtocols;
  // called once per compositor frame). timeMs is a millisecond timestamp.
  dispatchFrameCallbacks?: (timeMs: number) => void;
  // State-query channel: snapshot compositor state (geometry/focus/stack) for
  // tests + introspection, without reading pixels. Set by installProtocols.
  query?: () => import("../query.js").StateSnapshot;
  // Per-protocol bookkeeping maps, created lazily by handlers.
  pools?: Map<Resource, { poolId: number; size: number }>;
  buffers?: Map<Resource, BufferDesc>;
  xdgSurfaces?: Map<Resource, XdgSurfaceRecord>;
  toplevels?: Map<Resource, ToplevelRecord>;
  dmabufParams?: Map<Resource, DmabufParams>;
  subsurfaces?: Map<Resource, SubsurfaceRecord>;
  // dmabuf release lifecycle: stable bufferId <-> wl_buffer maps. Native reports
  // freed bufferIds (GPU read complete) and we release the matching wl_buffer.
  dmabufBufferIds?: Map<Resource, number>;
  dmabufById?: Map<number, Resource>;
  nextBufferId?: number;
  [key: string]: unknown;
}

export interface SubsurfaceRecord {
  resource: Resource;
  surface: Resource;
  parent: Resource;
  // Applied position (output-relative-to-parent). set_position writes pendingX/Y;
  // per spec the position is applied when the PARENT surface commits, so the
  // parent's apply copies pending* -> x/y.
  x: number;
  y: number;
  pendingX: number;
  pendingY: number;
  sync: boolean;        // own mode (set_sync/set_desync); initial = true (sync)
}

export interface BufferDesc {
  resource: Resource;
  dmabuf?: boolean;
  poolId?: number;
  poolResource?: Resource;
  fd?: WaylandFd; // dmabuf buffers: the client's plane-0 fd
  offset: number;
  stride: number;
  width: number;
  height: number;
  format: number;
  modifierHi?: number;
  modifierLo?: number;
}

export interface XdgSurfaceRecord {
  resource: Resource;
  surface?: SurfaceRecord;
  role: string | null;
  configured: boolean;
  lastConfigureSerial: number;
  lastCommitSerial: number;
  toplevel?: Resource;
  geometry?: { x: number; y: number; width: number; height: number };
}

export interface ToplevelRecord {
  resource: Resource;
  xdgSurface: XdgSurfaceRecord;
  title: string | null;
  appId: string | null;
}

export interface DmabufParams {
  planes: Array<{
    fd: WaylandFd; offset: number; stride: number;
    modifierHi: number; modifierLo: number;
  }>;
  used: boolean;
}

export interface SeatFocus {
  surfaceId: number;
  surfaceRec: { resource: Resource };
  clientId: number;
  rect: { x: number; y: number; width: number; height: number };
}

// Keyboard focus policy. Pointer events (wl_pointer enter/leave/motion) always
// follow the pointer regardless; only *keyboard* focus is governed by this.
//   "follow-pointer": keyboard focus tracks the surface under the pointer.
//   "click-to-focus": keyboard focus changes only on pointer button press, and
//                     persists when the pointer moves away.
export type FocusPolicy = "follow-pointer" | "click-to-focus";

export interface FocusOptions {
  policy: FocusPolicy;
  // Give keyboard focus to a window when it maps. Helps both policies (under
  // follow-pointer it covers the case where a window maps under a stationary
  // pointer and would otherwise never get a motion event to focus it).
  focusOnMap: boolean;
}

export interface SeatState {
  pointersByClient: Map<number, Set<Resource>>;
  keyboardsByClient: Map<number, Set<Resource>>;
  // Pointer focus: the surface under the pointer (drives wl_pointer events).
  // Follows the pointer (correct Wayland semantics for pointer events).
  focus: SeatFocus | null;
  // Keyboard focus: the active surface for wl_keyboard events. Set by click and
  // on map (click-to-focus + focus-on-map), independent of pointer position.
  kbFocus: SeatFocus | null;
  handleInput(ev: import("../types.js").InputEvent): void;
  // Give keyboard focus to a freshly-mapped window (focus-on-map). Called by the
  // WM from mapWindow.
  focusWindow(surfaceId: number, surfaceRec: { resource: Resource },
              rect: { x: number; y: number; width: number; height: number }): void;
}

export interface Ctx {
  events: EventsByInterface; // per-interface event senders (built from makeEvents)
  state: CompositorState;
  addon: Addon;
}
