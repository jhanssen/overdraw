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
import type { Ctx, CompositorState, SurfaceRecord, SubsurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import { applySubsurfaces, applySubsurfaceReorder } from "../subsurfaces.js";
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

// Snapshot a pending region resource into an applied Region (or null for
// "infinite"). Called on commit for input/opaque region application.
// Per spec: copy semantics -- the client may destroy the wl_region
// resource immediately after the commit; the applied region keeps the
// rect list it had at commit time.
function snapshotRegion(
  ctx: Ctx,
  pending: Resource | null | undefined,
): import("./region.js").Region | null | undefined {
  if (pending === undefined) return undefined;   // no set_*_region this cycle
  if (pending === null) return null;             // explicit null = infinite
  const r = ctx.state.regions?.get(pending);
  return r ? r.clone() : null;                   // missing/destroyed -> infinite
}

// Apply a surface's committed state (buffer + frame callbacks + subsurface-
// managed state of its children), then CASCADE into every effective-sync child:
// the child's cached state is applied atomically with this (parent) apply. This
// is the spec's "cached state applied immediately after the parent's state".
function applySurfaceState(ctx: Ctx, s: SurfaceRecord): void {
  uploadBuffer(ctx, s, s.committed.buffer);
  ctx.state.compositor.setSurfaceBufferScale?.(s.id, s.committed.bufferScale ?? 1);
  ctx.state.compositor.setSurfaceBufferTransform?.(s.id, s.committed.bufferTransform ?? 0);

  // Promote this surface's pending frame callbacks to "armed" (fired by the
  // per-frame dispatch). Double-buffered: they arm on apply, not on request.
  if (s.pending.frameCallbacks?.length) {
    (s.frameCallbacks ??= []).push(...s.pending.frameCallbacks);
    s.pending.frameCallbacks = undefined;
  }

  // Apply input/opaque regions. undefined = no set_*_region call this
  // cycle, leave applied region alone.
  if (s.pending.inputRegion !== undefined) {
    s.inputRegion = snapshotRegion(ctx, s.pending.inputRegion);
    s.pending.inputRegion = undefined;
  }
  if (s.pending.opaqueRegion !== undefined) {
    s.opaqueRegion = snapshotRegion(ctx, s.pending.opaqueRegion);
    s.pending.opaqueRegion = undefined;
  }

  // Apply wp_viewport state. undefined = unchanged; push to the compositor
  // only when src or dst changed this cycle.
  let viewportChanged = false;
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

  // Subsurface-managed state (position + sibling reorder) of THIS
  // surface's children is applied on THIS surface's commit, regardless
  // of child mode (spec).
  applySubsurfaceReorder(ctx.state, s.resource);
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
        if (childRec.cached.bufferScale !== undefined) {
          childRec.committed.bufferScale = childRec.cached.bufferScale;
        }
        if (childRec.cached.bufferTransform !== undefined) {
          childRec.committed.bufferTransform = childRec.cached.bufferTransform;
        }
        if (childRec.cached.frameCallbacks?.length) {
          (childRec.pending.frameCallbacks ??= []).push(...childRec.cached.frameCallbacks);
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
    set_opaque_region(resource, region) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered: store the region resource (or null = infinite);
      // commit() snapshots its rect list.
      s.pending.opaqueRegion = region;
    },
    set_input_region(resource, region) {
      const s = rec(resource);
      if (!s) return;
      s.pending.inputRegion = region;
    },
    set_buffer_transform(resource, transform) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered; applied on commit. Out-of-range is a protocol error
      // (wl_surface.invalid_transform, v6); silent-drop per convention. Values
      // are the wl_output.transform enum (0=normal,1=90,2=180,3=270, 4..7 the
      // mirrored variants).
      if (!Number.isInteger(transform) || transform < 0 || transform > 7) return;
      s.pending.bufferTransform = transform;
    },
    set_buffer_scale(resource, scale) {
      const s = rec(resource);
      if (!s) return;
      // Double-buffered; applied on commit. A non-positive or non-integer
      // scale is a protocol error (wl_surface.invalid_scale, v6); silent-drop
      // per this compositor's convention (no post_error path).
      if (!Number.isInteger(scale) || scale < 1) return;
      s.pending.bufferScale = scale;
    },
    offset(_resource, _x, _y) {},
    commit(resource) {
      const s = rec(resource);
      if (!s) return;

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

      // Layer-shell: a buffer attached before the first configure-ack is
      // invalid_surface_state per spec. Silent-drop convention (no
      // post_error path in this compositor today; see top of
      // zwlr_layer_shell_v1.ts); discard the buffer so it never reaches
      // the GPU.
      if (s.layerSurface && isLayerSurfaceInitialCommit(s.layerSurface) && s.committed.buffer) {
        s.committed.buffer = null;
      }

      if (effectiveSync(ctx, s)) {
        // Synchronized subsurface: CACHE this commit; do not apply. The cache is
        // applied when the parent commits (via applySurfaceState's cascade).
        s.cached ??= {};
        s.cached.buffer = s.committed.buffer;
        if (s.committed.bufferScale !== undefined) s.cached.bufferScale = s.committed.bufferScale;
        if (s.committed.bufferTransform !== undefined) s.cached.bufferTransform = s.committed.bufferTransform;
        if (s.pending.frameCallbacks?.length) {
          (s.cached.frameCallbacks ??= []).push(...s.pending.frameCallbacks);
          s.pending.frameCallbacks = undefined;
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
      } else {
        // Desynchronized (incl. main surface): apply now. If a cache exists (e.g.
        // it was sync then switched to desync), it is flushed as part of apply.
        if (s.cached) {
          s.committed.buffer = s.cached.buffer ?? s.committed.buffer;
          if (s.cached.bufferScale !== undefined) s.committed.bufferScale = s.cached.bufferScale;
          if (s.cached.bufferTransform !== undefined) s.committed.bufferTransform = s.cached.bufferTransform;
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
          s.cached = undefined;
        }
        applySurfaceState(ctx, s);
      }

      if (s.xdgSurface) s.xdgSurface.lastCommitSerial = ctx.state.nextSerial - 1;

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
        void ctx.state.wm?.markInitialCommitComplete(s.id, { appId, title });
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

// Run a surface's window-unmap teardown: emit window.unmap (mapped toplevels only,
// mirroring window.map), drop pending coalesced changes, unmap in the WM, and
// remove it from the compositor + id map. IDEMPOTENT via the `unmapped` guard, so
// it is safe to call from BOTH the explicit wl_surface.destroy request AND the
// resource-destroyed sweep (client disconnect): whichever runs first does the work;
// the second is a no-op. Without the sweep path, a client that disconnects without
// explicitly destroying its wl_surface would never emit window.unmap, leaking any
// decoration ring bound to that window (the provider frees it on sdk.windows.onUnmap).
export function unmapAndTeardownSurface(state: CompositorState, s: SurfaceRecord): void {
  if (s.unmapped) return;
  s.unmapped = true;
  // Phase 9a: BEFORE the WM/compositor teardown, give the closing
  // driver a chance to capture a phantom. The driver is a no-op when
  // no plugin claims the 'window-closing' namespace, so when nothing
  // is registered we proceed straight to instant unmap (the original
  // pre-9a behavior). When the driver DOES capture, it emits
  // window.closing on the bus + arms a backstop; the phantom lives
  // in the compositor independently until the plugin (or the
  // backstop) destroys it.
  state.closingDriver?.beforeUnmap(state, s);
  if (s.mapped && (s.role === "xdg_toplevel" || s.role === "layer_surface")) {
    state.bus?.emit(WINDOW_EVENT.unmap, { surfaceId: s.id });
  }
  state.pendingWindowChanges?.delete(s.id);
  // Layer-shell teardown: clear reservations + drop from the layer stack.
  // Idempotent so the explicit zwlr_layer_surface_v1.destroy AND this
  // wl_surface sweep can each run safely.
  if (s.layerSurface) {
    teardownLayerSurface(state, s.layerSurface);
    s.layerSurface = null;
  }
  state.wm?.unmapWindow(s.id);
  state.compositor.removeSurface(s.id);
  state.surfacesById?.delete(s.id);
}
