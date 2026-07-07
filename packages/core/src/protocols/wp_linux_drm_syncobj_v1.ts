// wp_linux_drm_syncobj_v1: explicit-sync extension for clients that opt out of
// implicit dmabuf synchronization. The protocol has three interfaces:
//
//   manager  (global): get_surface(wl_surface), import_timeline(fd)
//   timeline (child of manager): drm_syncobj timeline; per-DRM-fd handle.
//   surface  (child of manager): set_acquire_point(timeline, hi, lo),
//                                set_release_point(timeline, hi, lo).
//
// Per-commit semantics (mirrored from the spec):
//   - get_surface establishes explicit-sync mode for the wl_surface. While
//     active, a buffer-attaching commit MUST set BOTH points (no_acquire_point
//     / no_release_point), and wl_buffer.release is suppressed in favor of
//     the release_point.
//   - The acquire point is the fence the compositor must wait on before
//     sampling the attached buffer. We export a sync_file from it at commit
//     time and hand it to the GPU process via writeBeginAccessWithFence
//     instead of the implicit EXPORT_SYNC_FILE path.
//   - The release point is what the compositor signals when its GPU read of
//     the attached buffer completes. The JS compositor's
//     queue.onSubmittedWorkDone callback drives the syncobjTimelineSignal.
//
// Why this matters: the NVIDIA proprietary driver does NOT attach implicit
// fences to its dmabufs. Without explicit-sync, the compositor's per-frame
// EXPORT_SYNC_FILE returns an already-signaled stub fence and the sample
// races the client's pending writes (status.md "Read first" / NVIDIA flicker).

import type { WpLinuxDrmSyncobjManagerV1Handler }
  from "#protocols-gen/wp_linux_drm_syncobj_manager_v1.js";
import { WpLinuxDrmSyncobjManagerV1_Error }
  from "#protocols-gen/wp_linux_drm_syncobj_manager_v1.js";
import type { WpLinuxDrmSyncobjTimelineV1Handler }
  from "#protocols-gen/wp_linux_drm_syncobj_timeline_v1.js";
import type { WpLinuxDrmSyncobjSurfaceV1Handler }
  from "#protocols-gen/wp_linux_drm_syncobj_surface_v1.js";

import type { Ctx, SyncobjPoint } from "./ctx.js";
import type { Resource } from "../types.js";

// Look up the surface bound to a wp_linux_drm_syncobj_surface_v1 resource.
function surfaceFor(ctx: Ctx, syncobjSurface: Resource): Resource | undefined {
  return ctx.state.syncobjSurfaces?.get(syncobjSurface);
}

// Look up the DRM handle bound to a wp_linux_drm_syncobj_timeline_v1 resource.
function handleFor(ctx: Ctx, timeline: Resource): number | undefined {
  return ctx.state.syncobjTimelines?.get(timeline);
}

export default function makeSyncobjManager(ctx: Ctx): WpLinuxDrmSyncobjManagerV1Handler {
  return {
    destroy(_resource) {
      // Per spec: existing timeline / surface objects are unaffected.
    },
    get_surface(resource, id, surface) {
      // surface_exists: a syncobj-surface already exists for this wl_surface.
      const existing = ctx.state.syncobjSurfaceBySurface?.get(surface);
      if (existing) {
        ctx.addon.postError(resource, WpLinuxDrmSyncobjManagerV1_Error.surface_exists,
          "wl_surface already has a wp_linux_drm_syncobj_surface_v1");
        return;
      }

      (ctx.state.syncobjSurfaces ??= new Map()).set(id, surface);
      (ctx.state.syncobjSurfaceBySurface ??= new Map()).set(surface, id);
      const s = ctx.state.surfaces.get(surface);
      if (s) s.syncobjEnabled = true;
    },
    import_timeline(_resource, id, fd) {
      // The addon owns the DRM fd; it returns 0 on failure. The fd is consumed
      // by drmSyncobjFDToHandle whether it succeeds or fails. (Spec error
      // invalid_timeline = value 1 -- silent-drop today; the timeline resource
      // is created anyway with handle=0, and any later set_acquire_point /
      // set_release_point on it will route through handle==0, which we treat
      // as "no fence" downstream so a sample falls back to implicit sync
      // rather than wedging.)
      const handle = ctx.addon.syncobjImportTimeline(fd);
      (ctx.state.syncobjTimelines ??= new Map()).set(id, handle);
    },
  };
}

// Per-frame disconnect sweep (wired in installProtocols alongside the
// other protocol sweeps): a client that vanished never sent the destructor
// requests, which would leak one kernel drm_syncobj handle per imported
// timeline plus the surface-association map entries.
export function sweepDisconnected(ctx: Ctx): void {
  const timelines = ctx.state.syncobjTimelines;
  if (timelines) {
    for (const [r, handle] of [...timelines.entries()]) {
      if (!r.destroyed) continue;
      if (handle !== 0) ctx.addon.syncobjDestroy(handle);
      timelines.delete(r);
    }
  }
  const surfaces = ctx.state.syncobjSurfaces;
  if (surfaces) {
    for (const [r, surface] of [...surfaces.entries()]) {
      if (!r.destroyed && !surface.destroyed) continue;
      surfaces.delete(r);
      ctx.state.syncobjSurfaceBySurface?.delete(surface);
    }
  }
}

export function makeSyncobjTimeline(ctx: Ctx): WpLinuxDrmSyncobjTimelineV1Handler {
  return {
    destroy(resource) {
      // The spec says destroying the timeline does NOT unset points already
      // set via set_acquire_point / set_release_point; those continue to
      // reference the handle until the surface's next commit consumes them.
      // We therefore look up the handle here and release it -- the points
      // stored on the surface record copied the handle by value at request
      // time, so they still work for the current cycle. (The kernel keeps the
      // syncobj alive as long as anything refs it.)
      const handle = ctx.state.syncobjTimelines?.get(resource);
      if (handle !== undefined && handle !== 0) ctx.addon.syncobjDestroy(handle);
      ctx.state.syncobjTimelines?.delete(resource);
    },
  };
}

export function makeSyncobjSurface(ctx: Ctx): WpLinuxDrmSyncobjSurfaceV1Handler {
  // Build a SyncobjPoint from the request args. Returns undefined if the
  // timeline resource has no live handle (the silent-drop import_timeline
  // failure case): callers store undefined, which is treated as "no point set"
  // -- the commit then takes the implicit-sync fallback for that direction
  // rather than wedging on a phantom fence.
  function pointFrom(
    timeline: Resource, pointHi: number, pointLo: number,
  ): SyncobjPoint | undefined {
    const handle = handleFor(ctx, timeline);
    if (handle === undefined || handle === 0) return undefined;
    return { timelineResource: timeline, handle, pointHi, pointLo };
  }

  return {
    destroy(resource) {
      // Per spec: timeline points set on this object since the last commit
      // MAY be discarded. We discard them: the wl_surface keeps any points
      // already promoted into `committed` (those gate the current frame's
      // wait/signal) but `pending` is cleared.
      const surface = surfaceFor(ctx, resource);
      ctx.state.syncobjSurfaces?.delete(resource);
      if (surface) {
        ctx.state.syncobjSurfaceBySurface?.delete(surface);
        const s = ctx.state.surfaces.get(surface);
        if (s) {
          s.syncobjEnabled = false;
          s.pending.syncobjAcquire = undefined;
          s.pending.syncobjRelease = undefined;
        }
      }
    },
    set_acquire_point(resource, timeline, pointHi, pointLo) {
      const surface = surfaceFor(ctx, resource);
      if (!surface) return;  // spec: no_surface error -- silent-drop
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;
      s.pending.syncobjAcquire = pointFrom(timeline, pointHi, pointLo);
    },
    set_release_point(resource, timeline, pointHi, pointLo) {
      const surface = surfaceFor(ctx, resource);
      if (!surface) return;  // spec: no_surface error -- silent-drop
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;
      s.pending.syncobjRelease = pointFrom(timeline, pointHi, pointLo);
    },
  };
}
