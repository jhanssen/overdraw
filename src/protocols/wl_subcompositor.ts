// wl_subcompositor / wl_subsurface: child surfaces positioned relative to a
// parent. Clients (e.g. foot) use subsurfaces for overlays and client-side
// decorations.
//
// Subsurfaces ARE composited: a child wl_surface gets a texture on commit like
// any surface; src/subsurfaces.ts gives it a layout rect (parent output rect +
// offset) and a draw-stack slot above its parent. Commit SEMANTICS (sync caching,
// desync apply, inherited sync, position applied on parent commit) live in
// wl_surface.commit / applySurfaceState. See test/subsurface.gpu.mjs.
//
// Not yet handled: place_above/place_below sibling reordering (siblings draw in
// creation order).

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
        resource: id, surface, parent,
        x: 0, y: 0, pendingX: 0, pendingY: 0,
        sync: true, // a subsurface is initially synchronized (spec)
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
      // Position is double-buffered subsurface state: it takes effect when the
      // PARENT surface next commits (applySurfaceState copies pending -> applied),
      // regardless of the child's sync mode. Do NOT apply immediately.
      const s = rec(resource);
      if (s) { s.pendingX = x; s.pendingY = y; }
    },
    place_above(_resource, _sibling) {},
    place_below(_resource, _sibling) {},
    // set_sync / set_desync are effective IMMEDIATELY (spec exception). Switching
    // to desync while a cache exists flushes it on the next commit (handled in
    // wl_surface.commit).
    set_sync(resource) { const s = rec(resource); if (s) s.sync = true; },
    set_desync(resource) { const s = rec(resource); if (s) s.sync = false; },
  };
}
