// zwp_linux_buffer_params_v1: accumulates dmabuf planes (add) then produces a
// wl_buffer (create / create_immed). The fd from `add` arrives as an opaque
// trampoline handle; we stash it in the buffer descriptor for the commit path
// to hand to the native import. Single plane supported.

import type { ZwpLinuxBufferParamsV1Handler } from "#protocols-gen/zwp_linux_buffer_params_v1.js";
import type { Ctx, DmabufParams, BufferDesc } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeBufferParams(ctx: Ctx): ZwpLinuxBufferParamsV1Handler {
  const rec = (resource: Resource): DmabufParams | undefined =>
    ctx.state.dmabufParams?.get(resource);

  // Build the dmabuf buffer descriptor shared by create / create_immed.
  function makeDescriptor(
    params: DmabufParams, buffer: Resource, width: number, height: number, format: number,
  ): BufferDesc {
    const plane0 = params.planes[0];
    return {
      resource: buffer,
      dmabuf: true,
      fd: plane0?.fd,
      offset: plane0?.offset ?? 0,
      stride: plane0?.stride ?? 0,
      modifierHi: plane0?.modifierHi ?? 0,
      modifierLo: plane0?.modifierLo ?? 0,
      width, height, format,
    };
  }

  return {
    add(resource, fd, planeIdx, offset, stride, modifierHi, modifierLo) {
      const p = rec(resource);
      if (!p) return;
      p.planes[planeIdx] = { fd, offset, stride, modifierHi, modifierLo };
    },
    create(resource, _width, _height, _format, _flags) {
      const p = rec(resource);
      if (!p || p.used || !p.planes[0]) {
        // Can't recover a usable buffer; report failure.
        ctx.events.zwp_linux_buffer_params_v1.send_failed(resource);
        return;
      }
      p.used = true;
      // `create` (async) must hand back a server-created wl_buffer via the
      // `created` event. The trampoline has no API to mint a new resource
      // server-side for an event new_id arg, so first light only supports
      // create_immed (client supplies the buffer id). Report failed here.
      ctx.events.zwp_linux_buffer_params_v1.send_failed(resource);
    },
    create_immed(resource, buffer, width, height, format, _flags) {
      const p = rec(resource);
      if (!p || p.used || !p.planes[0]) return;
      p.used = true;
      ctx.state.buffers ??= new Map();
      ctx.state.buffers.set(buffer, makeDescriptor(p, buffer, width, height, format));
    },
    destroy(resource) {
      ctx.state.dmabufParams?.delete(resource);
    },
  };
}
