// wp_viewporter / wp_viewport: per-surface source crop + destination size.
//
// get_viewport(wl_surface) creates a wp_viewport bound to that surface (at
// most one per surface). The viewport's set_source / set_destination are
// double-buffered surface state applied on the surface's next commit:
//   - set_destination(w,h): the surface's logical size becomes w x h,
//     overriding the buffer-derived size. This is how a fractional-scale
//     client declares its logical size while rendering a denser buffer.
//   - set_source(x,y,w,h): the sampled region of the buffer (surface coords).
// Destroying the wp_viewport clears both on the next commit.
//
// Protocol errors: viewport_exists (get_viewport when the surface already has
// one) and bad_value (negative/zero crop or destination) are posted as fatal
// protocol errors. no_surface (set_* after the surface is destroyed) stays a
// silent drop -- the surface-gone case is not cleanly distinguishable here from
// an untracked viewport, and posting on the wrong cause would disconnect a
// valid client.

import { WpViewport_Error } from "#protocols-gen/wp_viewport.js";
import { WpViewporter_Error } from "#protocols-gen/wp_viewporter.js";
import type { WpViewporterHandler } from "#protocols-gen/wp_viewporter.js";
import type { WpViewportHandler } from "#protocols-gen/wp_viewport.js";

import type { Ctx, SurfaceRecord } from "./ctx.js";

function surfaceOf(ctx: Ctx, viewport: import("../types.js").Resource): SurfaceRecord | undefined {
  const surf = ctx.state.viewports?.get(viewport);
  return surf ? ctx.state.surfaces.get(surf) : undefined;
}

export default function makeViewporter(ctx: Ctx): WpViewporterHandler {
  return {
    destroy(_resource) {
      // Destructor. Existing wp_viewport objects survive (per spec).
    },
    get_viewport(manager, id, surface) {
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;
      if (s.hasViewport) {
        ctx.addon.postError(manager, WpViewporter_Error.viewport_exists,
          "wl_surface already has a wp_viewport");
        return;
      }
      s.hasViewport = true;
      (ctx.state.viewports ??= new Map()).set(id, surface);
    },
  };
}

export function makeViewport(ctx: Ctx): WpViewportHandler {
  return {
    destroy(resource) {
      const surf = ctx.state.viewports?.get(resource);
      ctx.state.viewports?.delete(resource);
      if (!surf) return;
      const s = ctx.state.surfaces.get(surf);
      if (s) {
        s.hasViewport = false;
        // Removing the viewport clears crop + dst on the next commit.
        s.pending.viewportSrc = null;
        s.pending.viewportDst = null;
      }
    },
    set_source(resource, x, y, width, height) {
      const s = surfaceOf(ctx, resource);
      if (!s) return;
      if (x === -1 && y === -1 && width === -1 && height === -1) {
        s.pending.viewportSrc = null;  // unset
        return;
      }
      if (x < 0 || y < 0 || width <= 0 || height <= 0) {
        ctx.addon.postError(resource, WpViewport_Error.bad_value,
          "wp_viewport.set_source values must be non-negative (or all -1 to unset)");
        return;
      }
      s.pending.viewportSrc = { x, y, width, height };
    },
    set_destination(resource, width, height) {
      const s = surfaceOf(ctx, resource);
      if (!s) return;
      if (width === -1 && height === -1) {
        s.pending.viewportDst = null;  // unset
        return;
      }
      if (width <= 0 || height <= 0) {
        ctx.addon.postError(resource, WpViewport_Error.bad_value,
          "wp_viewport.set_destination size must be positive (or -1,-1 to unset)");
        return;
      }
      s.pending.viewportDst = { width, height };
    },
  };
}
