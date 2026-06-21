// Shared helpers for protocol handlers that need to map a wl_output client
// resource to its outputId. The reverse direction of state.wlOutputResources
// (which is Map<outputId, Set<Resource>> populated at wl_output bind time):
// O(N_outputs * resources_per_output) which is small in practice.

import type { CompositorState } from "./ctx.js";
import { OUTPUT_DEFAULT } from "./ctx.js";
import type { Resource } from "../types.js";

// Resolve a wl_output Resource to its outputId. Returns null when the
// resource was not bound through this server (an entirely different client
// passing in a stale handle would land here; layer-shell + xdg-output treat
// this as "use the primary"). Pass null/undefined to ask for the primary
// outright -- protocols where the `output` arg is optional collapse there.
export function resolveWlOutputToId(
  state: CompositorState, output: unknown,
): number | null {
  if (output === null || output === undefined) return null;
  const tracked = state.wlOutputResources;
  if (!tracked) return null;
  for (const [outputId, set] of tracked) {
    if (set.has(output as Resource)) return outputId;
  }
  return null;
}

// The lowest live outputId, used as the "primary" fallback for protocols
// where the `output` arg is missing or unrecognized. Mirrors the WM's
// primaryOutputId so layer-shell, xdg-output, and the WM agree on which
// output is "the default."
export function primaryOutputId(state: CompositorState): number {
  if (state.wm) return state.wm.primaryOutputId();
  if (state.outputs && state.outputs.size > 0) {
    let lo = Infinity;
    for (const id of state.outputs.keys()) if (id < lo) lo = id;
    if (lo !== Infinity) return lo;
  }
  return OUTPUT_DEFAULT;
}

// Convenience for handlers that always want a usable id: resolveWlOutputToId
// + the primary as fallback. Returns the primary for null/unknown.
export function resolveOutputArg(state: CompositorState, output: unknown): number {
  const id = resolveWlOutputToId(state, output);
  return id ?? primaryOutputId(state);
}

// The outputId a wl_surface is currently "on" -- its primary output for
// the purposes of protocols that pick ONE output per surface (preferred
// scale, popup positioning, etc.). Authoritative source: the surface's
// residency set (driven by surfaceOutputs() + the residency updater).
// Falls back to geometric overlap when residency hasn't yet been computed
// (very first commit), then to the compositor's primary when neither is
// available.
//
// Picks the LOWEST overlapping outputId for determinism: a surface that
// straddles outputs 0 and 1 reports output 0 consistently across runs,
// so re-emits across output reconfigurations don't oscillate.
export function primaryOutputOfSurface(
  state: CompositorState, surfaceRes: Resource,
): number {
  let surfaceId = -1;
  let rec = undefined;
  for (const [id, r] of state.surfacesById ?? []) {
    if (r.resource === surfaceRes) { surfaceId = id; rec = r; break; }
  }
  if (surfaceId < 0) return primaryOutputId(state);
  if (rec && rec.enteredOutputs && rec.enteredOutputs.size > 0) {
    let lo = Infinity;
    for (const id of rec.enteredOutputs) if (id < lo) lo = id;
    if (Number.isFinite(lo)) return lo;
  }
  const surfaceOutputs = state.compositor.surfaceOutputs;
  if (!surfaceOutputs) return primaryOutputId(state);
  const overlapping = surfaceOutputs.call(state.compositor, surfaceId);
  if (overlapping.length === 0) return primaryOutputId(state);
  let lo = Infinity;
  for (const id of overlapping) if (id < lo) lo = id;
  return lo === Infinity ? primaryOutputId(state) : lo;
}
