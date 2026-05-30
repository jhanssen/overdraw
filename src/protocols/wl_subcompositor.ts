// wl_subcompositor / wl_subsurface: child surfaces positioned relative to a
// parent. Clients (e.g. foot) require the wl_subcompositor global to exist and
// use subsurfaces for overlays and client-side decorations.
//
// LIMITATION: subsurface *compositing* is not implemented — the compositor draws
// top-level surfaces only (see "Compositing"). We track parent/position/sync so
// the protocol is well-formed and clients don't error, but subsurface content is
// not yet drawn. For foot this means the main grid (primary surface) renders;
// overlays + CSD borders (subsurfaces) do not appear yet.

import type { WlSubcompositorHandler } from "#protocols-gen/wl_subcompositor.js";
import type { WlSubsurfaceHandler } from "#protocols-gen/wl_subsurface.js";
import type { Ctx, SubsurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";

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
    destroy(resource) { ctx.state.subsurfaces?.delete(resource); },
    set_position(resource, x, y) { const s = rec(resource); if (s) { s.x = x; s.y = y; } },
    place_above(_resource, _sibling) {},
    place_below(_resource, _sibling) {},
    set_sync(resource) { const s = rec(resource); if (s) s.sync = true; },
    set_desync(resource) { const s = rec(resource); if (s) s.sync = false; },
  };
}
