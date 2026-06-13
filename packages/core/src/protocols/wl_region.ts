// wl_region: accumulation of axis-aligned rectangles built by add/subtract
// operations. The region's contents are consulted by wl_surface.commit
// (via set_input_region / set_opaque_region), which snapshots the rect
// list at commit time per the spec's "copy semantics".

import type { WlRegionHandler } from "#protocols-gen/wl_region.js";
import type { Ctx } from "./ctx.js";
import { Region } from "./region.js";

// Look up (or lazily create) the Region backing a wl_region resource.
function regionOf(ctx: Ctx, resource: import("../types.js").Resource): Region {
  ctx.state.regions ??= new Map();
  let r = ctx.state.regions.get(resource);
  if (!r) { r = new Region(); ctx.state.regions.set(resource, r); }
  return r;
}

export default function makeRegion(ctx: Ctx): WlRegionHandler {
  return {
    add(resource, x, y, width, height) {
      regionOf(ctx, resource).add(x, y, width, height);
    },
    subtract(resource, x, y, width, height) {
      regionOf(ctx, resource).subtract(x, y, width, height);
    },
    destroy(resource) {
      ctx.state.regions?.delete(resource);
    },
  };
}
