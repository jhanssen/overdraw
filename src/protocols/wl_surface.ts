// wl_surface: per-surface double-buffered state. On commit, if an shm buffer is
// attached, upload its pixels to the surface's GPU texture via the compositor
// bridge, then release the buffer (shm bytes are copied at upload time, so the
// client may reuse the buffer immediately).

import type { WlSurfaceHandler } from "#protocols-gen/wl_surface.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

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
      (s.frameCallbacks ??= []).push(callback);
    },
    set_opaque_region(_resource, _region) {},
    set_input_region(_resource, _region) {},
    set_buffer_transform(_resource, _transform) {},
    set_buffer_scale(_resource, _scale) {},
    offset(_resource, _x, _y) {},
    commit(resource) {
      const s = rec(resource);
      if (!s) return;
      if (s.pending.buffer !== undefined) {
        s.committed.buffer = s.pending.buffer;
        s.pending.buffer = undefined;
      }

      const buffer = s.committed.buffer;
      if (buffer && !buffer.destroyed) {
        const desc = ctx.state.buffers?.get(buffer);
        if (desc && desc.dmabuf && desc.fd) {
          // dmabuf: hand the client's fd (WaylandFd) to native for zero-copy
          // import. The compositor samples this buffer DIRECTLY (no copy), so it
          // must stay held until the compositor's GPU read completes. Native
          // tracks this per bufferId and reports completion via takeFreedBuffers
          // (driven by queue OnSubmittedWorkDone); we send wl_buffer.release
          // then. Releasing earlier would let the client overwrite a buffer the
          // GPU is still reading; never releasing starves a Vulkan-WSI client in
          // vkAcquireNextImageKHR.
          //
          // The import is ASYNCHRONOUS (commitSurfaceDmabuf returns once the
          // request is sent, not once the texture is injected). Map-on-first-
          // content therefore cannot be inferred here; it is driven by the
          // imported-surface sweep in dispatchFrameCallbacks (see index.ts),
          // which is shared with shm.
          const bufferId = bufferIdOf(ctx, buffer);
          const ok = ctx.addon.commitSurfaceDmabuf(
            s.id, desc.fd, desc.width, desc.height, desc.format,
            desc.modifierHi ?? 0, desc.modifierLo ?? 0, desc.offset, desc.stride, bufferId);
          if (ok) ctx.state.lastCommittedSurfaceId = s.id;
        } else if (desc && desc.poolId) {
          const ok = ctx.addon.commitSurfaceBuffer(
            s.id, desc.poolId, desc.offset, desc.width, desc.height, desc.stride);
          if (ok) {
            ctx.state.lastCommittedSurfaceId = s.id;
            // shm: contents are copied at upload, so the buffer is free to reuse.
            ctx.events.wl_buffer.send_release(buffer);
          }
        }
        // Mapping (first presentable content -> WM place + focus) happens for
        // both paths in the imported-surface sweep, not here.
      }

      if (s.xdgSurface) s.xdgSurface.lastCommitSerial = ctx.state.nextSerial - 1;
    },
    destroy(resource) {
      const s = rec(resource);
      if (s) {
        ctx.state.wm?.unmapWindow(s.id);
        ctx.addon.removeSurface(s.id);
        ctx.state.surfacesById?.delete(s.id);
      }
      ctx.state.surfaces.delete(resource);
    },
  };
}
