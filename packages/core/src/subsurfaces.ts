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

import type { Resource } from "./types.js";
import type { CompositorState, SubsurfaceRecord, SurfaceRecord } from "./protocols/ctx.js";
import { rebuildStackWithPopups } from "./protocols/xdg_popup.js";

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
export function emitSubtree(
  state: CompositorState, parentRes: Resource,
  parentX: number, parentY: number, stack: number[],
): void {
  for (const sub of childrenOf(state, parentRes)) {
    const childRec = state.surfaces.get(sub.surface) as SurfaceRecord | undefined;
    if (!childRec || childRec.resource.destroyed) continue;
    // Only draw a subsurface once it has committed content (a texture). The
    // compositor tolerates an id with no texture (skipped at draw), but keep the
    // stack tight.
    if (!childRec.hasContent) continue;
    const cx = parentX + sub.x;
    const cy = parentY + sub.y;
    // w/h 0 => the compositor uses the surface's content size.
    state.compositor.setSurfaceLayout(childRec.id, cx, cy, 0, 0);
    stack.push(childRec.id);
    emitSubtree(state, sub.surface, cx, cy, stack);  // nested subsurfaces
  }
}

// Compute the BASE draw stack (toplevels interleaved with their subsurface
// subtrees, back-to-front) and set each subsurface's layout rect. Does NOT call
// setStack -- the caller appends popups (if any) and sets the final stack, so
// there is a single owner of the stack order. Returns the base stack ids.
export function computeBaseStack(state: CompositorState): number[] {
  const wm = state.wm;
  if (!wm) return [];
  const stack: number[] = [];
  for (const win of wm.state.windows) {
    // Content-gated windows (waiting for their decoration's first frame) are held
    // out of the draw stack so content + decoration appear together (piece 3).
    if (win.contentGated) continue;
    // The window's decoration (if any) draws directly BELOW its own content, so the
    // decoration is z-bound to the window: a window stacked above occludes it just
    // as it occludes the window below. (A flat decoration layer would put ALL
    // decorations behind ALL content, so an upper window's content would draw over
    // a lower window's decoration.)
    if (win.decorationSurfaceId !== undefined) stack.push(win.decorationSurfaceId);
    stack.push(win.surfaceId);
    emitSubtree(state, win.surfaceRec.resource, win.rect.x, win.rect.y, stack);
  }
  return stack;
}

// Recompute subsurface layouts + the full draw stack and push to native. Delegates
// to the popup module's rebuildStackWithPopups, which is the SINGLE owner of
// setStack (base = windows+subsurfaces via computeBaseStack, then popups on top).
export function applySubsurfaces(state: CompositorState): void {
  rebuildStackWithPopups(state);
}
