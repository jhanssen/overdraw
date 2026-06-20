// wp_fractional_scale_manager_v1 / wp_fractional_scale_v1: tells a surface
// the compositor's preferred fractional scale so it can render at that
// density and declare its logical size via wp_viewport.set_destination.
//
// get_fractional_scale(wl_surface) creates a wp_fractional_scale_v1 and
// stores the wl_surface in state.fractionalScaleResources. preferred_scale
// is the scale of the surface's primary output (the one with the largest
// overlap area). Re-emitted when state.outputs changes (output.changed bus
// in main.ts) and when surface residency shifts.

import { signature as fsSig } from "#protocols-gen/wp_fractional_scale_v1.js";
import type { WpFractionalScaleManagerV1Handler } from "#protocols-gen/wp_fractional_scale_manager_v1.js";
import type { WpFractionalScaleV1Handler } from "#protocols-gen/wp_fractional_scale_v1.js";

import type { Ctx, CompositorState } from "./ctx.js";
import type { Resource } from "../types.js";
import { primaryOutputId } from "./output-resolve.js";

void fsSig;

// The protocol expresses scale in 120ths (scale * 120), so 1.5 -> 180.
function asProtocolValue(scale: number): number {
  return Math.max(120, Math.round(scale * 120));
}

// Surface's "primary output" for scale purposes. Prefers the authoritative
// rec.enteredOutputs set (kept in sync by updateSurfaceOutputResidency, and
// overrideable by callers driving a residency change before geometry has
// moved -- e.g. cross-output workspace moves) over the geometric overlap.
// Falls back to the compositor's primary when the surface doesn't yet
// resolve to any output.
function primaryOutputOfSurface(
  state: CompositorState, surfaceRes: Resource,
): number {
  let surfaceId = -1;
  let rec = undefined;
  for (const [id, r] of state.surfacesById ?? []) {
    if (r.resource === surfaceRes) { surfaceId = id; rec = r; break; }
  }
  if (surfaceId < 0) return primaryOutputId(state);
  // Authoritative residency set first: residency drives enter/leave AND
  // preferred_scale together, so the just-updated set is what kitty just
  // saw on the wire and should match what scale we send.
  if (rec && rec.enteredOutputs && rec.enteredOutputs.size > 0) {
    let lo = Infinity;
    for (const id of rec.enteredOutputs) if (id < lo) lo = id;
    if (Number.isFinite(lo)) return lo;
  }
  // Geometric overlap fallback (residency not yet computed for this
  // surface, e.g. very first commit).
  const surfaceOutputs = state.compositor.surfaceOutputs;
  if (!surfaceOutputs) return primaryOutputId(state);
  const overlapping = surfaceOutputs.call(state.compositor, surfaceId);
  if (overlapping.length === 0) return primaryOutputId(state);
  let lo = Infinity;
  for (const id of overlapping) if (id < lo) lo = id;
  return lo === Infinity ? primaryOutputId(state) : lo;
}

// The preferred scale (in protocol units, scale * 120) for `surfaceRes`'s
// primary output. Falls back to the compositor's primary when no output
// resolves.
function preferredScaleFor(state: CompositorState, surfaceRes: Resource): number {
  const outputId = primaryOutputOfSurface(state, surfaceRes);
  const scale = state.outputs?.get(outputId)?.scale ?? 1;
  return asProtocolValue(scale);
}

// Re-emit preferred_scale for every bound wp_fractional_scale_v1 resource.
// Called on output.changed (main.ts) and surface-residency changes (M6
// surface-residency module). Destroyed resources are pruned in-line.
export function reemitFractionalScale(state: CompositorState): void {
  const map = state.fractionalScaleResources;
  if (!map || map.size === 0 || !state.events) return;
  for (const [r, surfaceRes] of [...map]) {
    if (r.destroyed) { map.delete(r); continue; }
    state.events.wp_fractional_scale_v1.send_preferred_scale(r, preferredScaleFor(state, surfaceRes));
  }
}

// Re-emit preferred_scale for a single surface's fractional-scale resources
// (the surface's residency just changed; output set may differ from last
// emission). Cheap: a single linear walk; most surfaces have 0-1 fractional
// scale resources.
export function reemitFractionalScaleForSurface(
  state: CompositorState, surfaceRes: Resource,
): void {
  const map = state.fractionalScaleResources;
  if (!map || map.size === 0 || !state.events) return;
  for (const [r, owner] of [...map]) {
    if (owner !== surfaceRes) continue;
    if (r.destroyed) { map.delete(r); continue; }
    state.events.wp_fractional_scale_v1.send_preferred_scale(
      r, preferredScaleFor(state, surfaceRes));
  }
}

export default function makeFractionalScaleManager(ctx: Ctx): WpFractionalScaleManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor. Existing wp_fractional_scale_v1 objects survive.
    },
    get_fractional_scale(_manager, id, surface) {
      (ctx.state.fractionalScaleResources ??= new Map()).set(id, surface as Resource);
      ctx.events.wp_fractional_scale_v1.send_preferred_scale(
        id, preferredScaleFor(ctx.state, surface as Resource));
    },
  };
}

export function makeFractionalScale(ctx: Ctx): WpFractionalScaleV1Handler {
  return {
    destroy(resource) {
      ctx.state.fractionalScaleResources?.delete(resource);
    },
  };
}
