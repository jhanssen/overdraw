// wl_buffer: a view into a pool. The only request is destroy; release is an
// event the compositor sends once it no longer needs the buffer's contents
// (after upload, for shm). Descriptor lives in ctx.state.buffers.

import type { WlBufferHandler } from "#protocols-gen/wl_buffer.js";
import type { Ctx } from "./ctx.js";

export default function makeBuffer(ctx: Ctx): WlBufferHandler {
  return {
    destroy(resource) {
      const desc = ctx.state.buffers?.get(resource);
      // Release this buffer's hold on its shm pool mapping (may free a pool that
      // was already wl_shm_pool.destroy'd).
      if (desc?.poolId) ctx.addon.shmBufferUnref(desc.poolId);
      // dmabuf buffers hold a WaylandFd (the client's plane-0 fd, kept open across
      // re-commits so the buffer can be re-imported without the client re-sending
      // it). Each commit peeks a dup, so closing here does not affect any in-flight
      // import; without it the wrapper is GC'd with its fd still open ("[wlfd]
      // WARNING: garbage-collected while still open") -- a per-buffer fd leak as a
      // client (e.g. kitty) cycles dmabufs.
      if (desc?.fd && !desc.fd.closed) {
        try { desc.fd.close(); } catch { /* already closed/taken */ }
      }
      // Drive the client-buffer lifecycle's cache invalidation (rule A: this is
      // the canonical path that releases a cached GPU import). Looks up the
      // stable bufferId assigned in wl_surface.ts (bufferIdOf). If the buffer
      // was never committed -- no bufferId, no import -- nothing to do.
      if (desc?.dmabuf) {
        const bufferId = ctx.state.dmabufBufferIds?.get(resource);
        if (bufferId !== undefined) {
          ctx.state.compositor.notifyBufferDestroyed?.(bufferId);
          ctx.state.dmabufBufferIds?.delete(resource);
          ctx.state.dmabufById?.delete(bufferId);
        }
      }
      ctx.state.buffers?.delete(resource);
    },
  };
}
