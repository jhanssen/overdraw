// wl_shm_pool: carves wl_buffers out of a pool as (offset, w, h, stride, format)
// views and supports resize/destroy. Buffer descriptors are recorded against the
// buffer resource for use at wl_surface.commit.

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeShmPool(ctx: Ctx) {
  const poolRec = (resource: Resource) => ctx.state.pools?.get(resource);

  return {
    create_buffer(
      resource: Resource, buffer: Resource, offset: number, width: number,
      height: number, stride: number, format: number,
    ) {
      const pool = poolRec(resource);
      ctx.state.buffers ??= new Map();
      ctx.state.buffers.set(buffer, {
        resource: buffer,
        poolResource: resource,
        poolId: pool ? pool.poolId : 0,
        offset, width, height, stride, format,
      });
    },
    resize(resource: Resource, size: number) {
      const pool = poolRec(resource);
      if (!pool) return;
      ctx.addon.shmResizePool(pool.poolId, size);
      pool.size = size;
    },
    destroy(resource: Resource) {
      const pool = poolRec(resource);
      if (pool) ctx.addon.shmDestroyPool(pool.poolId);
      ctx.state.pools?.delete(resource);
    },
  };
}
