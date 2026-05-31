// xdg_positioner: accumulates the geometry rules a client uses to place a popup.
// The state is consumed at xdg_surface.get_popup (see xdg_popup.ts); the solver
// in src/popup-position.ts turns it into a rect. The positioner is reusable until
// destroyed, but in practice clients create one per popup.

import type { XdgPositionerHandler } from "#protocols-gen/xdg_positioner.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import type { Positioner } from "../popup-position.js";

function defaults(): Positioner {
  return {
    width: 0, height: 0,
    anchorRect: { x: 0, y: 0, width: 0, height: 0 },
    anchor: 0, gravity: 0, constraintAdjustment: 0, offsetX: 0, offsetY: 0,
  };
}

export default function makeXdgPositioner(ctx: Ctx): XdgPositionerHandler {
  const rec = (resource: Resource): Positioner => {
    ctx.state.positioners ??= new Map();
    let p = ctx.state.positioners.get(resource);
    if (!p) { p = defaults(); ctx.state.positioners.set(resource, p); }
    return p;
  };
  return {
    set_size(resource, width, height) { const p = rec(resource); p.width = width; p.height = height; },
    set_anchor_rect(resource, x, y, width, height) {
      rec(resource).anchorRect = { x, y, width, height };
    },
    set_anchor(resource, anchor) { rec(resource).anchor = anchor; },
    set_gravity(resource, gravity) { rec(resource).gravity = gravity; },
    set_constraint_adjustment(resource, ca) { rec(resource).constraintAdjustment = ca; },
    set_offset(resource, x, y) { const p = rec(resource); p.offsetX = x; p.offsetY = y; },
    set_reactive(_resource) { /* reactive reposition on parent move: future */ },
    set_parent_size(_resource, _w, _h) { /* used with reactive; not needed yet */ },
    set_parent_configure(_resource, _serial) { /* used with reactive; not needed yet */ },
    destroy(resource) { ctx.state.positioners?.delete(resource); },
  };
}
