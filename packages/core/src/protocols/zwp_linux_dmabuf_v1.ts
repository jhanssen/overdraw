// zwp_linux_dmabuf_v1: advertises supported (format, modifier) pairs on bind and
// hands out zwp_linux_buffer_params_v1 objects for clients to assemble a dmabuf
// buffer. First light advertises ARGB8888/XRGB8888 with LINEAR and INVALID
// modifiers; the actual import (GPU process) will reject anything the driver
// can't handle, surfacing as buffer_params.failed.

import type { ZwpLinuxDmabufV1Handler } from "#protocols-gen/zwp_linux_dmabuf_v1.js";
import type { ZwpLinuxDmabufFeedbackV1Handler } from "#protocols-gen/zwp_linux_dmabuf_feedback_v1.js";
import type { Ctx, CompositorState } from "./ctx.js";
import type { Resource, Addon } from "../types.js";

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
      // format (v1) and modifier (v3) are both deprecated since v4 and must not
      // be sent to a v4+ binding -- those clients read formats from
      // get_default_feedback. Sending a modifier event on a v4 binding crashes
      // NVIDIA's libnvidia-egl-wayland (null deref). Only the legacy path gets
      // these: format for v1+, modifier (a since-3 event) for v3 only.
      if (resource.version >= 4) return;
      for (const fmt of ADVERTISED) {
        ctx.events.zwp_linux_dmabuf_v1.send_format(resource, fmt);
        if (resource.version >= 3) {
          for (const mod of MODIFIERS) {
            const hi = Number((mod >> 32n) & 0xffffffffn);
            const lo = Number(mod & 0xffffffffn);
            ctx.events.zwp_linux_dmabuf_v1.send_modifier(resource, fmt, hi, lo);
          }
        }
      }
    },
    create_params(_resource, params) {
      // The params object accumulates planes; track its state.
      ctx.state.dmabufParams ??= new Map();
      ctx.state.dmabufParams.set(params, { planes: [], used: false });
    },
    get_default_feedback(_resource, feedback) {
      sendFeedback(ctx, feedback, null);
    },
    get_surface_feedback(_resource, feedback, surface) {
      // Per-surface feedback: tracked so it can be RE-SENT when the
      // surface's fullscreen state changes -- a fullscreen surface's
      // feedback leads with a scanout tranche (the primary plane's
      // format subset), steering the client toward buffers the direct-
      // scanout path can put on the plane. Same stored-resource pattern
      // as wp_fractional_scale.
      const surfaceId = surfaceIdOf(ctx.state, surface);
      const outputId = surfaceId !== null ? scanoutOutputFor(ctx.state, surfaceId) : null;
      const indices = outputId !== null ? scanoutIndicesFor(ctx.addon, outputId) : null;
      sendFeedback(ctx, feedback, indices);
      ctx.state.dmabufSurfaceFeedback ??= new Map();
      ctx.state.dmabufSurfaceFeedback.set(feedback, {
        surfaceId: surfaceId ?? 0,
        lastKey: feedbackKey(outputId, indices),
      });
    },
    destroy(_resource) {},
  };
}

// Resolve a wl_surface resource to its numeric surface id.
function surfaceIdOf(state: CompositorState, surface: Resource): number | null {
  const byId = state.surfacesById;
  if (!byId) return null;
  for (const [id, rec] of byId) {
    if (rec.resource === surface) return id;
  }
  return null;
}

// The output whose primary plane could scan this surface out: the surface
// is fullscreen there. null = not fullscreen anywhere.
function scanoutOutputFor(state: CompositorState, surfaceId: number): number | null {
  const ws = state.wm?.getWindowState(surfaceId);
  if (!ws || ws.exclusive !== "fullscreen") return null;
  const outs = state.compositor.surfaceOutputs?.(surfaceId);
  return outs && outs.length > 0 ? outs[0] : null;
}

function scanoutIndicesFor(addon: FeedbackAddon, outputId: number): number[] | null {
  const idx = addon.scanoutFormatIndices?.(outputId);
  return idx && idx.length > 0 ? idx : null;
}

function feedbackKey(outputId: number | null, indices: number[] | null): string {
  return indices ? `scanout:${outputId}` : "render";
}

// Re-send every tracked per-surface feedback whose scanout-tranche shape
// changed (the surface went fullscreen on a scanout-capable output, or
// stopped being). Wired to the WM's window.committed events; cheap when
// nothing changed (key comparison only).
export function reemitScanoutFeedback(state: CompositorState, addon: FeedbackAddon): void {
  const map = state.dmabufSurfaceFeedback;
  if (!map || map.size === 0 || !state.events) return;
  for (const [feedback, entry] of [...map]) {
    if (feedback.destroyed) {
      map.delete(feedback);
      continue;
    }
    const outputId = entry.surfaceId !== 0
      ? scanoutOutputFor(state, entry.surfaceId) : null;
    const indices = outputId !== null ? scanoutIndicesFor(addon, outputId) : null;
    const key = feedbackKey(outputId, indices);
    if (key === entry.lastKey) continue;
    entry.lastKey = key;
    sendFeedbackOn(state.events, addon, feedback, indices);
  }
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
function sendFeedback(ctx: Ctx, feedback: Resource,
                      scanoutIndices: number[] | null): void {
  sendFeedbackOn(ctx.events, ctx.addon, feedback, scanoutIndices);
}

// The addon slice the feedback path needs; reemitScanoutFeedback is called
// from main.ts with the full addon.
type FeedbackAddon = Pick<Addon, "dmabufFeedbackInfo" | "scanoutFormatIndices">;

function sendFeedbackOn(events: NonNullable<CompositorState["events"]>,
                        addon: FeedbackAddon, feedback: Resource,
                        scanoutIndices: number[] | null): void {
  const ev = events.zwp_linux_dmabuf_feedback_v1;
  const fb = addon.dmabufFeedbackInfo();
  if (!fb || fb.entryCount === 0) {
    ev.send_done(feedback);
    return;
  }
  // format_table: fd ('h') + size. The WaylandFd ownership transfers into the
  // wire on post; each call gets its own dup from dmabufFeedbackInfo().
  ev.send_format_table(feedback, fb.formatTableFd, fb.formatTableSize);
  // main_device: dev_t bytes (every tranche targets the same device).
  ev.send_main_device(feedback, fb.mainDevice);
  // Preference order = emission order: the scanout tranche (when the
  // surface is fullscreen on a scanout-capable output) leads so clients
  // allocate plane-compatible buffers; the render tranche follows as the
  // fallback. Both index into the same format_table.
  if (scanoutIndices) {
    const idx = new Uint16Array(scanoutIndices);
    ev.send_tranche_target_device(feedback, fb.mainDevice);
    ev.send_tranche_flags(feedback, 1);  // scanout
    ev.send_tranche_formats(feedback,
      new Uint8Array(idx.buffer, 0, idx.byteLength));
    ev.send_tranche_done(feedback);
  }
  // Render tranche. Event order per protocol: target_device, flags,
  // formats, tranche_done.
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
