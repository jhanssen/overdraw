// wl_buffer: a view into a pool. The only request is destroy; release is an
// event the compositor sends once it no longer needs the buffer's contents
// (after upload, for shm). Descriptor lives in ctx.state.buffers.

export default function makeBuffer(ctx) {
  return {
    destroy(resource) {
      ctx.state.buffers?.delete(resource);
    },
  };
}
