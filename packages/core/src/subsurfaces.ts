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
import { primaryOutputOfSurface } from "./protocols/output-resolve.js";

// Region (global-logical rect + scale) for device-resolution compose.
export interface ComposeRegion { x: number; y: number; w: number; h: number; scale: number }

// The state-backed helpers sdk.compose needs to render windows WITH their
// subsurfaces at device resolution: flatten a window set into its full draw
// list, and resolve an output's / a window's region + scale. The compositor
// has no subsurface tree, so these live here (where state does) and are
// threaded into the in-thread compose SDK. Used by both main.ts and the test
// harness so production and tests share one definition.
export function makeComposeFlatteners(state: CompositorState): {
  flattenWindows: (surfaceIds: ReadonlyArray<number>) => number[];
  outputRegion: (outputId: number) => ComposeRegion | null;
  windowRegion: (surfaceId: number) => ComposeRegion | null;
} {
  return {
    flattenWindows: (surfaceIds) => {
      const wm = state.wm;
      if (!wm) return [...surfaceIds];
      const wins = surfaceIds
        .map((id) => wm.state.windows.find((w) => w.surfaceId === id))
        .filter((w): w is NonNullable<typeof w> => !!w);
      return computeBaseStack(state, wins);
    },
    outputRegion: (outputId) => {
      const o = state.outputs?.get(outputId);
      if (!o) return null;
      return {
        x: o.logicalPosition.x, y: o.logicalPosition.y,
        w: o.logicalSize.width, h: o.logicalSize.height,
        scale: o.scale > 0 ? o.scale : 1,
      };
    },
    windowRegion: (surfaceId) => {
      const rect = state.wm?.outerRectOf(surfaceId);
      if (!rect) return null;
      const sRec = state.surfacesById?.get(surfaceId);
      const outId = sRec ? primaryOutputOfSurface(state, sRec.resource) : -1;
      const sc = state.outputs?.get(outId)?.scale ?? 1;
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, scale: sc > 0 ? sc : 1 };
    },
  };
}
import { rebuildStackWithPopups } from "./protocols/xdg_popup.js";

// Children of a given parent wl_surface, in bottom-to-top draw order.
// The order is maintained by wl_subcompositor.get_subsurface (appends each
// new child to the top) + applySubsurfaceReorder (drained on parent
// commit, applying queued place_above / place_below operations).
function childrenOf(state: CompositorState, parent: Resource): SubsurfaceRecord[] {
  const order = state.subsurfaceOrder?.get(parent);
  if (!order) return [];
  const out: SubsurfaceRecord[] = [];
  for (const subResource of order) {
    const sub = state.subsurfaces?.get(subResource);
    if (sub) out.push(sub);
  }
  return out;
}

// Drain any queued place_above / place_below operations for the given
// parent. Called from wl_surface.commit's apply path (applySurfaceState)
// so reorder ops are double-buffered like position changes.
//
// An invalid sibling -- one that is neither the parent's wl_surface nor
// the wl_surface of one of the parent's other subsurfaces -- silently
// drops the op (matches the "no post_error" convention).
//
// Multiple ops in arrival order: each runs against the result of the
// previous. The wl_subsurface spec says successive operations stack
// without explicit ordering rules; arrival order is the natural choice.
// Returns true if any reorder op was applied (the draw stack changed), so the
// caller can rebuild the stack only when something actually moved.
export function applySubsurfaceReorder(state: CompositorState, parent: Resource): boolean {
  const queue = state.subsurfacePendingOrder?.get(parent);
  if (!queue || queue.length === 0) return false;
  const order = state.subsurfaceOrder?.get(parent);
  if (!order) {
    // Defensive: queue refers to a parent with no child list (shouldn't
    // happen -- get_subsurface populates the list). Drop the queue.
    state.subsurfacePendingOrder?.delete(parent);
    return false;
  }
  for (const op of queue) {
    applyOneReorder(state, parent, order, op);
  }
  state.subsurfacePendingOrder?.delete(parent);
  return true;
}

function applyOneReorder(
  state: CompositorState,
  parent: Resource,
  order: Resource[],
  op: import("./protocols/ctx.js").SubsurfaceOrderOp,
): void {
  const subIdx = order.indexOf(op.subsurface);
  if (subIdx < 0) return;   // subsurface destroyed since queueing; drop.

  // The reference sibling is named by its wl_surface. Resolve to a
  // position in the parent's order:
  //   - If the sibling wl_surface is the parent's own surface, the
  //     reference is BELOW all subsurfaces (index -1 conceptually).
  //   - Otherwise the sibling must be the surface of one of this
  //     parent's subsurfaces; find its index in `order`.
  let refIdx: number;
  if (op.sibling === parent) {
    refIdx = -1;
  } else {
    refIdx = -2;   // sentinel: not found
    for (let i = 0; i < order.length; i++) {
      const sub = state.subsurfaces?.get(order[i]);
      if (sub && sub.surface === op.sibling) { refIdx = i; break; }
    }
    if (refIdx === -2) return;   // sibling not a child of this parent; drop.
  }

  // Remove the subsurface from its current position.
  order.splice(subIdx, 1);
  // Recompute the reference index post-removal: if it was after the
  // subsurface, it shifts down by one.
  if (refIdx > subIdx) refIdx -= 1;

  // Insertion index for above/below relative to the reference position.
  //   place_above(ref): goes at refIdx + 1 (above ref).
  //   place_below(ref): goes at refIdx (taking ref's slot, pushing ref
  //                     and anything above up).
  // refIdx = -1 (parent) with place_above => index 0 (bottom of siblings,
  // just above parent). place_below(parent) => behind the parent, which
  // we treat as the bottom too (index 0) -- the parent's own surface
  // isn't part of the child list, so there's nothing "below" it among
  // subsurfaces. (A more strict implementation might post a protocol
  // error; we don't.)
  let insertAt: number;
  if (op.op === "above") {
    insertAt = refIdx + 1;
  } else {
    insertAt = refIdx < 0 ? 0 : refIdx;
  }
  order.splice(insertAt, 0, op.subsurface);
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
// subtrees, back-to-front) and set each subsurface's layout rect. Does NOT
// call setStack -- the caller appends popups (if any) and sets the final
// stack, so there is a single owner of the stack order. Returns the base
// stack ids.
//
// `windows` is the toplevel order to emit. Default = wm.state.windows (the
// global stack). Pass a filtered/reordered list for per-output expansion.
// Without a WM AND no explicit list, returns [].
export function computeBaseStack(
  state: CompositorState,
  windows?: ReadonlyArray<WmWindowLike>,
): number[] {
  const list = windows ?? state.wm?.state.windows;
  if (!list) return [];
  // Sort by ascending z (bottom-to-top). Ties keep input list order
  // (stable sort) -- callers passing wm.state.windows get the
  // master-front order preserved within a z-bucket, which matters
  // only when a bucket has multiple windows AND the layout puts them
  // overlapping (the tiled bucket never overlaps; the floating
  // bucket gets one z per window from raiseWindow).
  const sorted = [...list].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const stack: number[] = [];
  for (const win of sorted) {
    // Content-gated windows (waiting for their decoration's first frame,
    // for an opening-animation plugin's release, or for any other
    // owner) are held out of the draw stack so the window enters
    // visibly intact.
    if (win.contentGateOwners !== undefined && win.contentGateOwners.size > 0) continue;
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

// Minimal WM window shape consumed by computeBaseStack. Avoids importing the
// WM's full WmWindow type into the protocols layer (it lives outside this
// module's package), and keeps the contract narrow. `z` (optional with a
// default of 0) drives draw order: ascending z = bottom-to-top.
export interface WmWindowLike {
  surfaceId: number;
  surfaceRec: { resource: Resource };
  rect: { x: number; y: number };
  // Set of owners currently holding this window's content gate. The
  // window is held out of the draw stack iff non-empty.
  contentGateOwners?: ReadonlySet<string>;
  decorationSurfaceId?: number;
  z?: number;
}

// Recompute subsurface layouts + the full draw stack and push to native. Delegates
// to the popup module's rebuildStackWithPopups, which is the SINGLE owner of
// setStack (base = windows+subsurfaces via computeBaseStack, then popups on top).
export function applySubsurfaces(state: CompositorState): void {
  rebuildStackWithPopups(state);
}
