// zwp_linux_dmabuf_v1: advertises supported (format, modifier) pairs on bind and
// hands out zwp_linux_buffer_params_v1 objects for clients to assemble a dmabuf
// buffer. First light advertises ARGB8888/XRGB8888 with LINEAR and INVALID
// modifiers; the actual import (GPU process) will reject anything the driver
// can't handle, surfacing as buffer_params.failed.

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// DRM fourcc codes (little-endian char order). ARGB8888/XRGB8888 are the
// shm-format names too; the numeric fourcc is what linux-dmabuf carries.
function fourcc(a: string, b: string, c: string, d: string): number {
  return (
    a.charCodeAt(0) |
    (b.charCodeAt(0) << 8) |
    (c.charCodeAt(0) << 16) |
    (d.charCodeAt(0) << 24)
  );
}
export const DRM_FORMAT_ARGB8888 = fourcc("A", "R", "2", "4");
export const DRM_FORMAT_XRGB8888 = fourcc("X", "R", "2", "4");
const DRM_FORMAT_MOD_LINEAR = 0n;
const DRM_FORMAT_MOD_INVALID = 0xffffffffffffffffn;

const ADVERTISED = [DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888];
const MODIFIERS = [DRM_FORMAT_MOD_LINEAR, DRM_FORMAT_MOD_INVALID];

export default function makeLinuxDmabuf(ctx: Ctx) {
  return {
    bind(resource: Resource) {
      // v3+ clients use modifier events; older ones use format events. We send
      // both so either path sees our formats.
      for (const fmt of ADVERTISED) {
        ctx.events.zwp_linux_dmabuf_v1.send_format(resource, fmt);
        for (const mod of MODIFIERS) {
          const hi = Number((mod >> 32n) & 0xffffffffn);
          const lo = Number(mod & 0xffffffffn);
          ctx.events.zwp_linux_dmabuf_v1.send_modifier(resource, fmt, hi, lo);
        }
      }
    },
    create_params(_resource: Resource, params: Resource) {
      // The params object accumulates planes; track its state.
      ctx.state.dmabufParams ??= new Map();
      ctx.state.dmabufParams.set(params, { planes: [], used: false });
    },
    get_default_feedback(_resource: Resource, _feedback: Resource) {
      // Feedback not implemented (v4+); clients fall back to format/modifier.
    },
    get_surface_feedback(_resource: Resource, _feedback: Resource, _surface: Resource) {},
  };
}
