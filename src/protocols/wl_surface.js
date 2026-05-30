// wl_surface: per-surface double-buffered state. On commit, if an shm buffer is
// attached, upload its pixels to the surface's GPU texture via the compositor
// bridge, then release the buffer (shm bytes are copied at upload time, so the
// client may reuse the buffer immediately).

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
      if (s.pending.buffer !== undefined) {
        s.committed.buffer = s.pending.buffer;
        s.pending.buffer = undefined;
      }

      const buffer = s.committed.buffer;
      if (buffer && !buffer.destroyed) {
        const desc = ctx.state.buffers?.get(buffer);
        let uploaded = false;
        if (desc && desc.dmabuf) {
          // dmabuf: hand the client's fd to native for zero-copy import. The
          // buffer is NOT released immediately -- the compositor samples it
          // directly, so it stays in use until the surface is replaced.
          const ok = ctx.addon.commitSurfaceDmabuf(
            s.id, desc.fdHandle, desc.width, desc.height, desc.format,
            desc.modifierHi, desc.modifierLo, desc.offset, desc.stride);
          if (ok) { ctx.state.lastCommittedSurfaceId = s.id; uploaded = true; }
        } else if (desc && desc.poolId) {
          const ok = ctx.addon.commitSurfaceBuffer(
            s.id, desc.poolId, desc.offset, desc.width, desc.height, desc.stride);
          if (ok) {
            ctx.state.lastCommittedSurfaceId = s.id;
            uploaded = true;
            // shm: contents are copied at upload, so the buffer is free to reuse.
            ctx.events.wl_buffer.send_release(buffer);
          }
        }

        // First buffered commit on a toplevel == map. Hand it to the WM to be
        // placed + stacked so it actually draws. Guard so it fires once.
        if (uploaded && !s.mapped && s.role === 'xdg_toplevel') {
          s.mapped = true;
          ctx.state.wm?.mapWindow(s.id, s);
        }
      }

      if (s.xdgSurface) s.xdgSurface.lastCommitSerial = ctx.state.nextSerial - 1;
    },
    destroy(resource) {
      const s = rec(resource);
      if (s) {
        ctx.state.wm?.unmapWindow(s.id);
        if (ctx.addon.removeSurface) ctx.addon.removeSurface(s.id);
      }
      ctx.state.surfaces.delete(resource);
    },
  };
}
