// wl_shm_pool: carves wl_buffers out of a pool as (offset, w, h, stride, format)
// views and supports resize/destroy. Buffer descriptors are recorded against the
// buffer resource for use at wl_surface.commit.

import type { WlShmPoolHandler } from "#protocols-gen/wl_shm_pool.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeShmPool(ctx: Ctx): WlShmPoolHandler {
  const poolRec = (resource: Resource) => ctx.state.pools?.get(resource);

  return {
    create_buffer(resource, buffer, offset, width, height, stride, format) {
      const pool = poolRec(resource);
      ctx.state.buffers ??= new Map();
      ctx.state.buffers.set(buffer, {
        resource: buffer,
        poolResource: resource,
        poolId: pool ? pool.poolId : 0,
        offset, width, height, stride, format,
      });
    },
    resize(resource, size) {
      const pool = poolRec(resource);
      if (!pool) return;
      ctx.addon.shmResizePool(pool.poolId, size);
      pool.size = size;
    },
    destroy(resource) {
      const pool = poolRec(resource);
      if (pool) ctx.addon.shmDestroyPool(pool.poolId);
      ctx.state.pools?.delete(resource);
    },
  };
}
