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
import type { CompositorBus } from "../events/window-bus.js";
import type { WindowChangeField } from "../events/types.js";

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
  // Set once the window's unmap teardown has run (explicit wl_surface.destroy OR
  // the resource-destroyed sweep on client disconnect). Guards against emitting
  // window.unmap / tearing down twice.
  unmapped?: boolean;
  frameCallbacks?: Resource[];
}

// The compositor operations the protocol/WM layer drives, abstracted so either
// the native C++ Compositor (addon) or the JS compositor (src/gpu/compositor.ts)
// can back them. Method names mirror the addon's, so the native sink is just the
// addon itself. `renderFrame` is optional: the native path renders on its own
// libuv timer, the JS path renders here.
// Stack layers, composited back-to-front (architecture.md "First plugin
// milestone": background < below < content < above < overlay). Client/plugin
// windows live in `content` (set via setStack, which keeps owning the
// window+subsurface+popup ordering); decorations bind to `below`/`above` of a
// window; free overlays pick a layer. This is the smallest generalization of the
// old single flat stack that lets "above/below content" be expressed without a
// full layout engine.
export type Layer = "background" | "below" | "content" | "above" | "overlay";
export const LAYER_ORDER: readonly Layer[] =
  ["background", "below", "content", "above", "overlay"];

export interface CompositorSink {
  commitSurfaceBuffer(id: number, poolId: number, offset: number, w: number,
                      h: number, stride: number): boolean;
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number,
                      fourcc: number, modHi: number, modLo: number,
                      offset: number, stride: number, bufferId: number): boolean;
  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void;
  // The `content` layer's ordered draw list (windows + subsurfaces + popups).
  // rebuildStackWithPopups remains its single owner.
  setStack(ids: number[]): void;
  // Set the ordered surface ids for a non-content layer (background/below/above/
  // overlay). Plugin overlays/decorations use this. Optional so the native sink
  // (if ever used) need not implement it.
  setLayerSurfaces?(layer: Layer, ids: number[]): void;
  // Install a pre-wrapped wire texture as surface `id`'s sampled texture (plugin
  // overlay consumer texture). Optional (JS compositor only).
  setSurfaceTexture?(id: number, tex: GPUTexture, w: number, h: number): void;
  removeSurface(id: number): void;
  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }>;
  takeFreedBuffers(): number[];
  renderFrame?(): void;
  // Run a callback once the compositing submit in flight at call time completes on
  // the GPU. The plugin/overlay ring uses this to recycle a consumer slot only
  // after the frame that last sampled it is done (avoids EndAccess racing the read).
  afterCurrentFrame?(cb: () => void): void;
}

export interface CompositorState {
  surfaces: Map<Resource, SurfaceRecord>;
  // The compositor backend (native addon or JS compositor). Set by installProtocols.
  compositor: CompositorSink;
  // surfaceId -> record, for native->JS lookups keyed by the integer id (e.g. the
  // imported-surface map-on-first-content sweep).
  surfacesById?: Map<number, SurfaceRecord>;
  nextSerial: number;
  serial(): number;
  wm?: Wm;
  // Settable indirection: when the WM detects a decorated window's outer tile
  // changed (relayout/insets), it calls this hook so the decoration broker can
  // forward decoration.resized to the owning plugin. The WM itself doesn't know
  // about the broker; main.ts (and the GPU tests) wires this up after creating
  // the broker. Absent for GPU-free unit tests / when no broker is present.
  decorationResize?: (windowId: number,
                      outerRect: { x: number; y: number; width: number; height: number },
                      contentRect: { x: number; y: number; width: number; height: number },
                      insets: { top: number; right: number; bottom: number; left: number }) => void;
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
  // xdg_positioner state (consumed at get_popup). Keyed by the positioner resource.
  positioners?: Map<Resource, import("../popup-position.js").Positioner>;
  // xdg_popup records. Keyed by the xdg_popup resource.
  popups?: Map<Resource, PopupRecord>;
  // The xdg_popup that currently holds an input grab (dismiss on click-outside).
  grabbedPopup?: Resource;
  // On a pointer button press, the seat calls this with the output-space point;
  // if a grabbing popup exists and the press is outside it, the popup is dismissed
  // (popup_done) and this returns true so the seat swallows the click. Set by
  // installProtocols.
  dismissGrabbedPopup?: (x: number, y: number) => boolean;
  dmabufParams?: Map<Resource, DmabufParams>;
  subsurfaces?: Map<Resource, SubsurfaceRecord>;
  // dmabuf release lifecycle: stable bufferId <-> wl_buffer maps. Native reports
  // freed bufferIds (GPU read complete) and we release the matching wl_buffer.
  dmabufBufferIds?: Map<Resource, number>;
  dmabufById?: Map<number, Resource>;
  nextBufferId?: number;
  // Clipboard (wl_data_device selection). `sources` maps a wl_data_source to its
  // offered mime types. `dataDevices` maps a clientId to that client's
  // wl_data_device resources. `selection` is the current clipboard source (or
  // null). See src/protocols/wl_data_device_manager.ts.
  dataSources?: Map<Resource, { mimes: string[]; dndActions?: number }>;
  dataDevices?: Map<number, Set<Resource>>;
  selection?: Resource | null;
  // Primary selection (zwp_primary_selection_*): same shape as clipboard, separate
  // state. middle-click paste.
  primarySources?: Map<Resource, { mimes: string[] }>;
  primaryDevices?: Map<number, Set<Resource>>;
  primarySelection?: Resource | null;
  // Core-internal event bus. Producers (this layer + the seat) emit window/
  // keyboard events; subscribers (the plugin-forwarding layer in main.ts, the
  // clipboard layer, the future decoration registry) listen. Set by
  // installProtocols. Optional so GPU-free protocol tests can omit it.
  bus?: CompositorBus;
  // Per-frame change coalescing: surfaceId -> set of fields that changed since the
  // last flush. The frame sweep drains this into window.change events. Populated
  // by set_title/set_app_id and keyboard-focus changes. Created lazily.
  pendingWindowChanges?: Map<number, Set<WindowChangeField>>;
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
  popup?: Resource;
  geometry?: { x: number; y: number; width: number; height: number };
  // Tiling configure cycle: the content size the WM last asked this toplevel to
  // adopt (sent via xdg_toplevel.configure). Used to avoid re-sending a configure
  // for an unchanged size. Undefined until the WM has configured a size.
  configuredWidth?: number;
  configuredHeight?: number;
}

// An xdg_popup: a compositor-positioned child of a parent xdg_surface. The
// computed rect is parent-relative (in the parent's window-geometry space).
export interface PopupRecord {
  resource: Resource;            // xdg_popup
  xdgSurface: XdgSurfaceRecord;  // the popup's xdg_surface
  parent: XdgSurfaceRecord;      // parent xdg_surface (toplevel or another popup)
  rect: { x: number; y: number; width: number; height: number }; // parent-relative
  positioner: import("../popup-position.js").Positioner;
  mapped: boolean;
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
  // Topmost surface under an output-space point (for DnD hit-testing).
  pick(x: number, y: number): SeatFocus | null;
  // DnD pointer grab. While non-null, handleInput routes pointer motion/button to
  // these callbacks instead of wl_pointer. Set/cleared by the data-device module
  // via beginDrag/endDrag.
  drag: DragGrab | null;
  beginDrag(d: DragGrab): void;
  endDrag(): void;
}

// Callbacks the data-device DnD machinery installs on the seat during a drag.
export interface DragGrab {
  onMotion(x: number, y: number, hit: SeatFocus | null): void;
  onButton(pressed: boolean): void;
}

export interface Ctx {
  events: EventsByInterface; // per-interface event senders (built from makeEvents)
  state: CompositorState;
  addon: Addon;
}
