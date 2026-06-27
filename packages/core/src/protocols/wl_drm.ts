// wl_drm (Mesa's legacy wayland-drm): reports the DRM render node, supported
// formats, and PRIME capability so a client can set up its own GPU import.
// NVIDIA's libnvidia-egl-wayland binds this during EGL init to discover the
// device; without it that library dereferences a null device pointer and the
// client crashes on startup. Buffers are PRIME (dmabuf) only: create_prime_buffer
// mints a wl_buffer through the dmabuf import path; GEM-name buffers can't be
// served off a render node and are rejected per protocol.

import type { WlDrmHandler } from "#protocols-gen/wl_drm.js";
import { WlDrm_Error, WlDrm_Capability } from "#protocols-gen/wl_drm.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import { DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888 } from "./zwp_linux_dmabuf_v1.js";

// `bind` is a synthetic on-bind hook (trampoline calls it), not a request.
type Handler = WlDrmHandler & { bind(resource: Resource): void };

// PRIME buffers carry no explicit modifier; the import resolves the layout
// implicitly. DRM_FORMAT_MOD_INVALID split into the BufferDesc's 32-bit halves.
const MOD_INVALID_HI = 0xffffffff;
const MOD_INVALID_LO = 0xffffffff;

// The formats we can actually import, matching the zwp_linux_dmabuf advertisement.
const FORMATS = [DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888];

export default function makeWlDrm(ctx: Ctx): Handler {
  return {
    bind(resource) {
      ctx.events.wl_drm.send_device(resource, ctx.addon.gpuRenderNode());
      for (const fmt of FORMATS) ctx.events.wl_drm.send_format(resource, fmt);
      // capabilities is a v2 event; older binds drive the authenticate path.
      if (resource.version >= 2) {
        ctx.events.wl_drm.send_capabilities(resource, WlDrm_Capability.prime);
      }
    },

    authenticate(resource, _id) {
      // Render nodes require no DRM magic authentication; confirm at once.
      ctx.events.wl_drm.send_authenticated(resource);
    },

    create_buffer(resource, _id, _name, _width, _height, _stride, _format) {
      // GEM flink names are served off the primary node, which we don't drive;
      // PRIME is the only path. Per protocol this is a fatal invalid_name.
      ctx.addon.postError(resource, WlDrm_Error.invalid_name,
        "wl_drm.create_buffer: GEM-name buffers unsupported; use PRIME");
    },

    create_planar_buffer(resource, _id, _name, _width, _height, _format,
                         _o0, _s0, _o1, _s1, _o2, _s2) {
      ctx.addon.postError(resource, WlDrm_Error.invalid_name,
        "wl_drm.create_planar_buffer: GEM-name buffers unsupported; use PRIME");
    },

    create_prime_buffer(_resource, buffer, name, width, height, format,
                        offset0, stride0, _o1, _s1, _o2, _s2) {
      // Single-plane dmabuf; same descriptor zwp_linux_buffer_params.create_immed
      // builds, so the commit path imports it identically.
      ctx.state.buffers ??= new Map();
      ctx.state.buffers.set(buffer, {
        resource: buffer,
        dmabuf: true,
        fd: name,
        offset: offset0,
        stride: stride0,
        modifierHi: MOD_INVALID_HI,
        modifierLo: MOD_INVALID_LO,
        width, height, format,
      });
    },
  };
}
