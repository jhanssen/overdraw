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

// The placeholder id of the single output today. wl_output is fabricated
// (status.md "Read first") and core renders one output; OUTPUT_DEFAULT is the
// id every output-keyed API uses until real multi-output reconfiguration
// lands. New output handlers MUST assign real ids; this constant is the
// transitional value, not a magic default to keep.
export const OUTPUT_DEFAULT = 0;

export interface CompositorSink {
  commitSurfaceBuffer(id: number, poolId: number, offset: number, w: number,
                      h: number, stride: number): boolean;
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number,
                      fourcc: number, modHi: number, modLo: number,
                      offset: number, stride: number, bufferId: number): boolean;
  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void;
  // The `content` layer's ordered draw list (windows + subsurfaces + popups).
  // rebuildStackWithPopups remains its single owner. Acts as the DEFAULT
  // content stack; an output may override it via setOutputStack.
  setStack(ids: number[]): void;
  // Per-output content-stack override (core-plugin-api.md §1 setOutputStack).
  // When set, the named output renders this ordered id list for its content
  // layer instead of the global setStack output. Pass `null` to clear the
  // override (output falls back to the global stack). Optional so the native
  // sink (if ever used) need not implement it.
  //
  // Single-output today: outputId 0 (OUTPUT_DEFAULT) is the only valid id;
  // future multi-output reconfiguration assigns real ids.
  setOutputStack?(outputId: number, ids: number[] | null): void;
  // Set the ordered surface ids for a non-content layer (background/below/above/
  // overlay). Plugin overlays/decorations use this. Optional so the native sink
  // (if ever used) need not implement it.
  setLayerSurfaces?(layer: Layer, ids: number[]): void;
  // Install a pre-wrapped wire texture as surface `id`'s sampled texture (plugin
  // overlay consumer texture). Optional (JS compositor only).
  setSurfaceTexture?(id: number, tex: GPUTexture, w: number, h: number): void;
  // Per-surface render-state setters (core-plugin-api.md §1). Each is global
  // per surface (not per-output) and consumed by the compositor's shader every
  // frame. Optional so the native sink (if ever used) need not implement them.
  setSurfaceOpacity?(id: number, opacity: number): void;
  setSurfaceTransform?(id: number, t: import("../gpu/compositor.js").SurfaceTransform): void;
  setSurfaceOutputMargin?(id: number, m: import("../gpu/compositor.js").SurfaceMargin): void;
  // Per-channel multiplier + 4x4 matrix on the sampled rgba (Phase 5.5a).
  // The matrix is column-major (matching WGSL mat4x4f); null restores identity.
  setSurfaceTint?(id: number, t: import("../gpu/compositor.js").SurfaceTint): void;
  setSurfaceColorMatrix?(
    id: number, m: import("../gpu/compositor.js").ColorMatrix | null,
  ): void;
  // Alpha mask sampled across the surface + outputMargin region; .a modulates
  // the surface's alpha (and premultiplied rgb). null clears (default-white,
  // no visible effect). Caller owns the GPUTexture's lifetime. Reached from
  // plugins via sdk.windows.setMask -- the texture must live on the same
  // GPUDevice the compositor uses (in-thread bundled plugins share that
  // device; Worker plugins do not, so the cross-device handle path is
  // currently unimplemented for them).
  setSurfaceMask?(id: number, mask: GPUTexture | null): void;
  removeSurface(id: number): void;
  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }>;
  takeFreedBuffers(): number[];
  // Notify the compositor that a client wl_buffer was destroyed (explicit
  // wl_buffer.destroy or disconnect sweep). Drives cache invalidation in
  // the client-buffer lifecycle (rule A: along with surfaceRemoved, the
  // only path that releases a cached GPU import).
  notifyBufferDestroyed?(bufferId: number): void;
  renderFrame?(): void;
  // Run a callback once the compositing submit in flight at call time completes on
  // the GPU. The plugin/overlay ring uses this to recycle a consumer slot only
  // after the frame that last sampled it is done (avoids EndAccess racing the read).
  afterCurrentFrame?(cb: () => void): void;
  // Scene-compose primitives (core-plugin-api.md §6). Snapshot variants return
  // one-shot textures the caller owns; the live variants register a target
  // refreshed every renderFrame() until released. Optional so non-JsCompositor
  // sinks (none today) need not implement them; the SDK only constructs
  // sdk.compose when they're present.
  composeScene?(args: {
    outputId: number; windows: ReadonlyArray<number>;
    outW?: number; outH?: number;
  }): { texture: GPUTexture; outW: number; outH: number };
  composeWindows?(args: {
    outputId: number;
    windows: ReadonlyArray<{ id: number; rect?: { x: number; y: number; w: number; h: number } }>;
  }): Array<{ id: number; texture: GPUTexture;
              rect: { x: number; y: number; w: number; h: number } }>;
  registerLiveScene?(args: {
    outputId: number; windows: ReadonlyArray<number>;
    outW?: number; outH?: number;
  }): import("../gpu/compositor.js").LiveSceneHandle;
  registerLiveWindows?(args: {
    outputId: number;
    windows: ReadonlyArray<{ id: number; rect?: { x: number; y: number; w: number; h: number } }>;
  }): import("../gpu/compositor.js").LiveWindowCompHandle;
  // Phase 5b: render the listed windows into a pre-allocated target view.
  // When producerSurfaceBufId is set, the compose pass is wrapped in
  // producer Begin/End frames on the core wire keyed on that surfaceBufId
  // (cross-device dmabuf compose target).
  composeIntoView?(args: {
    outputId: number;
    targetView: GPUTextureView;
    windows: ReadonlyArray<number>;
    outW: number;
    outH: number;
    producerSurfaceBufId?: number;
  }): void;
  // Phase 5b-live: register a per-frame produce callback. Each renderFrame
  // invokes onFrame after the on-screen composite; the callback owns its
  // own SurfaceProducer + composes a fresh frame into the next FREE ring
  // slot (skipping if all slots are busy). Returns a token used to
  // unregister.
  registerLiveProducer?(onFrame: () => void): { unregister: () => void };
  // Phase 8: install a transition that replaces the on-screen pass for
  // the duration of the transition. Pulled here so the transitions
  // broker can drive the compositor through the sink interface (rather
  // than coupling to the JsCompositor class). Optional because the
  // native compositor path doesn't implement transitions today.
  setActiveTransition?(opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: import("@overdraw/transition-types").TransitionKind;
    getProgress: () => number;
    resolveTextures?: () => { fromTex: GPUTexture; toTex: GPUTexture } | null;
  }): void;
  clearActiveTransition?(): void;
  // Phase 9a: snapshot the surfaces of a closing window into a fresh
  // phantom surface entry. The phantom is a regular surface (the
  // standard per-surface setters work on it) but its texture is
  // core-owned; the lifecycle is plugin-driven (or compositor's
  // backstop). Optional because the native compositor path doesn't
  // implement phantoms today.
  createClosingPhantom?(args: {
    phantomSurfaceId: number;
    surfaceIds: ReadonlyArray<number>;
    outerRect: { x: number; y: number; w: number; h: number };
  }): number;
  // Tear down a phantom created via createClosingPhantom. Removes
  // from the draw order; destroys the snapshot texture. Idempotent.
  destroyClosingPhantom?(phantomSurfaceId: number): void;
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
  // The keyboard binding chain (input modes + chord trie). Constructed by
  // installProtocols when keyboard input is wired; the seat consults it on
  // each key-down to decide whether the event is consumed (no forward to
  // the focused client) or forwarded as usual. Plugins register bindings
  // via the windows broker (windows.input.* methods).
  bindingChain?: import("../input/binding-chain.js").BindingChain;
  // Phase 9a closing driver. When wired (a 'window-closing' plugin
  // is registered), the wl_surface unmap path consults this before
  // tearing down a mapped toplevel: if a plugin handler is present,
  // the driver snapshots the window into a phantom + emits
  // window.closing + arms a backstop timer. Absent or no-op when
  // no closing plugin is registered -- the unmap then proceeds
  // instantly (pre-phase-9a behavior).
  closingDriver?: import("./closing-driver.js").ClosingDriver;
  lastCommittedSurfaceId?: number;
  // Fire all surfaces' pending wl_surface.frame callbacks (set by installProtocols;
  // called once per compositor frame). timeMs is a millisecond timestamp.
  dispatchFrameCallbacks?: (timeMs: number) => void;
  // Run just before the per-frame renderFrame. Used by the animation
  // evaluator (core-plugin-api.md §9) to advance active animations and
  // write the new per-surface state values for this frame. Set by
  // main.ts after creating the evaluator; tests omitting an evaluator
  // leave this unset (the protocols frame sweep then just runs the
  // wl_surface.frame callbacks + renderFrame, as before).
  beforeRender?: (timeMs: number) => void;
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
  // Per-output toplevel-order filter set by sdk.windows.setOutputStack
  // (workspace plugin, etc). The protocol layer is the single owner of the
  // compositor's per-output draw stack: rebuildStackWithPopups expands each
  // filter into [toplevel, ...subsurface subtree, ...popups parented under
  // it] in the filter's toplevel order and pushes via setOutputStack. The
  // broker writes this map and triggers a rebuild; it does NOT call
  // compositor.setOutputStack directly (that would clobber subsurfaces +
  // popups, which the workspace plugin doesn't model).
  outputToplevelStacks?: Map<number, number[]>;
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

export interface SeatState {
  pointersByClient: Map<number, Set<Resource>>;
  keyboardsByClient: Map<number, Set<Resource>>;
  // The surface under the pointer (drives wl_pointer events).
  focus: SeatFocus | null;
  // The keyboard-focused surface (drives wl_keyboard events). Set by the
  // focus plugin's decide() via applyKeyboardFocus.
  kbFocus: SeatFocus | null;
  handleInput(ev: import("../types.js").InputEvent): void;
  // Called by the WM map sweep when a toplevel gains presentable content;
  // dispatches a 'window-mapped' decide() to the focus plugin.
  focusWindow(surfaceId: number, surfaceRec: { resource: Resource },
              rect: { x: number; y: number; width: number; height: number }): void;
  // Apply a focus result by surface id (null clears). Used by the focus
  // driver and by the explicit-override path sdk.windows.focus.
  applyKeyboardFocus(surfaceId: number | null): void;
  // Trigger a focus-driver decide() with the given coarse reason. The seat
  // supplies the current pointer position + surfaceUnderPointer + current
  // keyboard focus to FocusInputs. Used by policy-mediated focus callers
  // (e.g. a workspace plugin after show()) so they don't bypass the focus
  // plugin via applyKeyboardFocus. Fire-and-forget like the seat's own
  // dispatches.
  dispatchFocusEvent(reason: import("./focus-driver.js").FocusReason,
                     trigger?: number): void;
  // Topmost surface under an output-space point (for DnD hit-testing).
  pick(x: number, y: number): SeatFocus | null;
  // The last observed pointer position (output-space). Used by the
  // action-registry's deferred-ref resolver (ref.pointerX/Y). When no
  // pointer event has ever been seen, returns {x: 0, y: 0} -- matches
  // the seat's internal default.
  pointerPosition(): { x: number; y: number };
  // DnD pointer grab. While non-null, handleInput routes pointer motion/
  // button to these callbacks instead of wl_pointer.
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
