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
// Sibling order. wl_subcompositor.get_subsurface appends each new child to
// the parent's child list (top of the local sibling stack, above all prior
// siblings). place_above / place_below queue a pending reorder op on the
// parent; on the parent's next commit, the queue is drained in order
// against the child list. The list -- not the subsurfaces Map -- is the
// source of truth childrenOf() iterates for draw order.

import type { WlSubcompositorHandler } from "#protocols-gen/wl_subcompositor.js";
import type { WlSubsurfaceHandler } from "#protocols-gen/wl_subsurface.js";
import type { Ctx, SubsurfaceRecord, SubsurfaceOrderOp } from "./ctx.js";
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
      // Append to the parent's child list (top of the sibling stack
      // among existing children).
      ctx.state.subsurfaceOrder ??= new Map();
      const order = ctx.state.subsurfaceOrder.get(parent) ?? [];
      order.push(id);
      ctx.state.subsurfaceOrder.set(parent, order);
    },
  };
}

export function makeSubsurface(ctx: Ctx): WlSubsurfaceHandler {
  const rec = (resource: Resource): SubsurfaceRecord | undefined =>
    ctx.state.subsurfaces?.get(resource);

  function queueReorder(op: SubsurfaceOrderOp): void {
    const s = ctx.state.subsurfaces?.get(op.subsurface);
    if (!s) return;
    ctx.state.subsurfacePendingOrder ??= new Map();
    const q = ctx.state.subsurfacePendingOrder.get(s.parent) ?? [];
    q.push(op);
    ctx.state.subsurfacePendingOrder.set(s.parent, q);
  }

  return {
    destroy(resource) {
      const s = rec(resource);
      ctx.state.subsurfaces?.delete(resource);
      if (s) {
        // Remove from parent's child list.
        const order = ctx.state.subsurfaceOrder?.get(s.parent);
        if (order) {
          const i = order.indexOf(resource);
          if (i >= 0) order.splice(i, 1);
          if (order.length === 0) ctx.state.subsurfaceOrder?.delete(s.parent);
        }
        const c = ctx.state.surfaces.get(s.surface);
        if (c) ctx.state.compositor.removeSurface(c.id);
      }
      applySubsurfaces(ctx.state);
    },
    set_position(resource, x, y) {
      // Position is double-buffered subsurface state: it takes effect when the
      // PARENT surface next commits (applySurfaceState copies pending -> applied),
      // regardless of the child's sync mode. Do NOT apply immediately.
      const s = rec(resource);
      if (s) { s.pendingX = x; s.pendingY = y; }
    },
    place_above(resource, sibling) {
      // Double-buffered: queued on the parent; applied on next parent
      // commit. `sibling` is a wl_surface (another subsurface's surface
      // OR the parent's own surface).
      queueReorder({ op: "above", subsurface: resource, sibling });
    },
    place_below(resource, sibling) {
      queueReorder({ op: "below", subsurface: resource, sibling });
    },
    // set_sync / set_desync are effective IMMEDIATELY (spec exception). Switching
    // to desync while a cache exists flushes it on the next commit (handled in
    // wl_surface.commit).
    set_sync(resource) { const s = rec(resource); if (s) s.sync = true; },
    set_desync(resource) { const s = rec(resource); if (s) s.sync = false; },
  };
}
