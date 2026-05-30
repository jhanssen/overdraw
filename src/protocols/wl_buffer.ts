// wl_buffer: a view into a pool. The only request is destroy; release is an
// event the compositor sends once it no longer needs the buffer's contents
// (after upload, for shm). Descriptor lives in ctx.state.buffers.

import type { WlBufferHandler } from "#protocols-gen/wl_buffer.js";
import type { Ctx } from "./ctx.js";

export default function makeBuffer(ctx: Ctx): WlBufferHandler {
  return {
    destroy(resource) {
      ctx.state.buffers?.delete(resource);
    },
  };
}
