// Cross-output workspace move: freeze the moving surface synchronously
// and drive wl_surface.enter/leave + wp_fractional_scale.preferred_scale
// to the TARGET output BEFORE the WM's relayout fires its configure.
//
// Sequencing matters in two directions:
//
//   * On the wire: the client receives, in order, enter/leave +
//     preferred_scale (this), then configure (from the WM applyLayout
//     scheduled by the same workspace move's setOutputStack side
//     effect). With preferred_scale already in the client's queue,
//     allocation in response to configure uses the new scale.
//
//   * On the compositor: between this handler running synchronously and
//     the WM's later applyLayout, a frame would otherwise render the
//     OLD buffer at whatever geometry is current (still old, since the
//     WM hasn't applied yet -- so usually harmless) OR catch a half-
//     processed in-flight client response. Freezing the surface here
//     guarantees no live-buffer rendering until the WM resize-tx
//     applies the new geometry.
//
// We register a broker hold tagged "cross-output" sharing the WM tx's
// batchKey. Its only readiness condition is "the WM has joined this
// hold" -- the WM's resize-tx requirement (configure acked + buffer at
// new logical size) is the authoritative gate. When the WM tx joins,
// the cross-output requirement is effectively done; the broker waits
// only on the WM tx's predicate before atomic apply.
//
// Cases this skips entirely (handler returns early, no hold):
//   - Same scale on source + target: no scale-driven realloc needed.
//   - Client didn't bind wp_fractional_scale_v1: it ignores
//     preferred_scale; no scale-driven realloc happens.
//   - Surface not mapped / no content yet: nothing useful to freeze.

import type { CompositorState, SurfaceRecord } from "./ctx.js";
import type { Addon, Resource } from "../types.js";
import type { DynamicBus } from "../events/dynamic-bus.js";
import { updateSurfaceOutputResidency } from "./surface-residency.js";

interface WindowMovedPayload {
  surfaceId?: unknown;
  fromOutputId?: unknown;
  toOutputId?: unknown;
}

// True iff the client bound wp_fractional_scale_v1 against this
// surface. state.fractionalScaleResources is <wp_resource> -> <wl_surface
// resource>; we scan it.
function surfaceUsesFractionalScale(
  state: CompositorState, rec: SurfaceRecord,
): boolean {
  const m = state.fractionalScaleResources;
  if (!m) return false;
  for (const [fsRes, surfRes] of m) {
    if ((fsRes as Resource).destroyed) continue;
    if (surfRes === rec.resource) return true;
  }
  return false;
}

export function installCrossOutputMove(
  state: CompositorState, addon: Addon, pluginBus: DynamicBus,
): void {
  pluginBus.subscribe("workspace.window-moved", (_name, raw) => {
    const p = raw as WindowMovedPayload | undefined;
    if (!p) return;
    if (typeof p.surfaceId !== "number"
        || typeof p.fromOutputId !== "number"
        || typeof p.toOutputId !== "number") return;
    if (p.fromOutputId === p.toOutputId) return;
    const broker = state.surfaceTx;
    if (!broker) return;
    const rec = state.surfacesById?.get(p.surfaceId);
    if (!rec) return;
    if (rec.mapped !== true || rec.hasContent !== true) return;
    const fromOut = state.outputs?.get(p.fromOutputId);
    const toOut = state.outputs?.get(p.toOutputId);
    if (!fromOut || !toOut) return;
    if (fromOut.scale === toOut.scale) return;
    if (!surfaceUsesFractionalScale(state, rec)) return;

    const surfaceId = p.surfaceId;
    const targetOutputId = p.toOutputId;
    broker.begin(surfaceId, {
      tag: "cross-output",
      batchKey: "wm-tx",
      // Released as soon as the WM resize-tx requirement joins this
      // hold (the workspace move's setOutputStack side effect schedules
      // a 'reorder' relayout which engages beginResizeTx for this
      // surface in the same microtask cycle). The WM tx's own
      // predicate (acked + surfaceReadyAt at the new logical size +
      // target scale) is the authoritative apply gate.
      ready: () => broker.tagsFor(surfaceId).includes("wm-tx"),
      onStart: () => {
        updateSurfaceOutputResidency(state, addon, rec, [targetOutputId]);
      },
    });
  });
}
