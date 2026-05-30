// wl_surface: per-surface double-buffered state. For first light we track the
// pending/committed buffer and the frame-callback queue; we do not yet sample or
// composite a client buffer (no buffer import path here).

export default function makeSurface(ctx) {
  const rec = (resource) => ctx.state.surfaces.get(resource);

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
      (s.frameCallbacks ||= []).push(callback);
    },
    set_opaque_region(_resource, _region) {},
    set_input_region(_resource, _region) {},
    set_buffer_transform(_resource, _transform) {},
    set_buffer_scale(_resource, _scale) {},
    offset(_resource, _x, _y) {},
    commit(resource) {
      const s = rec(resource);
      if (!s) return;
      // Apply pending -> committed (only buffer tracked so far).
      if (s.pending.buffer !== undefined) {
        s.committed.buffer = s.pending.buffer;
        s.pending.buffer = undefined;
      }
      // An xdg_surface's first commit (with a role) completes its mapping; the
      // role object drives the configure handshake, so nothing more here yet.
      if (s.xdgSurface) s.xdgSurface.lastCommitSerial = ctx.state.nextSerial - 1;
    },
    destroy(resource) {
      ctx.state.surfaces.delete(resource);
    },
  };
}
