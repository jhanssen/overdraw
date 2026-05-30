// wl_buffer: a view into a pool. The only request is destroy; release is an
// event the compositor sends once it no longer needs the buffer's contents
// (after upload, for shm). Descriptor lives in ctx.state.buffers.

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeBuffer(ctx: Ctx) {
  return {
    destroy(resource: Resource) {
      ctx.state.buffers?.delete(resource);
    },
  };
}
