// wp_fractional_scale_manager_v1 / wp_fractional_scale_v1: tells a surface the
// compositor's preferred fractional scale so it can render at that density and
// declare its logical size via wp_viewport.set_destination.
//
// get_fractional_scale(wl_surface) creates a wp_fractional_scale_v1; the
// compositor sends preferred_scale (the scale * 120, rounded) immediately and
// again whenever the output scale changes (reemitFractionalScale, hooked to
// the output.changed bus in main.ts). Single-output today: every surface gets
// the one output's scale.

import { signature as fsSig } from "#protocols-gen/wp_fractional_scale_v1.js";
import type { WpFractionalScaleManagerV1Handler } from "#protocols-gen/wp_fractional_scale_manager_v1.js";
import type { WpFractionalScaleV1Handler } from "#protocols-gen/wp_fractional_scale_v1.js";

import type { Ctx, CompositorState } from "./ctx.js";
import { OUTPUT_DEFAULT } from "./ctx.js";

void fsSig;

// The protocol expresses scale in 120ths (scale * 120), so 1.5 -> 180.
function preferredScaleValue(state: CompositorState): number {
  const scale = state.outputs?.get(OUTPUT_DEFAULT)?.scale ?? 1;
  return Math.max(120, Math.round(scale * 120));
}

export function reemitFractionalScale(state: CompositorState): void {
  const set = state.fractionalScaleResources;
  if (!set || set.size === 0 || !state.events) return;
  const v = preferredScaleValue(state);
  for (const r of [...set]) {
    if (r.destroyed) { set.delete(r); continue; }
    state.events.wp_fractional_scale_v1.send_preferred_scale(r, v);
  }
}

export default function makeFractionalScaleManager(ctx: Ctx): WpFractionalScaleManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor. Existing wp_fractional_scale_v1 objects survive.
    },
    get_fractional_scale(_manager, id, _surface) {
      (ctx.state.fractionalScaleResources ??= new Set()).add(id);
      ctx.events.wp_fractional_scale_v1.send_preferred_scale(id, preferredScaleValue(ctx.state));
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
