// wl_shm: advertises supported buffer formats on bind and creates pools from a
// client fd. The fd arrives as an opaque trampoline handle; shmCreatePool takes
// ownership (mmaps it natively) and returns a pool id we stash on the pool
// resource. Only ARGB8888 (0) and XRGB8888 (1) are advertised — both map to a
// BGRA8Unorm upload texture with a straight memcpy on little-endian.

import { signature as shmSig } from "#protocols-gen/wl_shm.js";
import type { WlShmHandler } from "#protocols-gen/wl_shm.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

const FORMAT = shmSig.enums.format.entries; // { argb8888:0, xrgb8888:1, ... }

// `bind` is a synthetic on-bind hook, not a protocol request.
type ShmHandler = WlShmHandler & { bind(resource: Resource): void };

export default function makeShm(ctx: Ctx): ShmHandler {
  return {
    bind(resource) {
      // Advertise formats immediately so clients see them on their first
      // roundtrip after binding.
      ctx.events.wl_shm.send_format(resource, FORMAT.argb8888);
      ctx.events.wl_shm.send_format(resource, FORMAT.xrgb8888);
    },
    create_pool(_resource, pool, fd, size) {
      // fd is a WaylandFd; shmCreatePool takes the raw fd out of it natively.
      const poolId = ctx.addon.shmCreatePool(fd, size);
      ctx.state.pools ??= new Map();
      ctx.state.pools.set(pool, { poolId, size });
    },
    release(_resource) {},
  };
}
