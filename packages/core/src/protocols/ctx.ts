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

// Pending region-set state: undefined = no set_*_region call this commit
// cycle (region stays whatever was applied previously); null = the client
// explicitly passed NULL (an infinite-extent region); a Region = the
// snapshot taken at commit time from the wl_region resource the client
// passed. wl_surface.set_input_region / set_opaque_region store the
// CURRENT region resource here; commit() snapshots it via Region.clone().
type RegionSlot = import("./region.js").Region | null | undefined;

// A damage rectangle (wl_surface.damage / damage_buffer). `damage` rects are
// surface-local; `damage_buffer` rects are buffer-local. Both accumulate
// double-buffered and are reconciled to buffer coordinates on commit.
type DamageRect = import("./region.js").RegionRect;

// wp_viewport source crop (surface coordinates) and destination size.
export interface ViewportSrc { x: number; y: number; width: number; height: number }
export interface ViewportDst { width: number; height: number }

// wp_linux_drm_syncobj_v1 acquire/release timeline points captured at commit.
// The timeline handle is the per-DRM-fd handle returned by addon.syncobjImportTimeline
// (kept alive by the wp_linux_drm_syncobj_timeline_v1 resource). The point is a
// 64-bit value stored as (hi, lo) u32s to match the wire encoding.
export interface SyncobjPoint {
  // Resource of the wp_linux_drm_syncobj_timeline_v1 that owns the DRM handle.
  // Holding the resource lets a teardown sweep find the syncobj record (which
  // owns the kernel-side handle); set_acquire_point / set_release_point store
  // both the resource and the handle so the commit path doesn't need to
  // re-look-up.
  timelineResource: import("../types.js").Resource;
  handle: number;     // DRM syncobj handle (per-addon.syncobjFd context)
  pointHi: number;
  pointLo: number;
}

export interface SurfaceRecord {
  id: number;
  resource: Resource;
  // The role assigned to this wl_surface. Values used today:
  //   "xdg_toplevel" | "xdg_popup" | "cursor" | "layer_surface"
  // null until a role is assigned. Once non-null, the wl_surface cannot
  // be re-roled (the role protocols enforce this; cross-role assignment
  // posts the appropriate protocol error).
  role: string | null;
  // Double-buffered commit state. Requests accumulate into `pending`; commit
  // either APPLIES it (effective-desync) or CACHES it (effective-sync subsurface)
  // until the parent commits. See wl_surface.commit + applySurfaceState.
  //
  // `pendingInputRegion` / `pendingOpaqueRegion` hold the wl_region resource
  // (or null = infinite) the client passed via set_*_region since the last
  // commit. On commit, the region's CURRENT rect list is snapshotted to
  // `inputRegion` / `opaqueRegion` (copy semantics; the client can destroy
  // the region resource immediately).
  pending: {
    buffer?: Resource | null;
    frameCallbacks?: Resource[];
    inputRegion?: Resource | null;
    opaqueRegion?: Resource | null;
    bufferScale?: number;
    // wl_surface.set_buffer_transform (double-buffered): wl_output.transform
    // enum 0..7. Default 0 (normal).
    bufferTransform?: number;
    // wp_viewport state (double-buffered): undefined = unchanged this cycle,
    // null = unset/clear, value = set. src crop in surface coords; dst is the
    // surface's logical size override.
    viewportSrc?: ViewportSrc | null;
    viewportDst?: ViewportDst | null;
    // Damage accumulated since the last commit. surfaceDamage is in
    // surface-local coords (wl_surface.damage); bufferDamage is in buffer
    // coords (wl_surface.damage_buffer). Promoted to `committed` on commit.
    surfaceDamage?: DamageRect[];
    bufferDamage?: DamageRect[];
    // wp_linux_drm_syncobj_v1 timeline points set since the last commit.
    // Cleared (set to undefined) on commit -- the spec is clear that
    // points apply to exactly one commit and are not carried over.
    syncobjAcquire?: SyncobjPoint;
    syncobjRelease?: SyncobjPoint;
  };
  committed: {
    buffer: Resource | null; bufferScale?: number; bufferTransform?: number;
    // Damage for the committed buffer, consumed (and cleared) by the upload.
    surfaceDamage?: DamageRect[];
    bufferDamage?: DamageRect[];
    // The release timeline point the compositor must signal once it is done
    // sampling the committed buffer. Set from pending on commit; consumed by
    // the GPU-completion path (queue.onSubmittedWorkDone -> syncobjTimelineSignal)
    // and then cleared. Acquire is NOT stored here -- it's exported into a
    // sync_file and handed straight to the GPU process at commit time, so the
    // surface record never holds a fence fd.
    syncobjRelease?: SyncobjPoint;
  };
  cached?: {
    buffer?: Resource | null;
    frameCallbacks?: Resource[];
    inputRegion?: Resource | null;
    opaqueRegion?: Resource | null;
    bufferScale?: number;
    bufferTransform?: number;
    viewportSrc?: ViewportSrc | null;
    viewportDst?: ViewportDst | null;
    surfaceDamage?: DamageRect[];
    bufferDamage?: DamageRect[];
    syncobjAcquire?: SyncobjPoint;
    syncobjRelease?: SyncobjPoint;
  };
  // Set once the client has called wp_linux_drm_syncobj_manager_v1.get_surface
  // for this wl_surface. While set, the surface is in explicit-sync mode: an
  // acquire+release point MUST accompany every buffer-attaching commit (per
  // protocol; silent-drop on violation in this compositor today), and
  // wl_buffer.release is suppressed -- the client gets release signaling
  // exclusively via the release_point.
  syncobjEnabled?: boolean;
  // One-shot per-commit slot: the acquire point promoted from `pending`
  // during commit, consumed by the dmabuf-upload path that exports a
  // sync_file and hands it to the compositor. Lives outside `committed`
  // because it is fence-fd material, not state to keep around across
  // frames; cleared as soon as uploadBuffer reads it.
  acquireForUpload?: SyncobjPoint;
  // Applied viewport state (from wp_viewport, double-buffered on commit).
  viewportSrc?: ViewportSrc | null;
  viewportDst?: ViewportDst | null;
  // True once a wp_viewport has been created for this surface (one per surface).
  hasViewport?: boolean;
  // Applied input region. Used for hit-testing in surface-local coords.
  // null = "infinite" (whole surface accepts input -- the spec's initial
  // state). A non-null empty Region (no rects) = "no input anywhere" --
  // the surface is click-through.
  inputRegion?: RegionSlot;
  // Applied opaque region. A rendering hint to the compositor about which
  // sub-rect of the surface is fully opaque (no alpha). Not currently
  // consumed; stored for future use (alpha-aware overdraw skipping).
  opaqueRegion?: RegionSlot;
  xdgSurface: XdgSurfaceRecord | null;
  // Non-null when this wl_surface has the zwlr_layer_surface_v1 role
  // (role === "layer_surface"). Exclusive with xdgSurface (a wl_surface
  // has at most one role).
  layerSurface?: LayerSurfaceRecord | null;
  mapped?: boolean;
  hasContent?: boolean;  // a buffer has been committed + uploaded at least once
  // Set once the window's unmap teardown has run (explicit wl_surface.destroy OR
  // the resource-destroyed sweep on client disconnect). Guards against emitting
  // window.unmap / tearing down twice.
  unmapped?: boolean;
  frameCallbacks?: Resource[];
  // The outputId the surface was spawned on (xdg_surface.get_toplevel
   // resolves it from spawn-follows-pointer or an explicit hint). Carried
   // here so the bus's window.map emission can include it without going
   // through the WM. Undefined for non-toplevel surfaces (popups,
   // subsurfaces) and pre-role surfaces. Layer-shell surfaces don't use
   // this -- their outputId lives on LayerSurfaceRecord.output.
  spawnOutputId?: number;
  // Outputs the surface has been told it occupies via wl_surface.enter.
  // Updated by updateSurfaceOutputResidency: diff the compositor's
  // surfaceOutputs(id) against this set, emit enter for each newly-overlapped
  // outputId, leave for each newly-disjoint one. The diff is the only signal
  // a client gets about which monitor its window is on (M6).
  enteredOutputs?: Set<number>;
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

// The id of the first/primary output. Used as the seed for state.outputs at
// installProtocols, the default destination for newly-mapped windows, and the
// fallback for protocol entry points that take a NULL or unrecognized output
// arg. Higher outputIds (1, 2, ...) are assigned by the GPU process for
// additional connectors.
export const OUTPUT_DEFAULT = 0;

// The id of the virtual fallback output (`state.fallbackOutput`). Negative
// so it can never collide with a dense connector id (which is always >= 0).
// Workspaces park here when no real output resolves their preferredOutputs;
// no rendering, IPC, or wl_output binding ever touches it.
export const OUTPUT_FALLBACK = -1;

// Reserved durable identifier for the virtual fallback output. Real
// connector names follow patterns like "DP-1", "HDMI-A-2"; the double
// underscore prefix guarantees no collision with anything DRM produces.
export const FALLBACK_OUTPUT_NAME = "__fallback__";

export interface CompositorSink {
  // `damage` (optional) lists buffer-pixel rects that changed since the last
  // commit; when present the sink may upload only those rects instead of the
  // whole buffer. Omitted/empty = full-surface upload. Sinks that don't
  // optimize partial uploads ignore it.
  commitSurfaceBuffer(id: number, poolId: number, offset: number, w: number,
                      h: number, stride: number,
                      damage?: ReadonlyArray<DamageRect>): boolean;
  // `acquireFenceFd` (optional) is a sync_file fd exported by the protocol
  // layer from a wp_linux_drm_syncobj_v1 acquire point. When present, the
  // compositor passes it to the GPU process at the next BeginAccess for this
  // bufferId, INSTEAD of the GPU process's implicit-sync EXPORT_SYNC_FILE.
  // The compositor takes ownership of the WaylandFd (closes / consumes it).
  // Omit for implicit-sync clients.
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number,
                      fourcc: number, modHi: number, modLo: number,
                      offset: number, stride: number, bufferId: number,
                      acquireFenceFd?: WaylandFd): boolean;
  // wp_linux_drm_syncobj_v1: record the release timeline point bound to
  // `bufferId`. Signaled when the client-buffer-lifecycle emits sendWlRelease
  // for the same bufferId (i.e. the buffer is superseded on its surface AND
  // its last GPU sample completed) -- the same semantic as wl_buffer.release.
  // Signaling earlier (e.g. on every submit completion) would tell the
  // client it can reuse a buffer that the compositor is still presenting.
  // Optional: GPU-free test sinks may omit it (release signaling is then a
  // no-op).
  setBufferReleasePoint?(bufferId: number, handle: number,
                         pointHi: number, pointLo: number): void;
  setSurfaceLayout(id: number, x: number, y: number, w: number, h: number): void;
  // Resize transaction: freezeSurface synchronously snapshots the surface's
  // current appearance so it keeps showing its pre-resize frame while the WM
  // holds a resize; thawSurface drops the snapshot and resumes the live buffer.
  // surfaceReadyAt reports whether the surface has a drawable buffer at a given
  // logical size (the WM gates the thaw on it, since dmabuf imports are async).
  // setFrozenReadyHandler registers a callback fired when a frozen surface's new
  // buffer becomes drawable (so the WM re-checks readiness). All optional
  // (GPU-free test sinks omit them; the WM degrades to the ack-serial gate).
  freezeSurface?(id: number): void;
  thawSurface?(id: number): void;
  surfaceReadyAt?(id: number, w: number, h: number): boolean;
  setFrozenReadyHandler?(cb: (id: number) => void): void;
  // Buffer scale (wl_surface.set_buffer_scale): device pixels per logical
  // pixel in the surface's buffer. The surface's intrinsic logical size is
  // buffer dims / bufferScale. Default 1.
  setSurfaceBufferScale?(id: number, scale: number): void;
  // wl_surface.set_buffer_transform: wl_output.transform enum (0..7). The
  // buffer is sampled with this orientation undone; 90/270 swap the surface's
  // logical w/h. Default 0.
  setSurfaceBufferTransform?(id: number, transform: number): void;
  // wp_viewport: dst overrides the surface's logical size; src crops the
  // sampled buffer region (surface coords). null clears either.
  setSurfaceViewport?(id: number, dst: ViewportDst | null, src: ViewportSrc | null): void;
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
  // Analytic shape mask: rounded rect / per-corner / superellipse. The
  // compositor evaluates an SDF in the fragment shader and multiplies the
  // coverage into the surface's premultiplied output -- composes with the
  // optional alpha mask. null = rectangle (default; shader early-out).
  // Radii are in surface LOGICAL pixels.
  setSurfaceShape?(id: number, shape: import("../gpu/compositor.js").SurfaceShape): void;
  removeSurface(id: number): void;
  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }>;
  takeFreedBuffers(): number[];
  // Which output ids overlap this surface's current rect. Empty for an
  // unmapped / off-screen surface. Used by the per-output frame-callback
  // dispatch (a surface on a 60Hz output gets wl_callback.done at 60Hz).
  surfaceOutputs?(surfaceId: number): number[];
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
  // Install a transition that replaces the on-screen pass on `outputId`
  // for the duration of the transition. Pulled here so the transitions
  // broker can drive the compositor through the sink interface (rather
  // than coupling to the JsCompositor class). Optional because the
  // native compositor path doesn't implement transitions today.
  // Per-output: each output owns its own active-transition slot;
  // simultaneous transitions on different outputs are allowed.
  setActiveTransition?(outputId: number, opts: {
    fromTex: GPUTexture;
    toTex: GPUTexture;
    kind: import("@overdraw/transition-types").TransitionKind;
    getProgress: () => number;
    resolveTextures?: () => { fromTex: GPUTexture; toTex: GPUTexture } | null;
  }): void;
  clearActiveTransition?(outputId: number): void;
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

  // Phase 10a buffer intercept: route a surface's sampled texture
  // through a plugin-supplied view. The intercept broker drives this
  // each frame after invoking the plugin's render callback. Optional
  // `placement` overrides the surface's WM-assigned rect for the
  // compose pass only (the outputRect return). Clearing reverts the
  // surface to its client texture for compositing.
  installInterceptOutput?(surfaceId: number, view: GPUTextureView,
                          placement: { x: number; y: number; w: number; h: number } | null): void;
  clearInterceptOutput?(surfaceId: number): void;
  // Phase 10a: the broker queries these per frame to drive the
  // intercept's render callback. surfaceClientTexture returns the
  // current sampled client texture for the surface (the input the
  // plugin will read from). surfaceIsPresentable gates the per-frame
  // render dispatch to surfaces actually being composited.
  surfaceClientTexture?(surfaceId: number): { texture: GPUTexture; w: number; h: number } | null;
  surfaceIsPresentable?(surfaceId: number): boolean;
  // Phase 10a Worker intercept: copy the surface's currently-
  // committed client texture into a dmabuf the Worker plugin
  // samples. Both textures are on the core device; the dmabuf was
  // allocated via AllocComposeBuf. The copy is wrapped in producer
  // Begin/End on the core wire so the plugin's consumer Begin
  // chains on the produced fence. The caller (SurfaceProducer)
  // wrote the producer Begin before this; the matching End is
  // written by presentSync() after. Returns true on success; false
  // if the surface has no committed texture.
  copyClientToInterceptInputSlot?(args: {
    surfaceId: number;
    dstTex: GPUTexture;
  }): boolean;

  // Phase 9c: software cursor slot. The cursor draws above every other
  // layer; visibility + texture-installed gate inclusion. Install paths:
  //   setCursorPixels  -- CPU BGRA8 bytes (theme resolver output,
  //                       plugin setImage in-thread).
  //   setCursorFromSurface -- point the slot at an existing surface
  //                       whose buffer pipeline drives its texture
  //                       (wl_pointer.set_cursor client surface).
  //   setCursorTexture -- already-on-device GPUTexture (test fixtures).
  // setCursorPosition takes pointer coordinates; the cursor draws at
  // (pointer - hotspot). All optional: GPU-free harnesses skip cursor
  // compositing.
  setCursorPixels?(bytes: Uint8Array,
                   width: number, height: number,
                   hotspotX: number, hotspotY: number): void;
  setCursorFromSurface?(surfaceId: number | null,
                        hotspotX: number, hotspotY: number): void;
  setCursorTexture?(tex: GPUTexture, width: number, height: number,
                    hotspotX: number, hotspotY: number): void;
  setCursorPosition?(x: number, y: number): void;
  setCursorVisible?(visible: boolean): void;
  clearCursor?(): void;
}

export interface CompositorState {
  surfaces: Map<Resource, SurfaceRecord>;
  // The compositor backend (native addon or JS compositor). Set by installProtocols.
  compositor: CompositorSink;
  // Per-interface event senders, built once by installProtocols. Exposed on
  // state so re-emit functions outside the handler-factory closure (e.g.
  // reemitWlOutput called from main.ts's output-changed bus subscriber)
  // can dispatch the same events handlers would.
  events?: import("../types.js").EventsByInterface;
  // Bound wl_output resources keyed by outputId. wl_output.bind populates
  // this; reemitWlOutput walks it on output reconfigure. State-scoped (not
  // module-level) so test fixtures get a fresh map per ctx.
  wlOutputResources?: Map<number, Set<Resource>>;
  // Bound zxdg_output_v1 resources keyed by their underlying outputId. Same
  // shape and lifetime as wlOutputResources.
  xdgOutputResources?: Map<number, Set<Resource>>;
  // wp_viewport resource -> its wl_surface resource (one viewport per surface).
  viewports?: Map<Resource, Resource>;
  // wp_linux_drm_syncobj_timeline_v1 resource -> the DRM syncobj handle the
  // addon imported from the client's fd (drmSyncobjFDToHandle). Destroying the
  // timeline resource releases the handle (drmSyncobjDestroy).
  syncobjTimelines?: Map<Resource, number>;
  // wp_linux_drm_syncobj_surface_v1 resource -> the wl_surface resource it is
  // bound to. The surface record carries the per-commit acquire/release points;
  // this reverse map exists so the surface object's destroy can clear
  // syncobjEnabled on the wl_surface, and so manager.get_surface can detect a
  // double-create (surface_exists).
  syncobjSurfaces?: Map<Resource, Resource>;
  // Reverse: wl_surface -> wp_linux_drm_syncobj_surface_v1, for the
  // surface_exists check in manager.get_surface.
  syncobjSurfaceBySurface?: Map<Resource, Resource>;
  // Bound wp_fractional_scale_v1 resources mapped to their associated
  // wl_surface (the `surface` arg of get_fractional_scale). The mapping
  // drives per-surface scale selection: re-emit picks the scale of the
  // surface's primary output (the one with the largest overlap area).
  fractionalScaleResources?: Map<Resource, Resource>;
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
  // Phase 9c: cursor kinematic state machine. Pointer motion events in
  // wl_seat feed it; the cursor rule engine reads its snapshot per frame.
  // Absent in GPU-free harnesses that don't bring up cursor support.
  cursorKinematics?: import("../cursor/kinematics.js").Kinematics;
  // wl_region resources keyed by their wl_resource. The wl_region handler
  // accumulates add/subtract into the corresponding Region object.
  // wl_surface.set_input_region / set_opaque_region snapshot the region's
  // rect list at commit time (copy semantics per spec).
  regions?: Map<import("../types.js").Resource, import("./region.js").Region>;
  // Hook the seat invokes on interactive-grab start/end to install the
  // appropriate XCursor theme shape ('move' for moves; 'top_left_corner'
  // etc. for resizes). null means "restore the default cursor." Wired
  // by main.ts; unset in GPU-free tests, where the grab runs without a
  // shape change.
  installGrabCursor?(shape: string | null): void;
  lastCommittedSurfaceId?: number;
  // Fire all surfaces' pending wl_surface.frame callbacks (set by installProtocols;
  // called once per compositor frame). timeMs is a millisecond timestamp.
  dispatchFrameCallbacks?: (timeMs: number) => void;
  // Per-output wl_callback.done dispatch, fired by the addon on each KMS
  // ScanoutFlipComplete. Sends done only to callbacks whose surface overlaps
  // `outputId` -- so a 60Hz surface is paced at 60Hz even when a 240Hz peer
  // output is also flipping. Set alongside dispatchFrameCallbacks.
  dispatchFrameCallbacksForOutput?: (timeMs: number, outputId: number) => void;
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
  // Per-parent child order: wl_surface (parent) -> ordered list of
  // wl_subsurface resources, bottom-to-top among siblings. Created on
  // wl_subcompositor.get_subsurface (new child appended at the top).
  // Mutated by place_above / place_below applied at parent commit.
  // childrenOf() reads this list instead of iterating the subsurfaces
  // map so sibling reorder takes effect.
  subsurfaceOrder?: Map<Resource, Resource[]>;
  // Per-parent pending sibling-reorder operations, drained on parent
  // commit. Double-buffered per spec; multiple ops between commits
  // apply in arrival order against the child list.
  subsurfacePendingOrder?: Map<Resource, SubsurfaceOrderOp[]>;
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
  // zwlr_layer_surface_v1 records, keyed by the layer-surface resource.
  // The role state for every layer-shell surface lives here; the WM is NOT
  // aware of these (they go through setLayerSurfaces, not addWindow).
  layerSurfaces?: Map<Resource, LayerSurfaceRecord>;
  // Reverse index: wl_surface -> layer-surface record. Lets wl_surface.commit
  // / unmapAndTeardownSurface find the layer-surface role record by the
  // wl_surface alone.
  layerSurfacesBySurface?: Map<Resource, LayerSurfaceRecord>;
  // Reserved-zone registry: tracks which output edges have reserved bands
  // (layer-shell exclusive zones today). The WM's layout driver consults it
  // via effectiveRect() to compute the tile region. Single shared instance
  // for the lifetime of the compositor; installProtocols creates it.
  reservedZones?: import("../wm/reserved-zones.js").ReservedZoneRegistry;
  // Output registry: per-output identity + geometry consumed by wire layers
  // that need to describe outputs (xdg-output today; future wl_output-on-
  // change emissions). One entry per real connector reported by the GPU
  // process; never includes the virtual fallback (that lives in
  // `fallbackOutput`).
  outputs?: Map<number, OutputRecord>;
  // The virtual fallback output. Always present once installProtocols runs;
  // never scanned out; deliberately NOT a member of `outputs` so every
  // iteration over the live output map (render passes, wl_output globals,
  // xdg-output emit, layout-driver per-output loop, IPC enumeration) skips
  // it automatically. The workspace migration policy is its only consumer:
  // when no real output resolves a workspace's preferredOutputs list, the
  // workspace parks here -- its windows stay alive in the WM tree, clients
  // keep running, nothing is presented. Its `id` is a reserved sentinel
  // (OUTPUT_FALLBACK = -1) and its `name` is the reserved durable
  // identifier "__fallback__" (no real connector ever produces this).
  fallbackOutput?: OutputRecord;
  // The plugin-visible dynamic bus (carries window.committed / window.proposed
  // / window.relayout / arbitrary plugin events). Stored on state so handlers
  // outside installProtocols (e.g. foreign-toplevel-manager) can subscribe.
  // Absent in GPU-free harnesses that don't pass a pluginBus.
  pluginBus?: import("../events/dynamic-bus.js").DynamicBus;
  // Per-layer ordered surface ids contributed by the overlay broker. Set
  // by the broker when it's constructed (main.ts wires this); read by
  // layer-stack.ts's rebuild to merge with layer-shell surfaces before
  // pushing to setLayerSurfaces. Excludes the "content" layer (which the
  // WM stack owns).
  overlayLayerIds?: (layer: Exclude<Layer, "content">) => number[];
  // Schedule a WM layout pass with the given reason. Set by installProtocols
  // after the WM is constructed; reachable from layer-shell apply paths so a
  // reserved-zone change reflows tiled / maximized windows. Absent in
  // GPU-free harnesses that bring up the protocol layer without a real WM.
  relayout?: (reason: import("@overdraw/layout-types").LayoutReason) => void;
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

// One pending sibling-reorder operation accumulated between parent commits.
// place_above / place_below requests are double-buffered per spec: they go
// into the parent's pending queue; on parent commit, the queue is drained
// in order against the parent's child list. `subsurface` is the
// wl_subsurface resource whose order is changing; `sibling` is the
// wl_surface of another subsurface (or the parent's wl_surface) it
// should be placed relative to.
export interface SubsurfaceOrderOp {
  op: "above" | "below";
  subsurface: Resource;   // wl_subsurface resource
  sibling: Resource;      // wl_surface resource of the reference
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
  // The serial of the last xdg_toplevel.configure sent, or null if no
  // configure has been sent yet. The initial-commit detection in
  // wl_surface.commit uses this to identify the first commit.
  lastConfigureSerial: number | null;
  lastCommitSerial: number;
  toplevel?: Resource;
  popup?: Resource;
  geometry?: { x: number; y: number; width: number; height: number };
  // Tiling configure cycle: the content size the WM last asked this toplevel to
  // adopt (sent via xdg_toplevel.configure). Used to avoid re-sending a configure
  // for an unchanged size. Undefined until the WM has configured a size.
  configuredWidth?: number;
  configuredHeight?: number;
  // Highest xdg_surface.configure serial the client has acked. The WM resize
  // transaction matches this against the serial of the configure it sent for a
  // window's new size to know when the client has accepted it. Undefined until
  // the first ack.
  lastAckedSerial?: number;
}

// An xdg_popup: a compositor-positioned child surface. `parent` is the
// xdg_surface parent when present (the normal xdg-shell case: toplevel or
// nested popup). When the popup was created with a NULL parent via
// xdg_surface.get_popup AND subsequently re-parented via
// zwlr_layer_surface_v1.get_popup, `parent` is null and `layerParent`
// carries the owning layer surface. Exactly one of `parent` / `layerParent`
// is non-null on a fully-parented popup; both null is the transient state
// between xdg_surface.get_popup(NULL) and the layer-shell get_popup call.
// `rect` is parent-relative (in the parent's surface-local space; for a
// layer-shell parent that's the layer-surface's output-space rect origin).
export interface PopupRecord {
  resource: Resource;                       // xdg_popup
  xdgSurface: XdgSurfaceRecord;             // the popup's xdg_surface
  parent: XdgSurfaceRecord | null;          // parent xdg_surface; null when layer-parented
  layerParent?: LayerSurfaceRecord | null;  // set by zwlr_layer_surface_v1.get_popup
  rect: { x: number; y: number; width: number; height: number };
  positioner: import("../popup-position.js").Positioner;
  mapped: boolean;
}

export interface ToplevelRecord {
  resource: Resource;
  xdgSurface: XdgSurfaceRecord;
  title: string | null;
  appId: string | null;
}

// One output's identity + logical geometry in the global compositor space.
// `id` is the stable per-output id (OUTPUT_DEFAULT today). `logicalPosition`
// + `logicalSize` are the values xdg-output reports verbatim; they are the
// rect the WM places windows into. `name` is a short stable identifier
// (e.g. "DP-1") used by clients (waybar) to key per-output configuration;
// `description` is a longer human-readable label.
//
// Mode/transform/physical fields source wl_output's geometry and mode events
// (drm-design.md "Output configuration"). `refreshMhz` is Hz * 1000;
// `transform` is the wl_output.transform enum value (0=normal, 1=90, 2=180,
// 3=270, 4..=flipped); physical dims are millimeters (0 = unknown). `make`
// and `model` are the wl_output.geometry strings.
export interface OutputRecord {
  id: number;
  logicalPosition: { x: number; y: number };
  logicalSize: { width: number; height: number };
  // Physical scanout/render-target size in device pixels. logicalSize =
  // round(deviceSize / scale). Equal to logicalSize when scale is 1.
  deviceSize: { width: number; height: number };
  scale: number;
  name: string;
  description: string;
  refreshMhz: number;
  transform: number;
  physicalWidthMm: number;
  physicalHeightMm: number;
  make: string;
  model: string;
}

// Protocol-level layer enum from zwlr_layer_shell_v1.layer. Uses the
// protocol's spelling ("bottom"); converted to the compositor's Layer type
// ("below") at the rendering boundary.
export type LayerShellLayer = "background" | "bottom" | "top" | "overlay";

// Protocol-level anchor bitfield encoding from zwlr_layer_surface_v1.anchor:
// top=1 | bottom=2 | left=4 | right=8. Stored as a number; helpers in
// layer-shell-position.ts decode it.
export type LayerShellAnchor = number;

// Protocol-level keyboard-interactivity enum.
export type LayerShellKeyboardInteractivity = "none" | "exclusive" | "on_demand";

// One snapshot of the double-buffered zwlr_layer_surface_v1 state. Stored
// in pending until wl_surface.commit applies it. Each field is optional:
// undefined = "not changed since last commit".
export interface LayerSurfacePending {
  width?: number;
  height?: number;
  anchor?: LayerShellAnchor;
  exclusiveZone?: number;
  margin?: { top: number; right: number; bottom: number; left: number };
  keyboardInteractivity?: LayerShellKeyboardInteractivity;
  layer?: LayerShellLayer;
  // v5 set_exclusive_edge: an anchor bit (1/2/4/8) selecting which edge
  // the exclusive zone applies to when the anchor combination is ambiguous
  // (corner anchors). 0 = "auto-deduce from anchor."
  exclusiveEdge?: number;
}

// The applied state of a zwlr_layer_surface_v1. Mirrors LayerSurfacePending
// but every field has a concrete value (the protocol's default-state spec).
export interface LayerSurfaceApplied {
  width: number;
  height: number;
  anchor: LayerShellAnchor;
  exclusiveZone: number;                // 0 default; -1 = ignore reserved; >0 = reserve
  margin: { top: number; right: number; bottom: number; left: number };
  keyboardInteractivity: LayerShellKeyboardInteractivity;
  layer: LayerShellLayer;
  exclusiveEdge: number;
}

// A zwlr_layer_surface_v1 instance. Tracks the role state of a wl_surface
// that has been assigned the layer-shell role. Lifetime: created in
// zwlr_layer_shell_v1.get_layer_surface; destroyed by the matching
// .destroy request OR by the wl_surface's destruction.
export interface LayerSurfaceRecord {
  resource: Resource;            // the zwlr_layer_surface_v1
  surface: SurfaceRecord;        // the wl_surface this is roled onto
  // The outputId this layer surface targets (resolved from the `output` arg
   // of get_layer_surface). Reserved zones are keyed on this; reflow uses
   // this output's rect.
  output: number;
  namespace: string;             // client-supplied identifier (e.g. "panel")
  pending: LayerSurfacePending;
  applied: LayerSurfaceApplied;
  // Configure handshake bookkeeping (mirrors XdgSurfaceRecord). null until
  // the first configure goes out; updated each time a new configure is sent.
  lastConfigureSerial: number | null;
  // The last configured size we sent; used to skip redundant reconfigures.
  configuredWidth: number;
  configuredHeight: number;
  // True after the client acked the most recent configure. The next
  // wl_surface.commit may legally carry a buffer.
  acked: boolean;
  // True once the surface has presentable content (first buffer-bearing
  // commit was processed). The window.map / setLayerSurfaces push happens
  // on the transition from false to true.
  mapped: boolean;
  // Output-space rect, computed at apply time from anchor/size/margin
  // against the (effective)Rect appropriate to the exclusive-zone mode.
  // Undefined until applyLayerSurfaceInitial runs.
  rect?: { x: number; y: number; width: number; height: number };
  // The reserved-zone-registry id under which this surface's exclusive
  // zone (if any) is registered. Set when zone > 0 produces a valid edge;
  // cleared otherwise. Used to clear/update without scanning.
  reservedZoneId?: string;
  // Cleared on destroy / wl_surface teardown to short-circuit any in-flight
  // sweep that still holds a reference (the sweep pattern used elsewhere).
  destroyed: boolean;
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
  // Interactive pointer grab (move / resize). While non-null, motion
  // drives the grabbed window's floating rect via wm.setFloatingRect;
  // pointer events are not forwarded to clients. Started by
  // window.begin-move / window.begin-resize actions; ended by
  // window.end-grab (typically from a hotkey binding's release callback).
  grab: PointerGrab | null;
  // Start a grab on the given window. Transitions the window to
  // 'floating' presentation if it isn't already (captures the initial
  // floating rect from its current outer). No-op if a grab is already
  // active (only one grab at a time).
  beginGrab(grab: PointerGrab): void;
  // End any active grab. Idempotent.
  endGrab(): void;
  // Phase 9c: cursor state (per-pointer-resource enter serials, per-client
  // cursor preference). Owned by wl_seat, accessed by wl_pointer (set_cursor
  // serial validation + client preference recording) and by wl_surface
  // (cursor-role surface commit triggers a slot re-apply).
  cursor: SeatCursorOps;
  // Layer-shell exclusive keyboard interactivity: while at least one
  // mapped layer surface in the `top` or `overlay` protocol layer has
  // keyboard_interactivity === "exclusive", the seat forces kbFocus to
  // that surface (topmost wins) and bypasses the focus driver entirely.
  // Called from the layer-shell apply / teardown paths whenever the set
  // of qualifying surfaces might have changed.
  reevaluateExclusiveLayerFocus(): void;
  // Purge state that references a wl_resource the client (or compositor)
  // destroyed: stale pointer/keyboard focus, destroyed wl_pointer/wl_keyboard
  // resources in the per-client sets. Required because libwayland recycles
  // wl_client* pointer values across disconnects -- without this, a new client
  // whose wl_client* happens to match a disconnected one would inherit the
  // dead client's keyboard set, causing wl_keyboard.leave to reference a
  // foreign-client surface (libwayland disconnects the client). Called from
  // the per-frame sweep in dispatchFrameCallbacks alongside surface/buffer
  // disconnect cleanup.
  sweepDestroyed(): void;
}

export interface ClientCursor {
  surfaceResource: import("../types.js").Resource | null;
  hotspotX: number;
  hotspotY: number;
  hidden: boolean;
}

export interface SeatCursorOps {
  recordEnterSerial(p: import("../types.js").Resource, serial: number): void;
  clearEnterSerial(p: import("../types.js").Resource): void;
  lastEnterSerialFor(p: import("../types.js").Resource): number | undefined;
  setClientCursor(clientId: number, c: ClientCursor): void;
  // Called by wl_surface.commit when the surface has role "cursor": if
  // it is the current pointer focus's active cursor surface, re-apply
  // it so the new texture is picked up.
  onCursorSurfaceCommit(surfaceResource: import("../types.js").Resource): void;
}

// Callbacks the data-device DnD machinery installs on the seat during a drag.
export interface DragGrab {
  onMotion(x: number, y: number, hit: SeatFocus | null): void;
  onButton(pressed: boolean): void;
}

// Pointer-grab state: a single in-progress interactive move or resize.
// While a grab is active, pointer motion drives the grabbed window's
// floating rect via wm.setFloatingRect; pointer events are not forwarded
// to clients (the user is manipulating compositor geometry, not the
// client). Modifier / keyboard events still flow normally.
//
// Started via SeatState.beginGrab (typically from a window.begin-move /
// window.begin-resize action). Ended via SeatState.endGrab (typically
// from a hotkey binding's release callback).
export type ResizeEdges =
  | "top" | "bottom" | "left" | "right"
  | "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface PointerGrabMove {
  kind: "move";
  surfaceId: number;
  // Pointer position at grab start.
  anchorX: number;
  anchorY: number;
  // Window outer rect at grab start.
  startRect: { x: number; y: number; width: number; height: number };
  // When true, the seat auto-ends the grab on the next pointer-button
  // release. Used by xdg_toplevel.move/.resize (button-driven grabs);
  // hotkey-initiated grabs leave this false because their release is
  // already handled by the binding chain's release callback.
  endOnButtonUp?: boolean;
}

export interface PointerGrabResize {
  kind: "resize";
  surfaceId: number;
  anchorX: number;
  anchorY: number;
  startRect: { x: number; y: number; width: number; height: number };
  edges: ResizeEdges;
  endOnButtonUp?: boolean;
}

export type PointerGrab = PointerGrabMove | PointerGrabResize;

export interface Ctx {
  events: EventsByInterface; // per-interface event senders (built from makeEvents)
  state: CompositorState;
  addon: Addon;
}
