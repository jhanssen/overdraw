// wl_surface.enter / wl_surface.leave emission (M6).
//
// Each surface tracks the set of outputs it currently overlaps in
// SurfaceRecord.enteredOutputs. After any geometry change (WM layout,
// layer-shell placement, subsurface position) or output reconfigure
// (resize / arrangement change), updateSurfaceOutputResidency compares the
// compositor's current surfaceOutputs() against the tracked set and emits
// enter/leave events for the diff.
//
// Per spec, each enter/leave carries a wl_output resource bound by the
// surface's CLIENT. A client may not have bound every wl_output yet -- if
// no resource for outputId N is bound by this client, we suppress the
// event for N. The client gets the up-to-date state the next time it
// triggers a residency change after binding.

import type { CompositorState, SurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import type { Addon } from "../types.js";
import { reemitFractionalScaleForSurface } from "./wp_fractional_scale_manager_v1.js";

// Walk this client's bound wl_output resources for `outputId`. Returns the
// first one (a client typically only binds each output once). Null when the
// client hasn't bound that output yet -- enter/leave is suppressed.
function clientWlOutputFor(
  state: CompositorState, addon: Addon, clientId: number, outputId: number,
): Resource | null {
  const set = state.wlOutputResources?.get(outputId);
  if (!set) return null;
  for (const r of set) {
    if (r.destroyed) continue;
    if (addon.clientId(r) === clientId) return r;
  }
  return null;
}

// Recompute and emit enter/leave for a single surface. No-op if the
// compositor doesn't expose surfaceOutputs (test stubs without one) or if
// state.events is unavailable.
//
// `overrideOutputs`: when provided, treat that set as the surface's
// outputs INSTEAD of querying the compositor's geometry-derived set.
// Used by the cross-output move path: the WM has frozen the surface at
// its OLD location while it waits for the client to reallocate at the
// NEW output's scale; calling this with the NEW outputs proactively
// drives wl_surface.enter/leave + wp_fractional_scale.preferred_scale
// so the client starts reallocating without waiting for the geometry to
// actually apply.
export function updateSurfaceOutputResidency(
  state: CompositorState, addon: Addon, rec: SurfaceRecord,
  overrideOutputs?: ReadonlyArray<number>,
): void {
  const surfaceOutputs = state.compositor.surfaceOutputs;
  if (!surfaceOutputs) return;
  if (!state.events) return;
  const current = overrideOutputs
    ? new Set(overrideOutputs)
    : new Set(surfaceOutputs.call(state.compositor, rec.id));
  const prev = rec.enteredOutputs ?? new Set<number>();
  // Diff: emit leave for outputs the surface no longer overlaps.
  for (const id of prev) {
    if (current.has(id)) continue;
    const wlOut = clientWlOutputFor(state, addon, addon.clientId(rec.resource), id);
    if (wlOut) state.events.wl_surface.send_leave(rec.resource, wlOut);
  }
  // Emit enter for newly-overlapping outputs.
  let changed = prev.size !== current.size;
  for (const id of current) {
    if (prev.has(id)) continue;
    changed = true;
    const wlOut = clientWlOutputFor(state, addon, addon.clientId(rec.resource), id);
    if (wlOut) state.events.wl_surface.send_enter(rec.resource, wlOut);
  }
  rec.enteredOutputs = current;
  // The surface's primary output may have shifted; let
  // wp_fractional_scale_v1 re-emit preferred_scale if a different output's
  // scale would now apply.
  if (changed) reemitFractionalScaleForSurface(state, rec.resource);
}

// Recompute residency for every mapped surface. Called on output add/remove
// /resize/arrangement-change so clients see the new overlap state.
export function updateAllSurfaceResidency(state: CompositorState, addon: Addon): void {
  if (!state.compositor.surfaceOutputs) return;
  for (const rec of state.surfaces.values()) {
    if (!rec.mapped) continue;
    updateSurfaceOutputResidency(state, addon, rec);
  }
}
