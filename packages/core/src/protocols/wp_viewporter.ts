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
// Protocol errors (viewport_exists, bad_value, no_surface) are silent-drop
// per this compositor's convention (no wl_resource_post_error path).

import { signature as vpSig } from "#protocols-gen/wp_viewport.js";
import type { WpViewporterHandler } from "#protocols-gen/wp_viewporter.js";
import type { WpViewportHandler } from "#protocols-gen/wp_viewport.js";

import type { Ctx, SurfaceRecord } from "./ctx.js";

void vpSig;

function surfaceOf(ctx: Ctx, viewport: import("../types.js").Resource): SurfaceRecord | undefined {
  const surf = ctx.state.viewports?.get(viewport);
  return surf ? ctx.state.surfaces.get(surf) : undefined;
}

export default function makeViewporter(ctx: Ctx): WpViewporterHandler {
  return {
    destroy(_resource) {
      // Destructor. Existing wp_viewport objects survive (per spec).
    },
    get_viewport(_manager, id, surface) {
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;            // no_surface
      if (s.hasViewport) return; // viewport_exists (one per surface)
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
      if (x < 0 || y < 0 || width <= 0 || height <= 0) return; // bad_value
      s.pending.viewportSrc = { x, y, width, height };
    },
    set_destination(resource, width, height) {
      const s = surfaceOf(ctx, resource);
      if (!s) return;
      if (width === -1 && height === -1) {
        s.pending.viewportDst = null;  // unset
        return;
      }
      if (width <= 0 || height <= 0) return; // bad_value
      s.pending.viewportDst = { width, height };
    },
  };
}
