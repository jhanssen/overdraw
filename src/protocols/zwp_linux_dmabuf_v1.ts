// zwp_linux_dmabuf_v1: advertises supported (format, modifier) pairs on bind and
// hands out zwp_linux_buffer_params_v1 objects for clients to assemble a dmabuf
// buffer. First light advertises ARGB8888/XRGB8888 with LINEAR and INVALID
// modifiers; the actual import (GPU process) will reject anything the driver
// can't handle, surfacing as buffer_params.failed.

import type { ZwpLinuxDmabufV1Handler } from "#protocols-gen/zwp_linux_dmabuf_v1.js";
import type { ZwpLinuxDmabufFeedbackV1Handler } from "#protocols-gen/zwp_linux_dmabuf_feedback_v1.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// `bind` is a synthetic on-bind hook, not a protocol request.
type DmabufHandler = ZwpLinuxDmabufV1Handler & { bind(resource: Resource): void };

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

export default function makeLinuxDmabuf(ctx: Ctx): DmabufHandler {
  return {
    bind(resource) {
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
    create_params(_resource, params) {
      // The params object accumulates planes; track its state.
      ctx.state.dmabufParams ??= new Map();
      ctx.state.dmabufParams.set(params, { planes: [], used: false });
    },
    get_default_feedback(_resource, feedback) {
      sendMinimalFeedback(ctx, feedback);
    },
    get_surface_feedback(_resource, feedback, _surface) {
      sendMinimalFeedback(ctx, feedback);
    },
    destroy(_resource) {},
  };
}

// Minimal dmabuf feedback: send `done` with no format table or tranches. This
// is the "no special per-surface feedback" case -- clients fall back to the v3
// format/modifier events advertised on bind. Crucially it gives the feedback
// child resource a real (non-NULL) implementation so libwayland does not abort
// when the client interacts with it.
//
// NOTE: a fully-spec feedback would send format_table (an fd to a
// {format,modifier} table) + main_device + tranche_* + done. That needs native
// support (the DRM device dev_t + the importable format/modifier set as a binary
// table) and is not built; this minimal form is protocol-legal but may not
// satisfy a Vulkan-WSI client that requires the format table.
function sendMinimalFeedback(ctx: Ctx, feedback: Resource): void {
  ctx.events.zwp_linux_dmabuf_feedback_v1.send_done(feedback);
}

// Handler for the zwp_linux_dmabuf_feedback_v1 child resource (only `destroy`).
export function makeDmabufFeedback(): ZwpLinuxDmabufFeedbackV1Handler {
  return {
    destroy(_resource) {},
  };
}
