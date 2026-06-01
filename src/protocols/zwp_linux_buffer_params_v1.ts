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
    create(resource, width, height, format, _flags) {
      const p = rec(resource);
      if (!p || p.used || !p.planes[0]) {
        // Can't recover a usable buffer; report failure.
        ctx.events.zwp_linux_buffer_params_v1.send_failed(resource);
        return;
      }
      p.used = true;
      // `create` (async) hands back a server-minted wl_buffer via the `created`
      // event. Passing null in the new_id slot tells the trampoline to mint the
      // resource server-side and return its wrapper (same path as
      // wl_data_device.data_offer). Record the descriptor against the minted
      // buffer so the commit path imports it exactly like create_immed.
      const buffer = ctx.events.zwp_linux_buffer_params_v1.send_created(
        resource, null,
      ) as Resource | undefined;
      if (!buffer) {
        // Minting failed (no-memory / unregistered interface); report failure.
        ctx.events.zwp_linux_buffer_params_v1.send_failed(resource);
        return;
      }
      ctx.state.buffers ??= new Map();
      ctx.state.buffers.set(buffer, makeDescriptor(p, buffer, width, height, format));
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
