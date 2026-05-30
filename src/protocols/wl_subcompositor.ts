// wl_subcompositor / wl_subsurface: child surfaces positioned relative to a
// parent. Clients (e.g. foot) use subsurfaces for overlays and client-side
// decorations.
//
// Subsurfaces ARE composited: a child wl_surface gets a texture on commit like
// any surface; src/subsurfaces.ts gives it a layout rect (parent output rect +
// offset) and a draw-stack slot above its parent, recomputed on commit /
// set_position / destroy / parent map. See test/subsurface.gpu.mjs.
//
// Not yet handled: place_above/place_below sibling reordering (siblings draw in
// creation order); sync-mode commit batching (set_sync/set_desync are tracked
// but a sync child's state is applied on its own commit, not deferred to the
// parent's commit).

import type { WlSubcompositorHandler } from "#protocols-gen/wl_subcompositor.js";
import type { WlSubsurfaceHandler } from "#protocols-gen/wl_subsurface.js";
import type { Ctx, SubsurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import { applySubsurfaces } from "../subsurfaces.js";

export default function makeSubcompositor(ctx: Ctx): WlSubcompositorHandler {
  return {
    destroy(_resource) {},
    get_subsurface(_resource, id, surface, parent) {
      ctx.state.subsurfaces ??= new Map();
      ctx.state.subsurfaces.set(id, {
        resource: id, surface, parent, x: 0, y: 0, sync: true,
      });
    },
  };
}

export function makeSubsurface(ctx: Ctx): WlSubsurfaceHandler {
  const rec = (resource: Resource): SubsurfaceRecord | undefined =>
    ctx.state.subsurfaces?.get(resource);
  return {
    destroy(resource) {
      const s = rec(resource);
      ctx.state.subsurfaces?.delete(resource);
      // Drop the child from the draw stack / its layout (no longer a subsurface).
      if (s) { const c = ctx.state.surfaces.get(s.surface); if (c) ctx.addon.removeSurface(c.id); }
      applySubsurfaces(ctx.state, ctx.addon);
    },
    set_position(resource, x, y) {
      const s = rec(resource);
      if (s) { s.x = x; s.y = y; applySubsurfaces(ctx.state, ctx.addon); }
    },
    place_above(_resource, _sibling) {},
    place_below(_resource, _sibling) {},
    set_sync(resource) { const s = rec(resource); if (s) s.sync = true; },
    set_desync(resource) { const s = rec(resource); if (s) s.sync = false; },
  };
}
