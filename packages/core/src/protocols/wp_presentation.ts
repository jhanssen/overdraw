// wp_presentation: per-commit feedback carrying the actual scanout
// timestamp + refresh + vsync sequence + capability flags. Video players
// (mpv with --video-sync=display-vdrop, --display-fps=auto) and profilers
// align frame production to vblank using this.
//
// Shape (mirrors wl_surface.frame):
//   - feedback(surface, callback) queues a one-shot feedback resource on
//     the surface's pending state. Double-buffered: commit promotes it
//     into the surface's applied feedbacks alongside the wl_callback
//     frame-callbacks.
//   - When the surface's resident output flips, the dispatcher fires
//     `presented` on every queued feedback with the page-flip timestamp.
//   - When the surface commits a NEWER buffer before the previous one
//     scanned out, the old commit's queued feedback is discarded (per
//     spec: "...the new content has not been presented yet, then the
//     compositor must indicate the presentation failure for the prior
//     commit"). applySurfaceState handles that.
//
// Capability flags: we report VSYNC unconditionally (we always wait for a
// real flip), HW_CLOCK when the timestamp came from the kernel page-flip
// event (KMS path; sequence != 0), HW_COMPLETION never (we don't bracket
// the GPU completion against the flip), ZERO_COPY when the surface's
// committed buffer was scanned out directly (dmabuf), which we
// approximate as "buffer is non-shm" since shm always goes through an
// upload.
//
// Clock advertised on bind: CLOCK_MONOTONIC (constant 1, the POSIX value),
// sent from the on-bind hook so it precedes any feedback the client queues.

import type { Ctx, CompositorState, SurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";

import type { WpPresentationHandler }
  from "#protocols-gen/wp_presentation.js";
import { WpPresentationFeedback_Kind }
  from "#protocols-gen/wp_presentation_feedback.js";

const CLOCK_MONOTONIC = 1;

// Decode JS BigInt(u64) -> (hi32, lo32) for wire payload.
function splitU64(v: bigint): { hi: number; lo: number } {
  const hi = Number((v >> 32n) & 0xffffffffn);
  const lo = Number(v & 0xffffffffn);
  return { hi: hi >>> 0, lo: lo >>> 0 };
}

// Convert nsec (within-second) plus an output's refreshMhz to the
// `refresh` field of wp_presentation_feedback (refresh interval in
// nanoseconds; 0 when unknown).
function refreshNsFromMhz(refreshMhz: number): number {
  if (!refreshMhz || refreshMhz <= 0) return 0;
  // mHz = Hz * 1000; period_ns = 1e12 / mHz.
  return Math.round(1e12 / refreshMhz);
}

// `bind` is a synthetic on-bind hook, not a protocol request.
type WpPresentationHandlerWithBind =
  WpPresentationHandler & { bind(resource: Resource): void };

export default function makeWpPresentation(ctx: Ctx): WpPresentationHandlerWithBind {
  return {
    // Synthetic on-bind hook: the spec requires clock_id before any feedback.
    bind(presentation: Resource) {
      ctx.events.wp_presentation.send_clock_id(presentation, CLOCK_MONOTONIC);
    },
    destroy(_resource) { /* destructor */ },
    feedback(presentation, surface, callback) {
      const s = ctx.state.surfaces.get(surface);
      if (!s) {
        // Surface destroyed in flight; the callback is dead on arrival.
        // The spec says nothing concrete, but firing `discarded` matches
        // the spec's "presentation failure" wording and avoids a leaked
        // server resource.
        ctx.events.wp_presentation_feedback.send_discarded(callback);
        ctx.addon.destroyResource(callback);
        return;
      }
      (s.pending.presentationFeedbacks ??= []).push(callback);
    },
  };
}

// Apply-time hook called from wl_surface.commit's applySurfaceState (after
// the previous commit's applied feedbacks have been considered for
// supersession). Promotes pending feedbacks to applied; if the previous
// commit had pending applied feedbacks that the new commit superseded,
// fire `discarded` on each before replacing.
export function applyPresentationFeedbacks(ctx: Ctx, s: SurfaceRecord): void {
  // Supersession: a new commit while old feedbacks are still pending
  // means the old commit will never scan out. Spec: discard them.
  const prev = s.presentationFeedbacks;
  if (prev && prev.length > 0) {
    for (const cb of prev) {
      if (cb.destroyed) continue;
      ctx.events.wp_presentation_feedback.send_discarded(cb);
      ctx.addon.destroyResource(cb);
    }
  }
  const pending = s.pending.presentationFeedbacks;
  s.presentationFeedbacks = pending && pending.length > 0 ? pending.slice() : undefined;
  s.pending.presentationFeedbacks = undefined;
}

// Dispatch presented to every queued feedback for surfaces that overlap
// `outputId`. Wired into state by installProtocols (which owns the addon
// reference; this helper takes it as a parameter rather than reading off
// state to mirror reemitXdgOutput's shape).
export function dispatchPresentationFeedbackForOutput(
  state: CompositorState,
  addon: import("../types.js").Addon,
  outputId: number,
  tvSec: bigint,
  tvNsec: number,
  seq: number,
): void {
  const events = state.events;
  if (!events) return;
  const surfaceOutputs = state.compositor.surfaceOutputs;
  const outRec = state.outputs?.get(outputId);
  const wlOutputResources = state.wlOutputResources;
  const refresh = outRec ? refreshNsFromMhz(outRec.refreshMhz) : 0;
  const { hi: tvSecHi, lo: tvSecLo } = splitU64(tvSec);
  const { hi: seqHi, lo: seqLo } = splitU64(BigInt(seq));
  const hwClockBit = seq !== 0 ? WpPresentationFeedback_Kind.hw_clock : 0;

  for (const s of state.surfaces.values()) {
    const fbs = s.presentationFeedbacks;
    if (!fbs || fbs.length === 0) continue;
    if (surfaceOutputs) {
      const outs = surfaceOutputs.call(state.compositor, s.id);
      if (!outs.includes(outputId)) continue;
    }
    s.presentationFeedbacks = undefined;
    // Per-client wl_output resource lookup for this client, so the
    // sync_output event refers to the wl_output the client knows.
    const clientId = addon.clientId(s.resource);
    let wlOut: Resource | null = null;
    if (wlOutputResources) {
      const set = wlOutputResources.get(outputId);
      if (set) {
        for (const r of set) {
          if (!r.destroyed && addon.clientId(r) === clientId) {
            wlOut = r;
            break;
          }
        }
      }
    }
    // Approximate ZERO_COPY: shm buffers always copy; dmabuf is treated as
    // zero-copy. The committed buffer's `bufferDesc` (recorded on commit)
    // would tell us, but we only have the wl_buffer resource here; for
    // now report VSYNC unconditionally and leave ZERO_COPY off. The spec
    // explicitly allows omitting any non-mandatory flag.
    const flags = WpPresentationFeedback_Kind.vsync | hwClockBit;
    for (const cb of fbs) {
      if (cb.destroyed) continue;
      if (wlOut) {
        events.wp_presentation_feedback.send_sync_output(cb, wlOut);
      }
      events.wp_presentation_feedback.send_presented(
        cb, tvSecHi, tvSecLo, tvNsec, refresh, seqHi, seqLo, flags);
      addon.destroyResource(cb);
    }
  }
}

// Fire `discarded` on every queued feedback for a surface that's tearing
// down. Called from the unmap / surface-destroy path so a destroyed surface
// doesn't leak feedback resources.
export function discardPresentationFeedbacks(ctx: Ctx, s: SurfaceRecord): void {
  const fbs = s.presentationFeedbacks;
  if (!fbs) return;
  for (const cb of fbs) {
    if (cb.destroyed) continue;
    ctx.events.wp_presentation_feedback.send_discarded(cb);
    ctx.addon.destroyResource(cb);
  }
  s.presentationFeedbacks = undefined;
  const pend = s.pending.presentationFeedbacks;
  if (pend) {
    for (const cb of pend) {
      if (cb.destroyed) continue;
      ctx.events.wp_presentation_feedback.send_discarded(cb);
      ctx.addon.destroyResource(cb);
    }
    s.pending.presentationFeedbacks = undefined;
  }
}
