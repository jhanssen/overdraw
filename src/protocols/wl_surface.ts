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
import type { Ctx, SurfaceRecord, SubsurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import { applySubsurfaces } from "../subsurfaces.js";

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

// Apply one surface's committed buffer to the GPU (upload/import). Sets
// hasContent. Releases shm buffers (copied at upload). dmabuf import is async.
function uploadBuffer(ctx: Ctx, s: SurfaceRecord, buffer: Resource | null): void {
  if (!buffer || buffer.destroyed) return;
  const desc = ctx.state.buffers?.get(buffer);
  if (desc && desc.dmabuf && desc.fd) {
    const bufferId = bufferIdOf(ctx, buffer);
    const ok = ctx.state.compositor.commitSurfaceDmabuf(
      s.id, desc.fd, desc.width, desc.height, desc.format,
      desc.modifierHi ?? 0, desc.modifierLo ?? 0, desc.offset, desc.stride, bufferId);
    if (ok) { ctx.state.lastCommittedSurfaceId = s.id; s.hasContent = true; }
  } else if (desc && desc.poolId) {
    const ok = ctx.state.compositor.commitSurfaceBuffer(
      s.id, desc.poolId, desc.offset, desc.width, desc.height, desc.stride);
    if (ok) {
      ctx.state.lastCommittedSurfaceId = s.id;
      s.hasContent = true;
      ctx.events.wl_buffer.send_release(buffer); // shm copied at upload
    }
  }
}

// Apply a surface's committed state (buffer + frame callbacks + subsurface-
// managed state of its children), then CASCADE into every effective-sync child:
// the child's cached state is applied atomically with this (parent) apply. This
// is the spec's "cached state applied immediately after the parent's state".
function applySurfaceState(ctx: Ctx, s: SurfaceRecord): void {
  uploadBuffer(ctx, s, s.committed.buffer);

  // Promote this surface's pending frame callbacks to "armed" (fired by the
  // per-frame dispatch). Double-buffered: they arm on apply, not on request.
  if (s.pending.frameCallbacks?.length) {
    (s.frameCallbacks ??= []).push(...s.pending.frameCallbacks);
    s.pending.frameCallbacks = undefined;
  }

  // Subsurface-managed state (position) of THIS surface's children is applied on
  // THIS surface's commit, regardless of child mode (spec). Copy pending->applied.
  const subs = ctx.state.subsurfaces;
  if (subs) {
    for (const sub of subs.values()) {
      if (sub.parent !== s.resource) continue;
      sub.x = sub.pendingX;
      sub.y = sub.pendingY;
      // Cascade: apply each effective-sync child's cached commit atomically.
      const childRec = ctx.state.surfaces.get(sub.surface);
      if (childRec && effectiveSync(ctx, childRec) && childRec.cached) {
        childRec.committed.buffer = childRec.cached.buffer ?? childRec.committed.buffer;
        if (childRec.cached.frameCallbacks?.length) {
          (childRec.pending.frameCallbacks ??= []).push(...childRec.cached.frameCallbacks);
        }
        childRec.cached = undefined;
        applySurfaceState(ctx, childRec);
      }
    }
  }

  if (s.hasContent) applySubsurfaces(ctx.state);
}

export default function makeSurface(ctx: Ctx): WlSurfaceHandler {
  const rec = (resource: Resource) => ctx.state.surfaces.get(resource);

  return {
    attach(resource, buffer, _x, _y) {
      const s = rec(resource);
      if (s) s.pending.buffer = buffer; // wl_buffer wrapper or null
    },
    damage(_resource, _x, _y, _w, _h) {},
    damage_buffer(_resource, _x, _y, _w, _h) {},
    frame(resource, callback) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered: the callback arms when this surface's state is applied.
      (s.pending.frameCallbacks ??= []).push(callback);
    },
    set_opaque_region(_resource, _region) {},
    set_input_region(_resource, _region) {},
    set_buffer_transform(_resource, _transform) {},
    set_buffer_scale(_resource, _scale) {},
    offset(_resource, _x, _y) {},
    commit(resource) {
      const s = rec(resource);
      if (!s) return;

      // Promote pending buffer into the commit set (undefined = unchanged).
      if (s.pending.buffer !== undefined) {
        s.committed.buffer = s.pending.buffer;
        s.pending.buffer = undefined;
      }

      if (effectiveSync(ctx, s)) {
        // Synchronized subsurface: CACHE this commit; do not apply. The cache is
        // applied when the parent commits (via applySurfaceState's cascade).
        s.cached ??= {};
        s.cached.buffer = s.committed.buffer;
        if (s.pending.frameCallbacks?.length) {
          (s.cached.frameCallbacks ??= []).push(...s.pending.frameCallbacks);
          s.pending.frameCallbacks = undefined;
        }
      } else {
        // Desynchronized (incl. main surface): apply now. If a cache exists (e.g.
        // it was sync then switched to desync), it is flushed as part of apply.
        if (s.cached) {
          s.committed.buffer = s.cached.buffer ?? s.committed.buffer;
          if (s.cached.frameCallbacks?.length) {
            (s.pending.frameCallbacks ??= []).push(...s.cached.frameCallbacks);
          }
          s.cached = undefined;
        }
        applySurfaceState(ctx, s);
      }

      if (s.xdgSurface) s.xdgSurface.lastCommitSerial = ctx.state.nextSerial - 1;
    },
    destroy(resource) {
      const s = rec(resource);
      if (s) {
        ctx.state.wm?.unmapWindow(s.id);
        ctx.state.compositor.removeSurface(s.id);
        ctx.state.surfacesById?.delete(s.id);
      }
      ctx.state.surfaces.delete(resource);
    },
  };
}
