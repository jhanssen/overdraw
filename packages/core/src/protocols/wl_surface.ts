// wl_surface: per-surface double-buffered commit state.
//
// Requests (attach/frame/...) accumulate into `pending`. On commit, the pending
// state is either APPLIED immediately or, for a SYNCHRONIZED subsurface, moved
// into `cached` and applied later when the parent surface commits -- per the
// wl_subsurface spec (sync caches; cache applied atomically with the parent;
// desync applies directly but also flushes any existing cache; a desync child of
// a sync-behaving parent is effectively sync; the main surface is always desync).
// Applying a surface cascades into its effective-sync children's caches, so a
// parent commit atomically applies the parent + all its synchronized descendants.

import type { WlSurfaceHandler } from "#protocols-gen/wl_surface.js";
import { WlSurface_Error } from "#protocols-gen/wl_surface.js";
import type { Ctx, CompositorState, SurfaceRecord, SubsurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import { Region, type RegionRect } from "./region.js";
import { applySubsurfaces, applySubsurfaceReorder } from "../subsurfaces.js";
import { applyPresentationFeedbacks } from "./wp_presentation.js";
import { WINDOW_EVENT } from "../events/types.js";
import {
  isLayerSurfaceInitialCommit,
  applyLayerSurfaceInitial,
  applyLayerSurfacePending,
  teardownLayerSurface,
} from "./zwlr_layer_shell_v1.js";

// Assign a stable per-wl_buffer id used to track the dmabuf release lifecycle
// across the JS<->native boundary. Native reports freed bufferIds (once its GPU
// read completes); index.ts maps them back to the wl_buffer and releases it.
function bufferIdOf(ctx: Ctx, buffer: Resource): number {
  const st = ctx.state;
  st.dmabufBufferIds ??= new Map<Resource, number>();
  st.dmabufById ??= new Map<number, Resource>();
  let id = st.dmabufBufferIds.get(buffer);
  if (id === undefined) {
    id = (st.nextBufferId = (st.nextBufferId ?? 0) + 1);
    st.dmabufBufferIds.set(buffer, id);
    st.dmabufById.set(id, buffer);
  }
  return id;
}

// The subsurface record for a surface acting as a child (or undefined if it is
// not a subsurface). Keyed in state.subsurfaces by the wl_subsurface resource,
// but we look up by the child wl_surface.
function subOf(ctx: Ctx, s: SurfaceRecord): SubsurfaceRecord | undefined {
  const subs = ctx.state.subsurfaces;
  if (!subs) return undefined;
  for (const sub of subs.values()) if (sub.surface === s.resource) return sub;
  return undefined;
}

// A surface "behaves as synchronized" if it is a subsurface AND (its own mode is
// sync OR its parent behaves as synchronized). The main surface (no subsurface
// record) is always desynchronized. Applied recursively up the parent chain.
function effectiveSync(ctx: Ctx, s: SurfaceRecord): boolean {
  const sub = subOf(ctx, s);
  if (!sub) return false; // main surface / not a subsurface
  if (sub.sync) return true;
  const parentRec = ctx.state.surfaces.get(sub.parent);
  return parentRec ? effectiveSync(ctx, parentRec) : false;
}

// Cap on pending damage rects per surface (request flood guard) and on
// reconciled rects passed to the upload (beyond this a full upload is cheaper
// than many sub-uploads).
const MAX_PENDING_DAMAGE = 64;
const MAX_DAMAGE_RECTS = 16;

// Intersect a rect with [0,W]x[0,H], snapping outward to whole pixels. Returns
// null if the result is empty.
function clipDamageRect(r: RegionRect, w: number, h: number): RegionRect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.width));
  const y1 = Math.min(h, Math.ceil(r.y + r.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Reconcile the committed surface- and buffer-coordinate damage into a list of
// buffer-pixel rects for a partial upload, or null to request a full upload.
// buffer_damage maps directly (clip to bounds). surface_damage is mapped only
// when the buffer transform is normal and no viewport is active -- with a
// transform or viewport, inverting surface->buffer here is not worth the cost,
// so the whole surface is re-uploaded (correct, just not optimized).
function reconcileBufferDamage(
  s: SurfaceRecord, bufW: number, bufH: number,
): RegionRect[] | null {
  const sd = s.committed.surfaceDamage;
  const bd = s.committed.bufferDamage;
  if ((!sd || sd.length === 0) && (!bd || bd.length === 0)) return null;

  const out: RegionRect[] = [];
  if (bd) {
    for (const r of bd) {
      const c = clipDamageRect(r, bufW, bufH);
      if (c) out.push(c);
    }
  }
  if (sd && sd.length) {
    const transform = s.committed.bufferTransform ?? 0;
    const vpSrc = s.pending.viewportSrc !== undefined ? s.pending.viewportSrc : s.viewportSrc;
    const vpDst = s.pending.viewportDst !== undefined ? s.pending.viewportDst : s.viewportDst;
    if (transform !== 0 || vpSrc || vpDst) return null;
    const scale = s.committed.bufferScale ?? 1;
    for (const r of sd) {
      const c = clipDamageRect(
        { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale },
        bufW, bufH);
      if (c) out.push(c);
    }
  }
  if (out.length === 0 || out.length > MAX_DAMAGE_RECTS) return null;
  return out;
}

// Promote a per-commit (acquire, release) pair into the surface's state for
// the upload path (acquire) and the GPU-completion path (release). Only
// honored when the committed buffer is a dmabuf; for shm or no-buffer commits
// the points are dropped (spec's unsupported_buffer / no_buffer territory --
// silent-drop here per the no post_error convention).
function promoteSyncobjForCommit(
  s: SurfaceRecord,
  acq: import("./ctx.js").SyncobjPoint | undefined,
  rel: import("./ctx.js").SyncobjPoint | undefined,
  ctx: Ctx,
): void {
  const buf = s.committed.buffer;
  const desc = buf ? ctx.state.buffers?.get(buf) : undefined;
  if (!desc?.dmabuf) return;
  if (acq) s.acquireForUpload = acq;
  if (rel) s.committed.syncobjRelease = rel;
  // Note: the release point is registered on the compositor in uploadBuffer
  // (it needs the bufferId, which is assigned inside the upload path). That
  // registration triggers signaling when the lifecycle's sendWlRelease for
  // the same bufferId fires -- the same atomic point as wl_buffer.release.
}

// Apply one surface's committed buffer to the GPU (upload/import). Sets
// hasContent. Releases shm buffers (copied at upload). dmabuf import is async.
function uploadBuffer(ctx: Ctx, s: SurfaceRecord, buffer: Resource | null): void {
  if (!buffer || buffer.destroyed) return;
  const desc = ctx.state.buffers?.get(buffer);
  if (desc && desc.dmabuf && desc.fd) {
    const bufferId = bufferIdOf(ctx, buffer);
    // Explicit-sync (wp_linux_drm_syncobj_v1): when commit() promoted an
    // acquire point, export a sync_file from it here (one-shot, per-commit)
    // and hand it to the compositor. The compositor passes it to the GPU
    // process at BeginAccess time INSTEAD of running the implicit-sync
    // EXPORT_SYNC_FILE on the dmabuf -- this is the fix for the NVIDIA
    // flicker race. No acquire point = implicit-sync fallback.
    let acquireFenceFd: import("../types.js").WaylandFd | null = null;
    const acqPt = s.acquireForUpload;
    if (acqPt) {
      acquireFenceFd = ctx.addon.syncobjExportSyncFile(
        acqPt.handle, acqPt.pointHi, acqPt.pointLo);
      s.acquireForUpload = undefined;  // one-shot
    }
    // Register the release point on the compositor BEFORE the commit
    // (commit may trigger immediate intents, including a sendWlRelease for
    // an earlier buffer; binding by bufferId keeps the two paths
    // independent). The release point is signaled when the
    // client-buffer-lifecycle emits sendWlRelease for this bufferId --
    // same atomic step the wire layer sends wl_buffer.release. Cleared
    // after registration so a follow-up commit with no new release point
    // does not re-register the stale one.
    const relPt = s.committed.syncobjRelease;
    if (relPt) {
      ctx.state.compositor.setBufferReleasePoint?.(
        bufferId, relPt.handle, relPt.pointHi, relPt.pointLo);
      s.committed.syncobjRelease = undefined;
    }
    const damage = reconcileBufferDamage(s, desc.width, desc.height);
    const ok = ctx.state.compositor.commitSurfaceDmabuf(
      s.id, desc.fd, desc.width, desc.height, desc.format,
      desc.modifierHi ?? 0, desc.modifierLo ?? 0, desc.offset, desc.stride, bufferId,
      acquireFenceFd ?? undefined, damage ?? undefined);
    if (ok) { ctx.state.lastCommittedSurfaceId = s.id; s.hasContent = true; }
    else if (acquireFenceFd && !acquireFenceFd.closed) {
      // Commit refused (no Dawn wire / no device). Close our sync_file dup so
      // we don't leak the fd; the GPU process never sees it.
      try { acquireFenceFd.close(); } catch { /* already closed */ }
    }
  } else if (desc && desc.poolId) {
    const damage = reconcileBufferDamage(s, desc.width, desc.height);
    // Shm fast path: routes the upload through the GPU process's mmap of
    // the pool so the JS thread doesn't pay the Dawn-wire marshaling cost.
    // Returns a non-zero uploadSeq; we defer wl_buffer.release until the
    // matching ShmUploaded ack arrives (drained in dispatchFrameCallbacks).
    // 0 means the path isn't available (no GPU-process build, test sink) --
    // fall back to the synchronous commitSurfaceBuffer.
    const compositor = ctx.state.compositor;
    const fastSeq = compositor.commitSurfaceBufferShm?.(
      s.id, desc.poolId, desc.offset, desc.width, desc.height, desc.stride,
      damage ?? undefined) ?? 0;
    if (fastSeq > 0) {
      ctx.state.lastCommittedSurfaceId = s.id;
      s.hasContent = true;
      ctx.state.pendingShmReleases ??= new Map();
      ctx.state.pendingShmReleases.set(fastSeq, buffer);
      return;
    }
    const ok = compositor.commitSurfaceBuffer(
      s.id, desc.poolId, desc.offset, desc.width, desc.height, desc.stride,
      damage ?? undefined);
    if (ok) {
      ctx.state.lastCommittedSurfaceId = s.id;
      s.hasContent = true;
      ctx.events.wl_buffer.send_release(buffer); // shm copied at upload
    }
  }
}

// Snapshot the region named by a set_input_region / set_opaque_region request
// into a standalone Region (or null for "infinite"), AT REQUEST TIME. Per spec
// these requests have copy semantics: the client may destroy the wl_region
// immediately after, and an empty region (created, never add()'d) must read as
// "accept nothing". A non-null `region` argument therefore always yields a
// Region -- an empty one when the resource has no rect list yet -- and only a
// null argument means infinite. (Deferring this to commit by resource lookup
// loses both the destroyed and the empty case, collapsing them to "infinite".)
function snapshotRegionArg(
  ctx: Ctx,
  region: Resource | null,
): Region | null {
  if (region === null) return null;              // explicit null = infinite
  const r = ctx.state.regions?.get(region);
  return r ? r.clone() : new Region();           // no rects yet => empty region
}

// Apply a surface's committed state (buffer + frame callbacks + subsurface-
// managed state of its children), then CASCADE into every effective-sync child:
// the child's cached state is applied atomically with this (parent) apply. This
// is the spec's "cached state applied immediately after the parent's state".
// Returns true if this commit changed the draw stack and the caller must
// rebuild it: a (sub)surface gained content for the first time (so it now needs
// a stack slot), or a subsurface position / sibling-order change was applied.
// A plain content re-commit (a new video frame, same geometry and order)
// returns false, so the per-frame fast path skips the global stack rebuild.
// Accumulates across the effective-sync child cascade, so one commit rebuilds
// at most once regardless of subtree depth.
function applySurfaceState(ctx: Ctx, s: SurfaceRecord, bufferFresh: boolean): boolean {
  const hadContent = !!s.hasContent;
  let needsStackRebuild = false;
  // Apply (upload + schedule release of) the committed buffer ONLY when a
  // fresh wl_buffer.attach accompanied this commit. Per spec a commit with no
  // preceding attach leaves the surface contents unchanged; re-running the
  // upload would re-send wl_buffer.release for a buffer the client still owns
  // -- a double release that crashes well-behaved shm clients (GDK/cairo trips
  // its staging-surface assertion). The dmabuf lifecycle dedups internally, but
  // gating here keeps both buffer kinds on the same correct rule.
  if (bufferFresh) uploadBuffer(ctx, s, s.committed.buffer);
  // Damage is consumed by the upload; the next commit re-accumulates it.
  s.committed.surfaceDamage = undefined;
  s.committed.bufferDamage = undefined;
  // X clients never call wl_surface.set_buffer_scale; the compositor lies
  // to the X side about pixel sizes by the global X scale (see
  // docs/xwayland-design.md "HiDPI") so the X buffer arrives oversized by
  // that factor. Stamp it as bufferScale=N so the composite path divides
  // back down to the right logical intrinsic size. Also propagate to
  // s.committed.bufferScale so the surface-damage scaling path
  // (currentScaledDamage) sees the same value.
  if (s.role === "xwayland") {
    const n = ctx.state.xwaylandScale ?? 1;
    if (n !== 1) s.committed.bufferScale = n;
  }
  ctx.state.compositor.setSurfaceBufferScale?.(s.id, s.committed.bufferScale ?? 1);
  ctx.state.compositor.setSurfaceBufferTransform?.(s.id, s.committed.bufferTransform ?? 0);
  // xdg_surface.set_window_geometry: push the declared "window" sub-
  // rect to the compositor so it anchors the buffer with the geometry
  // origin at the WM-assigned position (shadow / pop-out chrome
  // overflows naturally). Null = no geometry set; the compositor
  // anchors at the buffer's top-left (pre-CSD behavior).
  const xsGeom = s.xdgSurface?.geometry ?? null;
  ctx.state.compositor.setSurfaceGeometry?.(s.id, xsGeom);

  // Promote this surface's pending frame callbacks to "armed" (fired by the
  // per-frame dispatch). Double-buffered: they arm on apply, not on request.
  if (s.pending.frameCallbacks?.length) {
    (s.frameCallbacks ??= []).push(...s.pending.frameCallbacks);
    s.pending.frameCallbacks = undefined;
  }
  // wp_presentation: supersede any previously-applied feedback that the
  // prior commit queued but that hasn't scanned out yet (the new commit
  // means the old one never will), then promote pending feedbacks to
  // applied for the new commit.
  applyPresentationFeedbacks(ctx, s);

  // Apply input/opaque regions. undefined = no set_*_region call this
  // cycle, leave applied region alone. The pending value is already a
  // snapshot (taken at set_*_region time), so promote it verbatim.
  if (s.pending.inputRegion !== undefined) {
    s.inputRegion = s.pending.inputRegion;
    s.pending.inputRegion = undefined;
  }
  if (s.pending.opaqueRegion !== undefined) {
    s.opaqueRegion = s.pending.opaqueRegion;
    s.pending.opaqueRegion = undefined;
  }

  // Apply wp_viewport state. undefined = unchanged; push to the compositor
  // only when src or dst changed this cycle (OR the compositor surface
  // was torn down since the last apply -- after a role-detach the
  // compositor Surface entry is a blank slate that needs every latched
  // protocol-side value re-pushed).
  let viewportChanged = !!s.needsCompositorResync;
  if (s.pending.viewportSrc !== undefined) {
    s.viewportSrc = s.pending.viewportSrc;
    s.pending.viewportSrc = undefined;
    viewportChanged = true;
  }
  if (s.pending.viewportDst !== undefined) {
    s.viewportDst = s.pending.viewportDst;
    s.pending.viewportDst = undefined;
    viewportChanged = true;
  }
  if (viewportChanged) {
    ctx.state.compositor.setSurfaceViewport?.(s.id, s.viewportDst ?? null, s.viewportSrc ?? null);
  }
  s.needsCompositorResync = false;

  // Subsurface-managed state (position + sibling reorder) of THIS
  // surface's children is applied on THIS surface's commit, regardless
  // of child mode (spec).
  if (applySubsurfaceReorder(ctx.state, s.resource)) needsStackRebuild = true;
  const subs = ctx.state.subsurfaces;
  if (subs) {
    for (const sub of subs.values()) {
      if (sub.parent !== s.resource) continue;
      if (sub.x !== sub.pendingX || sub.y !== sub.pendingY) needsStackRebuild = true;
      sub.x = sub.pendingX;
      sub.y = sub.pendingY;
      // Cascade: apply each effective-sync child's cached commit atomically.
      const childRec = ctx.state.surfaces.get(sub.surface);
      if (childRec && effectiveSync(ctx, childRec) && childRec.cached) {
        const childBufferFresh = childRec.cached.bufferFresh ?? false;
        childRec.committed.buffer = childRec.cached.buffer ?? childRec.committed.buffer;
        if (childRec.cached.bufferScale !== undefined) {
          childRec.committed.bufferScale = childRec.cached.bufferScale;
        }
        if (childRec.cached.bufferTransform !== undefined) {
          childRec.committed.bufferTransform = childRec.cached.bufferTransform;
        }
        if (childRec.cached.frameCallbacks?.length) {
          (childRec.pending.frameCallbacks ??= []).push(...childRec.cached.frameCallbacks);
        }
        if (childRec.cached.presentationFeedbacks?.length) {
          (childRec.pending.presentationFeedbacks ??= [])
            .push(...childRec.cached.presentationFeedbacks);
        }
        if (childRec.cached.inputRegion !== undefined) {
          childRec.pending.inputRegion = childRec.cached.inputRegion;
        }
        if (childRec.cached.opaqueRegion !== undefined) {
          childRec.pending.opaqueRegion = childRec.cached.opaqueRegion;
        }
        if (childRec.cached.viewportSrc !== undefined) {
          childRec.pending.viewportSrc = childRec.cached.viewportSrc;
        }
        if (childRec.cached.viewportDst !== undefined) {
          childRec.pending.viewportDst = childRec.cached.viewportDst;
        }
        if (childRec.cached.surfaceDamage) {
          (childRec.committed.surfaceDamage ??= []).push(...childRec.cached.surfaceDamage);
        }
        if (childRec.cached.bufferDamage) {
          (childRec.committed.bufferDamage ??= []).push(...childRec.cached.bufferDamage);
        }
        childRec.cached = undefined;
        if (applySurfaceState(ctx, childRec, childBufferFresh)) needsStackRebuild = true;
      }
    }
  }

  // A surface entering the draw stack (first content) needs a rebuild; further
  // content commits on an already-drawn surface do not.
  if (!hadContent && s.hasContent) needsStackRebuild = true;
  return needsStackRebuild;
}

export default function makeSurface(ctx: Ctx): WlSurfaceHandler {
  const rec = (resource: Resource) => ctx.state.surfaces.get(resource);

  return {
    attach(resource, buffer, x, y) {
      const s = rec(resource);
      if (!s) return;
      s.pending.buffer = buffer; // wl_buffer wrapper or null
      // Pre-v5 attach carries the buffer offset; v5+ clients pass 0 here and
      // use the offset request instead (a non-zero offset on a v5 attach is a
      // protocol error we don't currently post -- it arrives as 0 in practice).
      if (x !== 0 || y !== 0) { s.pending.offsetX = x; s.pending.offsetY = y; }
    },
    damage(resource, x, y, w, h) {
      const s = rec(resource);
      if (!s || w <= 0 || h <= 0) return;
      const list = (s.pending.surfaceDamage ??= []);
      if (list.length < MAX_PENDING_DAMAGE) list.push({ x, y, width: w, height: h });
    },
    damage_buffer(resource, x, y, w, h) {
      const s = rec(resource);
      if (!s || w <= 0 || h <= 0) return;
      const list = (s.pending.bufferDamage ??= []);
      if (list.length < MAX_PENDING_DAMAGE) list.push({ x, y, width: w, height: h });
    },
    frame(resource, callback) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered: the callback arms when this surface's state is applied.
      (s.pending.frameCallbacks ??= []).push(callback);
    },
    set_opaque_region(resource, region) {
      const s = rec(resource);
      if (!s) return;
      // Copy semantics: snapshot the region's rects NOW (the client may
      // destroy the wl_region before the next commit). Double-buffered:
      // the snapshot is promoted to applied state on commit.
      s.pending.opaqueRegion = snapshotRegionArg(ctx, region);
    },
    set_input_region(resource, region) {
      const s = rec(resource);
      if (!s) return;
      s.pending.inputRegion = snapshotRegionArg(ctx, region);
    },
    set_buffer_transform(resource, transform) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered; applied on commit. Out-of-range is a protocol error
      // (wl_surface.invalid_transform, v6); silent-drop per convention. Values
      // are the wl_output.transform enum (0=normal,1=90,2=180,3=270, 4..7 the
      // mirrored variants).
      if (!Number.isInteger(transform) || transform < 0 || transform > 7) {
        ctx.addon.postError(resource, WlSurface_Error.invalid_transform,
          `wl_surface.set_buffer_transform: invalid transform ${transform}`);
        return;
      }
      s.pending.bufferTransform = transform;
    },
    set_buffer_scale(resource, scale) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered; applied on commit. A non-positive scale is a protocol
      // error (wl_surface.invalid_scale, since v6).
      if (!Number.isInteger(scale) || scale < 1) {
        ctx.addon.postError(resource, WlSurface_Error.invalid_scale,
          `wl_surface.set_buffer_scale: scale must be positive, got ${scale}`);
        return;
      }
      s.pending.bufferScale = scale;
    },
    offset(resource, x, y) {
      const s = rec(resource);
      if (s) { s.pending.offsetX = x; s.pending.offsetY = y; }
    },
    commit(resource) {
      const s = rec(resource);
      if (!s) return;

      // Whether this commit carries a fresh wl_buffer.attach (to a buffer or to
      // null). Drives the apply gate so a bare commit doesn't re-upload /
      // double-release the unchanged buffer (see applySurfaceState).
      const attachedThisCommit = s.pending.buffer !== undefined;

      // Promote pending buffer into the commit set (undefined = unchanged).
      if (s.pending.buffer !== undefined) {
        s.committed.buffer = s.pending.buffer;
        s.pending.buffer = undefined;
      }
      // buffer_scale travels with the buffer (double-buffered).
      if (s.pending.bufferScale !== undefined) {
        s.committed.bufferScale = s.pending.bufferScale;
        s.pending.bufferScale = undefined;
      }
      if (s.pending.bufferTransform !== undefined) {
        s.committed.bufferTransform = s.pending.bufferTransform;
        s.pending.bufferTransform = undefined;
      }
      // Buffer offset accumulates into the surface's placement delta (consumed
      // by the DnD drag-icon and popup positioning).
      if (s.pending.offsetX !== undefined || s.pending.offsetY !== undefined) {
        s.offsetDx = (s.offsetDx ?? 0) + (s.pending.offsetX ?? 0);
        s.offsetDy = (s.offsetDy ?? 0) + (s.pending.offsetY ?? 0);
        s.pending.offsetX = undefined;
        s.pending.offsetY = undefined;
      }
      // Damage travels with the buffer (double-buffered); accumulate into the
      // commit set (cleared by the upload in applySurfaceState).
      if (s.pending.surfaceDamage) {
        (s.committed.surfaceDamage ??= []).push(...s.pending.surfaceDamage);
        s.pending.surfaceDamage = undefined;
      }
      if (s.pending.bufferDamage) {
        (s.committed.bufferDamage ??= []).push(...s.pending.bufferDamage);
        s.pending.bufferDamage = undefined;
      }

      // wp_linux_drm_syncobj_v1: acquire/release timeline points are
      // double-buffered, applied to exactly one commit. The spec error checks
      // (no_buffer / no_acquire_point / no_release_point / conflicting_points)
      // would fire here in a compositor with wl_resource_post_error; today
      // we silently drop the point on violation (status.md "no post_error").
      // What we DO enforce locally: only honor points when a dmabuf buffer
      // accompanies them -- otherwise the points are dropped (the shm path
      // has no fence to wait on and no submit-completion to signal).
      // promotePoints lives below the layer-shell discard so a discarded
      // initial commit doesn't carry phantom points forward.

      // Layer-shell: a buffer attached before the first configure-ack is
      // invalid_surface_state per spec. Silent-drop convention (no
      // post_error path in this compositor today; see top of
      // zwlr_layer_shell_v1.ts); discard the buffer so it never reaches
      // the GPU.
      if (s.layerSurface && isLayerSurfaceInitialCommit(s.layerSurface) && s.committed.buffer) {
        s.committed.buffer = null;
      }

      // Promote the pending syncobj points. Only honored when a dmabuf is
      // attached this commit (a buffer-less commit drops the points outright;
      // an shm commit logs and drops, since explicit-sync is undefined there
      // -- spec's unsupported_buffer error). Cleared from pending whatever the
      // outcome so they don't leak forward.
      const pendAcq = s.pending.syncobjAcquire;
      const pendRel = s.pending.syncobjRelease;
      s.pending.syncobjAcquire = undefined;
      s.pending.syncobjRelease = undefined;

      if (effectiveSync(ctx, s)) {
        // Synchronized subsurface: CACHE this commit; do not apply. The cache is
        // applied when the parent commits (via applySurfaceState's cascade).
        s.cached ??= {};
        s.cached.buffer = s.committed.buffer;
        // Sticky: the cached buffer is fresh if ANY commit in this cache cycle
        // attached one, so the parent's cascade applies (and releases) it once.
        s.cached.bufferFresh = (s.cached.bufferFresh ?? false) || attachedThisCommit;
        if (s.committed.bufferScale !== undefined) s.cached.bufferScale = s.committed.bufferScale;
        if (s.committed.bufferTransform !== undefined) s.cached.bufferTransform = s.committed.bufferTransform;
        if (s.committed.surfaceDamage) {
          (s.cached.surfaceDamage ??= []).push(...s.committed.surfaceDamage);
          s.committed.surfaceDamage = undefined;
        }
        if (s.committed.bufferDamage) {
          (s.cached.bufferDamage ??= []).push(...s.committed.bufferDamage);
          s.committed.bufferDamage = undefined;
        }
        if (s.pending.frameCallbacks?.length) {
          (s.cached.frameCallbacks ??= []).push(...s.pending.frameCallbacks);
          s.pending.frameCallbacks = undefined;
        }
        if (s.pending.presentationFeedbacks?.length) {
          (s.cached.presentationFeedbacks ??= [])
            .push(...s.pending.presentationFeedbacks);
          s.pending.presentationFeedbacks = undefined;
        }
        if (s.pending.inputRegion !== undefined) {
          s.cached.inputRegion = s.pending.inputRegion;
          s.pending.inputRegion = undefined;
        }
        if (s.pending.opaqueRegion !== undefined) {
          s.cached.opaqueRegion = s.pending.opaqueRegion;
          s.pending.opaqueRegion = undefined;
        }
        if (s.pending.viewportSrc !== undefined) {
          s.cached.viewportSrc = s.pending.viewportSrc;
          s.pending.viewportSrc = undefined;
        }
        if (s.pending.viewportDst !== undefined) {
          s.cached.viewportDst = s.pending.viewportDst;
          s.pending.viewportDst = undefined;
        }
        // Cache the syncobj points to be promoted alongside the buffer when
        // the parent commits.
        if (pendAcq) s.cached.syncobjAcquire = pendAcq;
        if (pendRel) s.cached.syncobjRelease = pendRel;
      } else {
        // Desynchronized (incl. main surface): apply now. If a cache exists (e.g.
        // it was sync then switched to desync), it is flushed as part of apply.
        let cachedBufferFresh = false;
        if (s.cached) {
          cachedBufferFresh = s.cached.bufferFresh ?? false;
          s.committed.buffer = s.cached.buffer ?? s.committed.buffer;
          if (s.cached.bufferScale !== undefined) s.committed.bufferScale = s.cached.bufferScale;
          if (s.cached.bufferTransform !== undefined) s.committed.bufferTransform = s.cached.bufferTransform;
          if (s.cached.surfaceDamage) {
            (s.committed.surfaceDamage ??= []).push(...s.cached.surfaceDamage);
          }
          if (s.cached.bufferDamage) {
            (s.committed.bufferDamage ??= []).push(...s.cached.bufferDamage);
          }
          if (s.cached.frameCallbacks?.length) {
            (s.pending.frameCallbacks ??= []).push(...s.cached.frameCallbacks);
          }
          if (s.cached.inputRegion !== undefined) {
            s.pending.inputRegion = s.cached.inputRegion;
          }
          if (s.cached.opaqueRegion !== undefined) {
            s.pending.opaqueRegion = s.cached.opaqueRegion;
          }
          if (s.cached.viewportSrc !== undefined) {
            s.pending.viewportSrc = s.cached.viewportSrc;
          }
          if (s.cached.viewportDst !== undefined) {
            s.pending.viewportDst = s.cached.viewportDst;
          }
          // Flushed cached syncobj points alongside the buffer.
          const cachedAcq = s.cached.syncobjAcquire;
          const cachedRel = s.cached.syncobjRelease;
          s.cached = undefined;
          if (cachedAcq || cachedRel) {
            promoteSyncobjForCommit(s, cachedAcq, cachedRel, ctx);
          }
        }
        // Desync promotion of THIS commit's own pending points (if any).
        if (pendAcq || pendRel) {
          promoteSyncobjForCommit(s, pendAcq, pendRel, ctx);
        }
        // Rebuild the draw stack only when this commit actually changed it
        // (a surface gained content, or a subsurface moved/reordered) -- not on
        // every content commit. Map/unmap, window move/resize, workspace and
        // subsurface add/remove drive their own rebuilds elsewhere.
        if (applySurfaceState(ctx, s, attachedThisCommit || cachedBufferFresh)) {
          applySubsurfaces(ctx.state);
        }
      }

      if (s.xdgSurface) s.xdgSurface.lastCommitSerial = ctx.state.nextSerial - 1;

      // Null-buffer-commit unmap: per xdg-shell, attaching null and
      // committing on a mapped surface unmaps it (without destroying
      // the role). The client may then commit a new buffer to re-map
      // under the same role. detachSurfaceRole resets the wl_surface
      // to the same state a role-destroy would (window.unmap fired,
      // WM/compositor entries dropped, mapped flag cleared) so the
      // next non-null commit re-runs the map sweep cleanly.
      if (s.mapped && s.committed.buffer === null
          && (s.role === "xdg_popup" || s.role === "xdg_toplevel"
              || s.role === "layer_surface")) {
        detachSurfaceRole(ctx.state, s);
        s.hasContent = false;
      }

      // Initial-commit detection (xdg-shell): the first commit on a
      // toplevel-roled surface whose xdg_surface has not yet sent any
      // configure. Per spec the client commits the xdg_surface with no
      // buffer to signal "ready for configure".
      //
      // Complete the handshake IN THIS DISPATCH: send the throwaway 0x0 first
      // configure synchronously (carrying the resolved state array) so a client
      // that does a single wl_display_roundtrip after its initial commit sees
      // the configure within that roundtrip -- the common idiom. The real tile
      // size follows as a SECOND configure once layout/plugins resolve.
      //
      // markInitialCommitComplete then runs async: it emits window.preconfigure
      // (window-rules plugins may change presentation), commits the final state,
      // and schedules the layout pass that drives the sized second configure.
      const xs = s.xdgSurface;
      if (xs?.toplevel && xs.lastConfigureSerial === null) {
        ctx.state.wm?.sendInitialConfigure(s.id);
        const t = ctx.state.toplevels?.get(xs.toplevel);
        const appId = t?.appId ?? null;
        const title = t?.title ?? null;
        void ctx.state.wm?.markInitialCommitComplete(s.id, { appId, title, xwayland: false });
      } else if (xs?.toplevel) {
        // A non-initial commit: the client re-rendered, which may satisfy a
        // held resize (it has acked the size the WM asked for). Pass the
        // highest acked serial; the WM releases that window's hold and applies
        // the batch once every held window is ready.
        ctx.state.wm?.notifyToplevelCommit(s.id, xs.lastAckedSerial ?? null);
      }

      // Phase 9c: if this surface has the "cursor" role and is the
      // current pointer focus's active cursor surface, re-apply the
      // cursor slot so the just-uploaded texture is picked up by the
      // compositor. The seat re-checks ownership before mutating.
      if (s.role === "cursor") {
        ctx.state.seat?.cursor.onCursorSurfaceCommit(resource);
      }

      // Layer-shell: drive the configure handshake + apply pipeline. The
      // initial commit (no configure sent yet) sends the first configure
      // with the resolved size; subsequent commits apply any pending
      // double-buffered state (set_size / set_anchor / ...) and may send
      // a new configure when the rect changed.
      const ls = s.layerSurface;
      if (ls && !ls.destroyed) {
        if (isLayerSurfaceInitialCommit(ls)) {
          applyLayerSurfaceInitial(ctx, ls);
        } else {
          applyLayerSurfacePending(ctx, ls);
        }
      }
    },
    destroy(resource) {
      const s = rec(resource);
      if (s) unmapAndTeardownSurface(ctx.state, s);
      ctx.state.surfaces.delete(resource);
    },
  };
}

// Logical unmap of a surface in its current role: emit window.unmap
// (mapped toplevels / layer surfaces), drop WM tracking + compositor
// stack entry, tear down layer-shell reservations, and reset the
// wl_surface's role-bound state so re-roling on the same wl_surface
// works. The wl_surface itself is NOT destroyed -- callers that need
// the full destroy path (the wl_surface resource itself going away)
// use unmapAndTeardownSurface, which adds the s.unmapped guard +
// surfacesById removal on top.
//
// Used by xdg_popup.destroy, xdg_toplevel.destroy,
// zwlr_layer_surface_v1.destroy, and the null-buffer commit unmap
// path. The common GTK pattern is destroy xdg_popup + xdg_surface +
// re-bind on the same wl_surface for the next menu open; without this
// the second open's map-on-first-content sweep sees s.mapped === true
// from the prior role and silently skips it.
//
// Two phases. The role-state cleanup runs UNCONDITIONALLY (layer-shell
// reservations are registered at apply-time, before the surface ever
// maps -- destroying an applied-but-never-mapped layer surface must
// still clear its zone). The mapped-state reset (events + WM unmap +
// compositor stack drop + flag reset) runs only when the surface
// actually mapped.
export function detachSurfaceRole(state: CompositorState, s: SurfaceRecord): void {
  // Role-state cleanup -- runs even when never-mapped. Layer-shell
  // reservations register on apply, not on map; the zone must be
  // released regardless of whether the surface ever showed content.
  if (s.layerSurface) {
    teardownLayerSurface(state, s.layerSurface);
    s.layerSurface = null;
  }
  if (!s.mapped) return;
  // Mapped-only path: emit unmap event + clear runtime state.
  // BEFORE the WM/compositor teardown, give the closing driver a chance
  // to capture a phantom. No-op when no plugin claims the
  // 'window-closing' namespace.
  const phantomSurfaceId = state.closingDriver?.beforeUnmap(state, s) ?? null;
  // Cancel any opening-driver backstop -- if the window unmaps while
  // still gated (client crashed before the plugin called
  // releaseOpeningGate, or window destroyed mid-animation), the timer
  // would fire later on a surfaceId that no longer exists. Idempotent
  // when no backstop is armed.
  state.openingDriver?.cancelBackstop(s.id);
  // Emit window.unmap for toplevel-shaped surfaces only. Override-redirect
  // xwayland overlays are transient (menus/tooltips/DnD icons); plugins
  // never saw a corresponding window.map for them and shouldn't see an
  // unmap either.
  const isXwaylandOverrideRedirect = s.role === "xwayland"
    && (state.xwm?.findBySurfaceId(s.id)?.overrideRedirect ?? false);
  const emitsWindowEvents = (s.role === "xdg_toplevel"
                          || s.role === "layer_surface"
                          || (s.role === "xwayland" && !isXwaylandOverrideRedirect));
  if (emitsWindowEvents) {
    state.bus?.emit(WINDOW_EVENT.unmap, { surfaceId: s.id });
  }
  state.pendingWindowChanges?.delete(s.id);
  state.wm?.unmapWindow(s.id, phantomSurfaceId !== null ? { phantomSurfaceId } : undefined);
  state.compositor.removeSurface(s.id);
  // The compositor-side Surface entry is gone; the next first-commit
  // recreates it as blank. Force the next applySurfaceState to
  // re-push every latched protocol-side state value (viewport, etc.)
  // that the change-detect path would otherwise skip.
  s.needsCompositorResync = true;
  // Reset the wl_surface's mapped/role state so a fresh role binding
  // on the same wl_surface re-runs through the map-on-first-content
  // sweep.
  s.mapped = false;
  // Drop pending wl_surface.frame callbacks: an unmapped surface can't
  // produce frame callbacks; leaving them queued would deliver them at
  // some unrelated future render after a re-bind.
  s.frameCallbacks = undefined;
  s.pending.frameCallbacks = undefined;
  // wp_presentation: send `discarded` on any feedback still queued for
  // this surface (applied or pending) so the client isn't left waiting
  // on a dead surface.
  const fbEvents = state.events?.wp_presentation_feedback;
  if (fbEvents) {
    const sweep = (arr: Resource[] | undefined): void => {
      if (!arr) return;
      for (const cb of arr) {
        if (cb.destroyed) continue;
        fbEvents.send_discarded(cb);
      }
    };
    sweep(s.presentationFeedbacks);
    sweep(s.pending.presentationFeedbacks);
  }
  s.presentationFeedbacks = undefined;
  s.pending.presentationFeedbacks = undefined;
  // Output residency must rebuild from scratch: a re-roled surface may
  // land on a different output, and the residency differ would
  // otherwise miss the implicit "left every output" transition.
  s.enteredOutputs?.clear();
  // hasContent stays as a "the surface has presentable bytes" flag;
  // next commit refreshes it. A null-buffer-commit unmap clears it
  // explicitly because the surface no longer has presentable content.
}

// Run a surface's full destroy teardown for the case where the
// wl_surface itself is going away (explicit wl_surface.destroy OR
// resource-destroyed sweep on client disconnect). Builds on
// detachSurfaceRole for the role-detach work, then marks the surface
// permanently unmapped and removes its surfacesById entry. IDEMPOTENT
// via the `unmapped` guard so both the explicit-destroy path AND the
// disconnect sweep can each call it safely; whichever runs first does
// the work, the second is a no-op. Without the sweep path, a client
// that disconnects without explicitly destroying its wl_surface would
// never emit window.unmap, leaking any decoration ring bound to that
// window (the provider frees it on sdk.windows.onUnmap).
export function unmapAndTeardownSurface(state: CompositorState, s: SurfaceRecord): void {
  if (s.unmapped) return;
  s.unmapped = true;
  detachSurfaceRole(state, s);
  state.surfacesById?.delete(s.id);
}
