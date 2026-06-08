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
      sendFeedback(ctx, feedback);
    },
    get_surface_feedback(_resource, feedback, _surface) {
      // Per-surface feedback is the same as default for now (no per-surface
      // optimization tranche).
      sendFeedback(ctx, feedback);
    },
    destroy(_resource) {},
  };
}

// dmabuf default-feedback. Sends the full spec sequence when the GPU process has
// supplied feedback data (format_table memfd + main_device dev_t + the usable
// (format, modifier) set), which a Vulkan-WSI client requires to derive swapchain
// formats. The event order follows the protocol: format_table, main_device, then
// one tranche (target_device, formats, tranche_done), then done.
//
// Fallback: if no native feedback data is available (e.g. probe produced nothing,
// or running without the GPU process), send only `done`. The feedback resource
// still has a real implementation so libwayland does not abort; clients without
// feedback fall back to the v3 format/modifier events advertised on bind.
function sendFeedback(ctx: Ctx, feedback: Resource): void {
  const ev = ctx.events.zwp_linux_dmabuf_feedback_v1;
  const fb = ctx.addon.dmabufFeedbackInfo();
  if (!fb || fb.entryCount === 0) {
    ev.send_done(feedback);
    return;
  }
  // format_table: fd ('h') + size. The WaylandFd ownership transfers into the
  // wire on post; each call gets its own dup from dmabufFeedbackInfo().
  ev.send_format_table(feedback, fb.formatTableFd, fb.formatTableSize);
  // main_device: dev_t bytes (single tranche targets the same device).
  ev.send_main_device(feedback, fb.mainDevice);
  // One tranche targeting the same device. Event order per protocol:
  // target_device, flags, formats, tranche_done.
  ev.send_tranche_target_device(feedback, fb.mainDevice);
  ev.send_tranche_flags(feedback, 0);
  // tranche_formats: u16 indices into the format_table (all of them).
  ev.send_tranche_formats(feedback, fb.trancheFormats);
  ev.send_tranche_done(feedback);
  ev.send_done(feedback);
}

// Handler for the zwp_linux_dmabuf_feedback_v1 child resource (only `destroy`).
export function makeDmabufFeedback(): ZwpLinuxDmabufFeedbackV1Handler {
  return {
    destroy(_resource) {},
  };
}
