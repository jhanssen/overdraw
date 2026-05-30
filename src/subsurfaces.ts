// Subsurface compositing glue.
//
// A wl_subsurface is a child wl_surface positioned relative to its parent. The
// native compositor draws any ClientSurface that has (a) a layout rect and (b) a
// slot in the draw stack. A subsurface's wl_surface already gets a texture on
// commit (same path as any surface); this module gives it the missing two:
//   - a layout rect = parent's output rect + the subsurface's (x, y) offset;
//   - a stack slot directly ABOVE its parent (the default subsurface order).
//
// applySubsurfaces() recomputes both from current state and pushes them to
// native. Called whenever something that affects subsurface layout/stack changes
// (a subsurface gains content, set_position, parent moves, destroy).

import type { Addon, Resource } from "./types.js";
import type { CompositorState, SubsurfaceRecord, SurfaceRecord } from "./protocols/ctx.js";

// Children of a given parent wl_surface, in creation order (interpreted as
// bottom-to-top among siblings; place_above/below refinement is future work).
function childrenOf(state: CompositorState, parent: Resource): SubsurfaceRecord[] {
  const out: SubsurfaceRecord[] = [];
  const subs = state.subsurfaces;
  if (!subs) return out;
  for (const sub of subs.values()) if (sub.parent === parent) out.push(sub);
  return out;
}

// Recursively append `surfaceRes`'s subsurface subtree to `stack` (each child
// above its parent), setting each child's layout rect relative to `originX/Y`
// (the child's parent's output-space top-left). Children themselves may have
// children. Returns nothing; mutates `stack` and pushes layouts to native.
function emitSubtree(
  state: CompositorState, addon: Addon, parentRes: Resource,
  parentX: number, parentY: number, stack: number[],
): void {
  for (const sub of childrenOf(state, parentRes)) {
    const childRec = state.surfaces.get(sub.surface) as SurfaceRecord | undefined;
    if (!childRec || childRec.resource.destroyed) continue;
    // Only draw a subsurface once it has committed content (a texture). Native
    // tolerates an id with no texture (skipped at draw), but keep the stack tight.
    if (!childRec.hasContent) continue;
    const cx = parentX + sub.x;
    const cy = parentY + sub.y;
    // w/h 0 => native uses the surface's content size.
    addon.setSurfaceLayout(childRec.id, cx, cy, 0, 0);
    stack.push(childRec.id);
    emitSubtree(state, addon, sub.surface, cx, cy, stack);  // nested subsurfaces
  }
}

// Recompute subsurface layouts + the full draw stack (toplevels interleaved with
// their subsurface subtrees) and push to native. Safe to call frequently.
export function applySubsurfaces(state: CompositorState, addon: Addon): void {
  const wm = state.wm;
  if (!wm) return;
  const stack: number[] = [];
  for (const win of wm.state.windows) {
    stack.push(win.surfaceId);
    emitSubtree(state, addon, win.surfaceRec.resource, win.rect.x, win.rect.y, stack);
  }
  addon.setStack(stack);
}
