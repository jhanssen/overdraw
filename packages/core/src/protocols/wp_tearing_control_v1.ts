// wp_tearing_control_manager_v1 / wp_tearing_control_v1: per-surface
// presentation hint. set_presentation_hint(async) tells the compositor the
// client prefers immediate (tearing) page flips over vsync for this surface.
// The hint is double-buffered surface state applied on the next commit;
// destroying the object reverts it to vsync on the next commit (per spec).
//
// The hint only has an effect while the surface is being scanned out
// directly on a KMS output (the flag rides the scanout present and the GPU
// process submits the flip with DRM_MODE_PAGE_FLIP_ASYNC when the driver
// allows it); composited output always presents vsynced. That best-effort
// behavior is exactly what the protocol specifies.

import { WpTearingControlManagerV1_Error } from "#protocols-gen/wp_tearing_control_manager_v1.js";
import type { WpTearingControlManagerV1Handler } from "#protocols-gen/wp_tearing_control_manager_v1.js";
import { WpTearingControlV1_PresentationHint } from "#protocols-gen/wp_tearing_control_v1.js";
import type { WpTearingControlV1Handler } from "#protocols-gen/wp_tearing_control_v1.js";

import type { Ctx } from "./ctx.js";

export default function makeTearingControlManager(ctx: Ctx): WpTearingControlManagerV1Handler {
  return {
    destroy(_resource) {
      // Destructor. Existing wp_tearing_control_v1 objects survive (per spec).
    },
    get_tearing_control(manager, id, surface) {
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;
      if (s.hasTearingControl) {
        ctx.addon.postError(manager, WpTearingControlManagerV1_Error.tearing_control_exists,
          "wl_surface already has a wp_tearing_control_v1");
        return;
      }
      s.hasTearingControl = true;
      (ctx.state.tearingControls ??= new Map()).set(id, surface);
    },
  };
}

export function makeTearingControl(ctx: Ctx): WpTearingControlV1Handler {
  return {
    set_presentation_hint(resource, hint) {
      const surf = ctx.state.tearingControls?.get(resource);
      if (!surf) return;
      const s = ctx.state.surfaces.get(surf);
      // Surface destroyed: silent drop (the object is inert per spec).
      if (!s) return;
      s.pending.tearingHint = hint === WpTearingControlV1_PresentationHint.async
        ? WpTearingControlV1_PresentationHint.async
        : WpTearingControlV1_PresentationHint.vsync;
    },
    destroy(resource) {
      const surf = ctx.state.tearingControls?.get(resource);
      ctx.state.tearingControls?.delete(resource);
      if (!surf) return;
      const s = ctx.state.surfaces.get(surf);
      if (s) {
        s.hasTearingControl = false;
        // Removing the object reverts the hint to vsync on the next commit.
        s.pending.tearingHint = WpTearingControlV1_PresentationHint.vsync;
      }
    },
  };
}
