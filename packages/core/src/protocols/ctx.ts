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
  //   "xdg_toplevel" | "xdg_popup" | "cursor" | "layer_surface" | "xwayland"
  // null until a role is assigned. Once non-null, the wl_surface cannot
  // be re-roled (the role protocols enforce this; cross-role assignment
  // posts the appropriate protocol error).
  role: string | null;
  // Double-buffered commit state. Requests accumulate into `pending`; commit
  // either APPLIES it (effective-desync) or CACHES it (effective-sync subsurface)
  // until the parent commits. See wl_surface.commit + applySurfaceState.
  //
  // `inputRegion` / `opaqueRegion` hold a SNAPSHOT of the region's rect list
  // (a cloned Region, or null = infinite), taken at set_*_region time per the
  // spec's copy semantics: the client may destroy the wl_region immediately
  // after the request, and a set-then-destroy of an empty region must read as
  // "accept nothing", not "infinite". Snapshotting at commit (by resource
  // lookup) loses both cases. On commit the snapshot is promoted verbatim.
  pending: {
    buffer?: Resource | null;
    frameCallbacks?: Resource[];
    // wp_presentation feedback resources queued via wp_presentation.feedback
    // since the last commit. Promoted to `frameCallbacks`-style applied
    // state on commit; the dispatcher consumes them on the next scanout
    // (presented) or supersession (discarded).
    presentationFeedbacks?: Resource[];
    inputRegion?: RegionSlot;
    opaqueRegion?: RegionSlot;
    bufferScale?: number;
    // wl_surface.set_buffer_transform (double-buffered): wl_output.transform
    // enum 0..7. Default 0 (normal).
    bufferTransform?: number;
    // wl_surface buffer offset for this commit (attach dx/dy pre-v5, or the v5
    // offset request), in surface-local pixels. undefined = unchanged this
    // cycle. Promoted into the accumulated offsetDx/offsetDy on commit.
    offsetX?: number;
    offsetY?: number;
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
    // wp_commit_timer_v1.set_timestamp: target presentation time for the
    // next commit, in CLOCK_MONOTONIC nanoseconds (the wp_presentation
    // clock domain). Consumed by wl_surface.commit: the commit's content
    // update is not latched before this time.
    commitTimestamp?: bigint;
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
    // True if any commit during this cache cycle carried a fresh wl_buffer
    // attach. The buffer is applied (uploaded + released) only when fresh, so a
    // bare commit (no attach) doesn't re-upload or double-release the buffer.
    bufferFresh?: boolean;
    frameCallbacks?: Resource[];
    presentationFeedbacks?: Resource[];
    inputRegion?: RegionSlot;
    opaqueRegion?: RegionSlot;
    bufferScale?: number;
    bufferTransform?: number;
    viewportSrc?: ViewportSrc | null;
    viewportDst?: ViewportDst | null;
    surfaceDamage?: DamageRect[];
    bufferDamage?: DamageRect[];
    syncobjAcquire?: SyncobjPoint;
    syncobjRelease?: SyncobjPoint;
  };
  // wp_commit_timing_v1 timed-commit queue. A commit carrying a timestamp
  // (or arriving while earlier queued commits are still waiting -- content
  // updates apply in the order received) is diverted here: its accumulated
  // `pending` set is captured whole and latched by the pump when the
  // presentation clock reaches targetNs (undefined = no constraint, latches
  // as soon as it reaches the head). See wl_surface.ts pumpTimedCommits.
  timedCommits?: { set: SurfaceRecord["pending"]; targetNs?: bigint }[];
  // Armed setTimeout for the queue head's target time; cleared on pump/teardown.
  timedCommitTimer?: ReturnType<typeof setTimeout>;
  // Set while a wp_commit_timer_v1 exists for this surface (one per surface;
  // a second get_timer posts commit_timer_exists).
  hasCommitTimer?: boolean;
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
  // Accumulated wl_surface buffer offset (sum of committed attach/offset
  // deltas), surface-local pixels. Applied to surface placement where it's
  // observable: the DnD drag-icon and popups. Toplevel/subsurface placement
  // ignores it (those are positioned by the WM / subsurface coords).
  offsetDx?: number;
  offsetDy?: number;
  mapped?: boolean;
  hasContent?: boolean;  // a buffer has been committed + uploaded at least once
  // Set once the window's unmap teardown has run (explicit wl_surface.destroy OR
  // the resource-destroyed sweep on client disconnect). Guards against emitting
  // window.unmap / tearing down twice.
  unmapped?: boolean;
  // True when the compositor-side Surface entry was torn down (via
  // detachSurfaceRole / removeSurface) but the protocol-side
  // SurfaceRecord still holds latched state (viewport, etc.) that
  // wasn't pushed via the change-detect path. The next applySurfaceState
  // re-pushes the latched state unconditionally and clears this.
  needsCompositorResync?: boolean;
  frameCallbacks?: Resource[];
  // wp_presentation feedback resources committed (i.e. their associated
  // wl_surface.commit applied) but not yet dispatched. Drained by the
  // dispatcher when the surface's resident output flips, OR by the next
  // commit's apply (the old feedback is discarded). One commit's worth
  // at a time -- if a client queues a feedback then commits again before
  // the prior commit scanned out, the old feedback is discarded; the
  // dispatcher takes care of that on each apply.
  presentationFeedbacks?: Resource[];
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
  // a client gets about which monitor its window is on.
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
// window; free overlays pick a layer. Layers express "above/below content"
// without a full layout engine.
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
  // Shm fast path: route the pixel upload through the GPU process's mmap
  // of the pool (queue.WriteTexture in-process there) instead of marshaling
  // the pixel bytes across the Dawn wire from the protocol thread. Returns
  // a non-zero uploadSeq the caller defers wl_buffer.release on; 0 means
  // the fast path isn't available (test sink, addon predates the API, or
  // the wire is down) and the caller should fall back to commitSurfaceBuffer.
  commitSurfaceBufferShm?(id: number, poolId: number, offset: number, w: number,
                          h: number, stride: number,
                          damage?: ReadonlyArray<DamageRect>): number;
  // Drain GPU-process ShmUploaded acks accumulated since the last call.
  // The protocol layer drains this each tick (dispatchFrameCallbacks)
  // and fires the wl_buffer.release events keyed on each seq.
  takeShmUploadAcks?(): number[];
  // `acquireFenceFd` (optional) is a sync_file fd exported by the protocol
  // layer from a wp_linux_drm_syncobj_v1 acquire point. When present, the
  // compositor passes it to the GPU process at the next BeginAccess for this
  // bufferId, INSTEAD of the GPU process's implicit-sync EXPORT_SYNC_FILE.
  // The compositor takes ownership of the WaylandFd (closes / consumes it).
  // Omit for implicit-sync clients.
  commitSurfaceDmabuf(id: number, fd: WaylandFd, w: number, h: number,
                      fourcc: number, modHi: number, modLo: number,
                      offset: number, stride: number, bufferId: number,
                      acquireFenceFd?: WaylandFd,
                      damage?: ReadonlyArray<{ x: number; y: number; width: number; height: number }> | null): boolean;
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
  // Mark whether the committed buffer format carries a real alpha channel.
  // Opaque (X-alpha) formats — XRGB8888/XBGR8888, dmabuf XR24/XB24 — have a
  // don't-care 4th byte the compositor must not sample as alpha; this forces
  // the surface fully opaque in the blend. Optional (test sinks may omit it).
  setSurfaceOpaque?(id: number, opaque: boolean): void;
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
  // xdg_surface.set_window_geometry: the sub-rect of the surface (in
  // surface-local logical coords) that the client considers its
  // "window" -- the rest is shadow / pop-out that should render
  // outside the WM-assigned tile. setSurfaceLayout supplies the
  // OUTPUT-space rect where the geometry's (0, 0) anchor lands; the
  // compositor uses this offset to position the buffer so the
  // geometry rect aligns with the WM-assigned position and the
  // surrounding shadow overflows naturally. (x, y) is the offset
  // into the surface; (w, h) is the geometry size. Pass null to
  // clear (surfaces with no geometry render anchored at
  // setSurfaceLayout's (x, y), matching pre-CSD behavior).
  setSurfaceGeometry?(id: number, geom: { x: number; y: number; width: number; height: number } | null): void;
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
  // Per-output content camera (docs/canvas-design.md §4): the output renders
  // the world starting at (arrangement origin + camera), scaled by zoom
  // (zoom < 1 shows more world). (0, 0, 1) = identity. Applies to
  // world-space surfaces only; layer-shell, the cursor, and
  // output-anchored surfaces stay glass-positioned. Optional (GPU-free
  // test sinks omit it).
  //
  // `transient` marks a mid-animation write (one frame of a camera
  // flight): the camera applies to render/damage/input immediately, but
  // the per-change residency sweep + X re-narration are deferred until a
  // settled (non-transient) write arrives. Whoever animates the camera
  // owns sending that settled write when the motion ends.
  setOutputCamera?(
    outputId: number, x: number, y: number, zoom?: number,
    transient?: boolean): void;
  // World-space translucent quads at the bottom of the content segment
  // (island markers for empty islands; the camera pans/zooms them).
  setIslandBackdrops?(list: ReadonlyArray<{
    x: number; y: number; width: number; height: number;
    color: { r: number; g: number; b: number; a: number };
  }>): void;
  // Mark a surface as glass-positioned (ignores the content camera) even
  // though it rides the content stack: popups parented to layer-shell
  // surfaces. Optional (GPU-free test sinks omit it).
  setSurfaceOutputAnchored?(id: number, anchored: boolean): void;
  // Which outputs SHOW the surface: geometric overlap gated by draw-stack
  // membership (hidden surfaces are shown nowhere regardless of camera
  // position -- canvas-design.md). Drives wl_surface.enter/leave +
  // preferred scale; frame pacing uses the ungated surfaceOutputs.
  // Optional (GPU-free test sinks omit it; residency falls back to
  // surfaceOutputs).
  surfaceVisibleOutputs?(surfaceId: number): number[];
  // Install a pre-wrapped wire texture as surface `id`'s sampled texture (plugin
  // overlay consumer texture). Optional (JS compositor only).
  setSurfaceTexture?(id: number, tex: GPUTexture, w: number, h: number): void;
  // Per-surface render-state setters (core-plugin-api.md §1). Each is global
  // per surface (not per-output) and consumed by the compositor's shader every
  // frame. Optional so the native sink (if ever used) need not implement them.
  setSurfaceOpacity?(id: number, opacity: number): void;
  setSurfaceTransform?(id: number, t: import("../gpu/compositor.js").SurfaceTransform): void;
  setSurfaceOutputMargin?(id: number, m: import("../gpu/compositor.js").SurfaceMargin): void;
  // Per-channel multiplier + 4x4 matrix on the sampled rgba.
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
  // Subsurface positioning + fx cascade. The compositor derives each subsurface's
  // absolute placement (parent rect + offset) and cascades per-surface fx over
  // the subtree, so no caller enumerates subsurfaces. The accessor is the only
  // channel by which it learns the tree; reflowSubsurfaces re-derives a parent's
  // subtree when the tree changed without the parent's own rect moving (child
  // gained content, set_position applied, sibling reorder). setDecorationFx binds
  // a window's decoration as an fx-follower (same transform/opacity as the
  // window; its own layout) -- decoration is not a subsurface.
  setSubsurfaceAccessor?(accessor: import("../subsurfaces.js").SubsurfaceAccessor): void;
  reflowSubsurfaces?(parentId: number): void;
  setDecorationFx?(windowId: number, decorationId: number | null): void;
  removeSurface(id: number): void;
  takeImportedSurfaces(): Array<{ id: number; width: number; height: number }>;
  // Re-announce an already-imported surface for the next takeImportedSurfaces
  // pass (XWM uses it to re-run a deferred map once a window is managed).
  redeliverImported?(id: number): void;
  // Stamp the latest configure-sent / client-acked serials so the decoration
  // content-gate (surfaceContentReady) can release on ack rather than size.
  notifyConfigureSerial?(id: number, serial: number): void;
  notifyAckSerial?(id: number, serial: number): void;
  takeFreedBuffers(): number[];
  // Which output ids overlap this surface's current rect. Empty for an
  // unmapped / off-screen surface. Used by the per-output frame-callback
  // dispatch (a surface on a 60Hz output gets wl_callback.done at 60Hz).
  surfaceOutputs?(surfaceId: number): number[];
  // Outputs presented since the last call (drained). A presented output has a
  // flip in flight whose flip-complete delivers its frame callbacks, so the
  // idle frame-callback path skips it. See dispatchFrameCallbacks.
  takePresentedOutputs?(): number[];
  // True while a committed buffer for this surface is still being applied (shm
  // upload not yet acked, or dmabuf import not yet bound) -- its damage is
  // deferred until then. Frame callbacks for such a surface wait for the
  // upcoming present rather than the idle tick.
  surfaceHasContentInFlight?(surfaceId: number): boolean;
  // Whether an output has damage queued (a present is pending for it).
  isOutputDirty?(outputId: number): boolean;
  // Force a present of `surfaceId`'s unchanged content so the next flip-complete
  // delivers its pending frame callback (breaks the idle deadlock for a client
  // waiting on wl_callback.done that produces no damage). Vblank-gated. No-op if
  // the surface isn't drawable.
  requestPresentForCallback?(surfaceId: number): void;
  // Notify the compositor that a client wl_buffer was destroyed (explicit
  // wl_buffer.destroy or disconnect sweep). Drives cache invalidation in
  // the client-buffer lifecycle (rule A: along with surfaceRemoved, the
  // only path that releases a cached GPU import).
  notifyBufferDestroyed?(bufferId: number): void;
  renderFrame?(): void;
  // Force the per-output render gate to fire so the next frame presents and a
  // flip-complete is emitted, without supplying damage geometry. Screen
  // capture (ext_image_copy_capture_v1) drives its readback off the flip-
  // complete edge, but arming a capture frame changes no pixels -- so on an
  // idle desktop nothing marks the output dirty, no flip occurs, and the
  // capture hangs until an unrelated event repaints. `outputId` null nudges
  // every output (a toplevel-source capture drains on any output's flip).
  requestOutputPresent?(outputId: number | null): void;
  // Run a callback once the compositing submit in flight at call time completes on
  // the GPU. The plugin/overlay ring uses this to recycle a consumer slot only
  // after the frame that last sampled it is done (avoids EndAccess racing the read).
  afterCurrentFrame?(cb: () => void): void;
  // Scene-compose primitives (core-plugin-api.md §6). Snapshot variants return
  // one-shot textures the caller owns; the live variants register a target
  // refreshed every renderFrame() until released. Optional so non-JsCompositor
  // sinks (none today) need not implement them; the SDK only constructs
  // sdk.compose when they're present.
  // Snapshot an output's full on-screen content (drawOrder: toplevels +
  // decorations + subsurfaces + layers, at device resolution, cursor excluded)
  // for screen capture. Returns null for an unknown output. Caller owns the
  // texture.
  composeOutput?(outputId: number): { texture: GPUTexture; outW: number; outH: number } | null;
  // Compose an explicit flattened draw list (a window's toplevel + decoration
  // + subsurfaces) covering a global-logical region into a device-resolution
  // texture, for single-window screen capture. Caller owns the texture.
  composeRegion?(args: {
    drawList: ReadonlyArray<number>;
    region: { x: number; y: number; w: number; h: number };
    scale: number;
  }): { texture: GPUTexture; outW: number; outH: number };
  // Live scene: re-renders every frame at device resolution; getDrawList is
  // re-evaluated each frame so subsurfaces committed after registration are
  // picked up. registerLiveWindows still composes a fixed per-window list at
  // logical scale (unused by bundled plugins).
  registerLiveScene?(args: {
    outputId: number;
    getDrawList: () => number[];
    region?: { x: number; y: number; w: number; h: number };
    scale?: number;
  }): import("../gpu/compositor.js").LiveSceneHandle;
  registerLiveWindows?(args: {
    outputId: number;
    windows: ReadonlyArray<{ id: number; rect?: { x: number; y: number; w: number; h: number } }>;
  }): import("../gpu/compositor.js").LiveWindowCompHandle;
  // Async GPU->CPU readback of an arbitrary texture (compose target or
  // similar). Returns tightly-packed BGRA bytes (w*h*4). Used by the
  // ext_image_copy_capture_v1 shm destination path. Optional so non-
  // JsCompositor sinks (none today) need not implement it.
  readbackTexture?(tex: GPUTexture, w: number, h: number):
    Promise<{ width: number; height: number; data: Uint8Array }>;
  // Compose an already-flattened draw list into a caller-supplied target view.
  // With `region` set, surfaces draw at their global layout scaled to the
  // target's device size (the device-resolution mapping); without it, an
  // origin-anchored logical pass. When producerSurfaceBufId is set, the pass is
  // wrapped in producer Begin/End frames on the core wire keyed on that
  // surfaceBufId (cross-device dmabuf compose target).
  composeIntoView?(args: {
    outputId: number;
    targetView: GPUTextureView;
    drawList: ReadonlyArray<number>;
    outW: number;
    outH: number;
    region?: { x: number; y: number; w: number; h: number };
    producerSurfaceBufId?: number;
  }): void;
  // Register a per-frame produce callback. Each renderFrame
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
  // Snapshot the surfaces of a closing window into a fresh
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

  // Buffer intercept: route a surface's sampled texture
  // through a plugin-supplied view. The intercept broker drives this
  // each frame after invoking the plugin's render callback. Optional
  // `placement` overrides the surface's WM-assigned rect for the
  // compose pass only (the outputRect return). Clearing reverts the
  // surface to its client texture for compositing.
  installInterceptOutput?(surfaceId: number, view: GPUTextureView,
                          placement: { x: number; y: number; w: number; h: number } | null): void;
  clearInterceptOutput?(surfaceId: number): void;
  // The broker queries these per frame to drive the
  // intercept's render callback. surfaceClientTexture returns the
  // current sampled client texture for the surface (the input the
  // plugin will read from). surfaceIsPresentable gates the per-frame
  // render dispatch to surfaces actually being composited.
  surfaceClientTexture?(surfaceId: number): { texture: GPUTexture; w: number; h: number } | null;
  // Whether the surface's current buffer is an opaque (X-alpha) format: the
  // texture's alpha channel is undefined and must be forced to 1 by whoever
  // samples it (the intercept broker forwards this into plugin renders).
  surfaceIsOpaque?(surfaceId: number): boolean;
  // The surface's intrinsic logical size (viewport destination, else buffer
  // dims / buffer_scale). The intercept tick divides the client texture's
  // buffer-pixel dims by this to map surface-local coordinates (e.g. the xdg
  // window geometry) into buffer pixels.
  surfaceLogicalSize?(surfaceId: number): { w: number; h: number } | null;
  // Monotonic per-surface client-content version (bumped on each new commit).
  // The intercept broker compares it across ticks to set ctx.contentChanged.
  surfaceContentEpoch?(surfaceId: number): number;
  surfaceIsPresentable?(surfaceId: number): boolean;
  // In-thread intercept: open a BeginAccess bracket on the
  // surface's client dmabuf import, run `fn` (the plugin's render
  // submit which samples the client texture), close with EndAccess.
  // SHM-backed surfaces have no dmabuf import; the call passes
  // through with no bracket (fn still runs).
  //
  // The bracket is a per-buffer Begin/End pair on the GPU wire,
  // alternating; multiple Begins without an End violate the
  // GPU process's accessOpen invariant. The compositor's main
  // renderFrame opens its own bracket for the SAME buffer LATER in
  // the same frame; that's fine -- the brackets are sequential, not
  // nested. Returns true if fn completed without throwing; false if
  // the bracket open failed (the broker treats that as a skipped
  // frame).
  withClientTextureAccess?(surfaceId: number, fn: () => void): boolean;
  // The surface's WM-assigned outer rect (x/y in compositor logical coords,
  // w/h from setSurfaceLayout). Threaded into the intercept render context as
  // ctx.surfaceRect. Null for unknown surfaces.
  surfaceWmRect?(surfaceId: number): { x: number; y: number; w: number; h: number } | null;
  // Whether the surface's committed buffer matches its WM content rect at the
  // output scale (the client has caught up to the configured size). Surfaced
  // to intercept gating plugins as ctx.contentReady.
  surfaceContentReady?(surfaceId: number): boolean;
  // Worker intercept: copy the surface's currently-
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

  // Software cursor slot. The cursor draws above every other
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
  // Theme-shape install by resolver: `resolve` produces the shape at any
  // requested device-pixel size so the compositor can pick a native-
  // resolution image per output (software slot at the highest output
  // scale; each cursor plane at its exact scale). Returns false -- current
  // cursor untouched -- when the shape doesn't resolve. Preferred over
  // setCursorPixels for anything the XCursor resolver produces.
  setCursorShape?(resolve: (deviceSizePx: number) => {
                    width: number; height: number;
                    hotspotX: number; hotspotY: number;
                    rgba: Uint8Array;
                  } | null,
                  logicalSizePx: number): boolean;
  setCursorFromSurface?(surfaceId: number | null,
                        hotspotX: number, hotspotY: number): void;
  setCursorTexture?(tex: GPUTexture, width: number, height: number,
                    hotspotX: number, hotspotY: number): void;
  setCursorPosition?(x: number, y: number): void;
  setCursorVisible?(visible: boolean): void;
  clearCursor?(): void;
  // Hardware-cursor plane control (KMS). setCursorPlaneStatus feeds the
  // GPU process's per-output availability reports; setHwCursorEnabled is
  // the config gate (cursor.hardware). Outputs with an available plane
  // and a plane-compatible image scan the cursor out in hardware instead
  // of the software slot; everything else falls back per output.
  setCursorPlaneStatus?(outputId: number, ok: boolean,
                        maxW: number, maxH: number): void;
  setHwCursorEnabled?(on: boolean): void;
  // Direct scanout (KMS): flip latch/retire + rejection routing from the
  // GPU process, and the config gate. See scanout-design.md.
  handleScanoutClientFlip?(outputId: number, latchedBufferId: number,
                           retiredBufferId: number): void;
  handleScanoutClientReject?(outputId: number, bufferId: number): void;
  setDirectScanoutEnabled?(on: boolean): void;
}

export interface CompositorState {
  surfaces: Map<Resource, SurfaceRecord>;
  // Xwayland surface-association registry (xwayland_shell_v1 /
  // xwayland_surface_v1): maps unique serials to wl_surfaces so the native XWM
  // can pair X11 windows to the surfaces Xwayland created. Created lazily by
  // the shell handler; logic lives in src/xwayland/surface.ts.
  xwayland?: import("../xwayland/surface.js").XwaylandSurfaceState;
  // Global integer scale for the Xwayland session (1..3). The X client sees an
  // oversized world: compositor logical coords/sizes are multiplied by this
  // before reaching X and X coords/sizes are divided by it on the way back.
  // The X surface's wl_buffer is treated as bufferScale=N so the composite
  // path renders it at the right logical size. Set by main.ts before
  // startXwm. Defaults to 1 (i.e. behaves as before for callers that never
  // set it -- GPU-free tests, etc.). See docs/xwayland-design.md "HiDPI".
  xwaylandScale?: number;
  // wl_client ids whose connection has bound xwayland_shell_v1 at least
  // once. Used by xdg_output to multiply logical_position / logical_size
  // by xwaylandScale for those clients (they think in X device-pixel
  // coords). Populated by the xwayland_shell_v1 bind path.
  xwaylandClientIds?: Set<number>;
  // Process id of the spawned Xwayland server. Set synchronously at fork,
  // BEFORE Xwayland can connect -- xdg_output matches a binding client's
  // peer pid against this to recognize the Xwayland connection at bind
  // time. The xwayland_shell_v1 path above only fires when the first X
  // window associates, which is too late: Xwayland builds its RandR view
  // from the xdg_output logical size it sees at startup.
  xwaylandPid?: number;
  // Narrow read-only view of the active XWM (when startXwm has run). Used by
  // query.titleAppId and the close path to look up X-backed windows by
  // surfaceId without taking a dep on the full Xwm shape. Cleared on
  // xwm.stop().
  xwm?: import("../xwayland/xwm.js").XwmStateView;
  // Override-redirect overlay placements, keyed by surfaceId. Populated by
  // the XWM when an OR window maps or is reconfigured; consulted by the
  // content-layer stack rebuild (xdg_popup.ts:appendOverrideRedirects) to
  // push setSurfaceLayout for each OR overlay, and by wl_seat.focusTargetFor
  // to resolve focus on an OR surface (the WM doesn't track these). Cleared
  // when the X window is destroyed.
  overrideRedirects?: Map<number, { x: number; y: number; width: number; height: number }>;
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
  // wp_commit_timer_v1 resource -> its wl_surface resource (one timer per
  // surface). The entry survives surface destruction (mapping to the dead
  // resource) so set_timestamp can distinguish "surface destroyed" (the
  // spec's surface_destroyed error) from an untracked timer.
  commitTimers?: Map<Resource, Resource>;
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
  // Per-surface zwp_linux_dmabuf_feedback_v1 resources, tracked so the
  // feedback re-sends with a scanout tranche when the surface's
  // fullscreen state changes (direct scanout; scanout-design.md).
  // lastKey dedups re-sends ("render" | "scanout:<outputId>").
  dmabufSurfaceFeedback?: Map<Resource, { surfaceId: number; lastKey: string }>;
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
  // Closing driver. When wired (a 'window-closing' plugin
  // is registered), the wl_surface unmap path consults this before
  // tearing down a mapped toplevel: if a plugin handler is present,
  // the driver snapshots the window into a phantom + emits
  // window.closing + arms a backstop timer. Absent or no-op when
  // no closing plugin is registered -- the unmap then proceeds
  // instantly.
  closingDriver?: import("./closing-driver.js").ClosingDriver;
  // Mirror of closingDriver for the map side. Hooked from
  // wm.windowHasContent at first-content commit: if a 'window-opening'
  // plugin is present, the driver engages the WM content gate and
  // emits window.opening so the plugin can set initial render state
  // before the first frame composites. Absent or returns false when
  // no opening plugin is registered -- the map proceeds instantly.
  openingDriver?: import("./opening-driver.js").OpeningDriver;
  // Cursor kinematic state machine. Pointer motion events in
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
  // Per-output wp_presentation feedback dispatch. Fires `presented` on
  // every queued feedback for surfaces overlapping `outputId`, with the
  // scanout timestamp + vsync sequence carried up from the GPU process.
  // Surfaces not overlapping the output keep their feedbacks queued for
  // the next intersecting flip. tvSec is a bigint to carry the u64
  // CLOCK_MONOTONIC seconds-since-boot. Set by installProtocols.
  dispatchPresentationFeedbackForOutput?: (outputId: number, tvSec: bigint,
                                           tvNsec: number, seq: number) => void;
  // Per-output ext_image_copy_capture_v1 frame dispatch. Fired on the same
  // flip-complete edge as wp_presentation feedback: walks the set of armed
  // capture frames whose source matches outputId (output sources directly,
  // toplevel sources picked up wherever the toplevel resides) and writes
  // pixels into their attached client buffers, then sends `ready` with the
  // scanout timestamp threaded through `presentation_time`.
  dispatchCaptureForOutput?: (outputId: number, tvSec: bigint, tvNsec: number) => void;
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
  // Shared surface-transaction broker: the WM's resize-tx and the cross-
  // output residency handler both route their "freeze surface until X
  // happens" plumbing through this. installProtocols creates it; main.ts
  // (and tests) reach in via state.surfaceTx to register additional holds.
  surfaceTx?: import("../surface-transaction.js").SurfaceTransactionBroker;
  // Per-output stacks computed by rebuildStackWithPopups while the
  // surface-transaction broker had active holds. The broker's onAfterApply
  // flushes these to compositor.setOutputStack atomically with the
  // surface's new geometry. See xdg_popup.ts:rebuildStackWithPopups for
  // why we defer.
  deferredOutputStacks?: Map<number, number[]>;
  // Shm fast-path deferred releases: when commitSurfaceBufferShm returns a
  // non-zero uploadSeq, the protocol layer parks the wl_buffer resource here
  // keyed by seq. dispatchFrameCallbacks drains compositor.takeShmUploadAcks()
  // each tick and fires wl_buffer.release for each acked seq. (Mirrors
  // Hyprland's copy-then-release: the client gets its buffer back as soon as
  // the GPU process has memcpy'd the bytes into its staging upload, never
  // earlier.)
  pendingShmReleases?: Map<number, Resource>;
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
  // Xwayland selection bridge state. The bridge populates these when an X
  // client owns the corresponding selection; the wl_data_device dispatch
  // uses them to mint server-side offers backed by the X side.
  xClipboardSource?: import("../xwayland/selection.js").XSelectionSource | null;
  xPrimarySource?: import("../xwayland/selection.js").XSelectionSource | null;
  // Hook the bridge fires after it (re)publishes an X-backed source, so
  // the wl side re-pushes the focused client's data_device with a fresh
  // offer minted from the new mime list.
  onXSelectionAvailable?:
    (kind: "clipboard" | "primary") => void;
  // Hook the wl side calls when a wl client claims or releases a
  // selection, so the bridge can claim or release the X selection in
  // turn. The bridge installs this on startup.
  onWlSelectionChanged?:
    (kind: "clipboard" | "primary", source: Resource | null,
     protocol: "data" | "primary") => void;
  // Hook the wl_data_offer.receive / primary equivalent calls for an
  // X-backed offer. Returns true iff the bridge handled it. Set by the
  // bridge; null/undefined elsewhere.
  receiveForXSource?:
    (kind: "clipboard" | "primary", mime: string, fd: number) => boolean;
  // ext_data_control_v1 state. The control protocol exposes
  // selection management for unfocused clients; each device subscribes
  // to selection.changed and re-pushes the offer burst to every bound
  // resource. Sentinel for the bus-subscribe-once guard lives alongside.
  dataControlDevices?: Map<number, Set<Resource>>;
  dataControlBusInstalled?: boolean;
  // Helpers exposed by wl_data_device_manager so ext_data_control's
  // set_selection / set_primary_selection can re-push to the keyboard-
  // focused wl_data_device without duplicating the offer-minting code.
  // Set by makeDataDeviceManager; null in pre-bring-up paths.
  sendSelectionToClient?: (clientId: number) => void;
  sendPrimaryToClient?: (clientId: number) => void;
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
  // Per-output content camera (docs/canvas-design.md §4), keyed by outputId.
  // Absent entry = identity (0, 0, zoom 1). Single writer: the camera SDK
  // broker, which also mirrors each change into the compositor
  // (setOutputCamera). Readers: the seat's pointer->world transform,
  // popup constraint boxes, and output-membership derivation.
  outputCameras?: Map<number, { x: number; y: number; zoom: number }>;
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
  // Per-durable-key memorized position. Populated by:
  //   (a) user config (output.byKey[<key>].position),
  //   (b) zwlr_output_management apply set_position succeeding.
  // Consulted by hotplug add (output/hotplug.ts) to restore an output's
  // prior logical position on replug, BEFORE the deterministic right-of-
  // rightmost fallback is used. Keys: edidId when non-empty, else name.
  // Lives only for the compositor session (not persisted across restarts).
  outputPositionMemory?: Map<string, { x: number; y: number }>;
  // Same shape as outputPositionMemory, but for scale. Auth precedence on
  // hotplug add: explicit config-resolved scale (already handled by
  // resolveScale) -> memorized scale (this map) -> EDID-DPI auto.
  outputScaleMemory?: Map<string, number>;
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
  // Outputs with a present in flight (flip-complete pending). Owned + mutated
  // by the protocol layer's frame-callback machinery; published here read-only
  // so the plugin overlay frame-tick service gates its idle force-present on
  // the same set.
  awaitingFlipOutputs?: ReadonlySet<number>;
  // Schedule a WM layout pass with the given reason. Set by installProtocols
  // after the WM is constructed; reachable from layer-shell apply paths so a
  // reserved-zone change reflows tiled / maximized windows. Absent in
  // GPU-free harnesses that bring up the protocol layer without a real WM.
  relayout?: (reason: import("@overdraw/layout-types").LayoutReason) => void;
  // Driver routing ext_workspace_v1 inbound requests (activate / remove /
  // create_workspace) to the bundled workspace plugin. Wired by main.ts
  // after both the runtime and installProtocols have run. Absent in
  // GPU-free harnesses; ext_workspace_v1 handler then silently drops
  // inbound requests (matching the spec's "compositor ignores requests
  // for capabilities it doesn't support" framing -- a manager bound
  // against this state still sees zero workspaces, so a client cannot
  // address one).
  workspaceDriver?: import("./ext_workspace_v1.js").WorkspaceDriver;
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
  // Durable identifier from EDID (mfr-product-serial). Empty when the
  // connector has no usable EDID. The workspace plugin keys
  // `preferredOutputs` on this when non-empty and falls back to `name`
  // otherwise -- see multi-output-design §3.
  edidId: string;
  // Full advertised mode list for this connector. Populated from the
  // GPU process's OutputModes frame on hotplug add and at startup.
  // wlr-output-management exposes one head.mode event per entry; the
  // configuration apply path resolves a client-picked
  // zwlr_output_mode_v1 back to (width, height, refreshMhz) via this
  // list. Empty in nested-host mode (no DRM connector advertises modes).
  availableModes?: ReadonlyArray<{
    width: number;
    height: number;
    refreshMhz: number;
    preferred: boolean;
  }>;
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

// A glass->world view transform (one output's content camera at hit time):
// worldX = originX + camX + (glassX - originX) / zoom (likewise y). The
// inverse maps world to glass: glassX = originX + (worldX - originX - camX)
// * zoom. Identity ({0,0,0,0,1}) makes world === glass.
export interface SeatViewTransform {
  originX: number;
  originY: number;
  camX: number;
  camY: number;
  zoom: number;
}

export const SEAT_VIEW_IDENTITY: Readonly<SeatViewTransform> =
  Object.freeze({ originX: 0, originY: 0, camX: 0, camY: 0, zoom: 1 });

export function seatViewToWorldX(v: SeatViewTransform, glassX: number): number {
  return v.originX + v.camX + (glassX - v.originX) / v.zoom;
}
export function seatViewToWorldY(v: SeatViewTransform, glassY: number): number {
  return v.originY + v.camY + (glassY - v.originY) / v.zoom;
}
export function seatViewToGlassX(v: SeatViewTransform, worldX: number): number {
  return v.originX + (worldX - v.originX - v.camX) * v.zoom;
}
export function seatViewToGlassY(v: SeatViewTransform, worldY: number): number {
  return v.originY + (worldY - v.originY - v.camY) * v.zoom;
}

export interface SeatFocus {
  // The surface that owns the pointer interaction: the exact surface the
  // pointer is over, which may be a subsurface descendant of a toplevel.
  // wl_pointer enter/leave/motion and surface-local coords use this.
  surfaceId: number;
  surfaceRec: { resource: Resource };
  // The root of `surfaceId`'s surface tree -- the xdg_toplevel / layer /
  // popup surface. Keyboard focus, window activation, and raise target
  // this, since a subsurface is not a focusable/raisable window. Equals
  // surfaceId when the hit is itself a root.
  rootSurfaceId: number;
  clientId: number;
  rect: { x: number; y: number; width: number; height: number };
  // The glass->world view transform the hit was made through: `rect` for a
  // world-space surface (toplevel tree) is in world coords, so
  // surface-local math maps the pointer's glass position through
  // worldX = originX + camX + (glassX - originX) / zoom
  // before subtracting rect.x. Identity ({0,0,0,0,1}) for glass-anchored
  // hits (layer shell, layer-rooted popups) and under identity cameras.
  view: SeatViewTransform;
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
  // Re-derive pointer focus at the last-known pointer position, sending
  // leave/enter/motion and a focus-policy dispatch as if the pointer had
  // moved zero pixels. Called when the scene changes under a stationary
  // pointer (resize-tx batch apply, workspace switch). No-op during
  // grabs/drags or while the host pointer is outside the compositor.
  repickPointer(): void;
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
  // Cursor state (per-pointer-resource enter serials, per-client
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
  // Drop kb/pointer focus records pointing at `surfaceId` without sending
  // leave. Called synchronously from wl_surface teardown so no focus change
  // between the destroy and the next per-frame sweep can send a leave event
  // referencing the destroyed surface resource (a fatal protocol error for
  // the receiving client).
  clearFocusForSurface(surfaceId: number): void;
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
  // True when the window was in the managed (tiled) lane before the
  // grab floated it. Carried on the drop event so the workspace
  // plugin's membership-on-drag policy can re-tile the window into the
  // island it lands on (a window floated by the user stays floating).
  wasManaged?: boolean;
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

// Drag-pan: pointer motion pans the output's content camera instead of
// moving a window -- the grab IS the camera motion, so the usual
// "camera must hold still during a grab" rule doesn't apply (the
// animations broker's cameraGate still denies concurrent camera
// ANIMATIONS, which is exactly right: two writers would fight).
// Deltas accumulate from the last applied pointer position (glass px,
// converted to world by the live zoom), each written as a TRANSIENT
// camera value; endGrab sends the one settled write.
export interface PointerGrabCameraPan {
  kind: "camera-pan";
  outputId: number;
  // Pointer position (global logical) at the last applied motion.
  lastX: number;
  lastY: number;
  endOnButtonUp?: boolean;
}

export type PointerGrab =
  | PointerGrabMove | PointerGrabResize | PointerGrabCameraPan;

export interface Ctx {
  events: EventsByInterface; // per-interface event senders (built from makeEvents)
  state: CompositorState;
  addon: Addon;
}
