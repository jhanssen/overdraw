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
export function childrenOf(state: CompositorState, parent: Resource): SubsurfaceRecord[] {
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

// Append `parentRes`'s subsurface subtree to `stack` in draw order (each child
// above its parent, nested children above their own parent). Only children with
// committed content are included -- an id with no texture is skipped at draw,
// but keeping the stack tight avoids churn. This owns draw-order MEMBERSHIP
// only: each child's absolute placement is derived by the compositor from its
// parent's current rect + offset (setSurfaceLayout cascade / reflowSubsurfaces),
// so no layout is pushed here.
export function emitSubtreeStack(
  state: CompositorState, parentRes: Resource, stack: number[],
): void {
  for (const sub of childrenOf(state, parentRes)) {
    const childRec = state.surfaces.get(sub.surface) as SurfaceRecord | undefined;
    if (!childRec || childRec.resource.destroyed) continue;
    if (!childRec.hasContent) continue;
    stack.push(childRec.id);
    emitSubtreeStack(state, sub.surface, stack);  // nested subsurfaces
  }
}

// The subsurface tree, exposed to the compositor as compositor ids. The
// compositor derives absolute child placement (parent rect + offset) and
// cascades per-surface fx over the subtree; this is the ONLY channel by which
// it learns the tree, so no caller enumerates subsurfaces for positioning.
export interface SubsurfaceAccessor {
  // Direct subsurface children of `parentId`, in draw order (bottom-to-top),
  // each with its parent-relative offset. Only children with committed content
  // are returned (those the compositor positions + draws).
  children(parentId: number): Array<{ id: number; offX: number; offY: number }>;
  // The subsurface parent of `id`, or null when `id` is not a subsurface.
  // Lets the compositor resolve a surface's tree root (a subsurface inherits
  // the root's camera anchoring). Optional: test accessors may omit it.
  parent?(id: number): number | null;
}

export function makeSubsurfaceAccessor(state: CompositorState): SubsurfaceAccessor {
  return {
    children(parentId) {
      const parentRec = state.surfacesById?.get(parentId);
      if (!parentRec) return [];
      const out: Array<{ id: number; offX: number; offY: number }> = [];
      for (const sub of childrenOf(state, parentRec.resource)) {
        const childRec = state.surfaces.get(sub.surface) as SurfaceRecord | undefined;
        if (!childRec || childRec.resource.destroyed || !childRec.hasContent) continue;
        out.push({ id: childRec.id, offX: sub.x, offY: sub.y });
      }
      return out;
    },
    parent(id) {
      const rec = state.surfacesById?.get(id);
      if (!rec || !state.subsurfaces) return null;
      for (const sub of state.subsurfaces.values()) {
        if (sub.surface !== rec.resource) continue;
        const parentRec = state.surfaces.get(sub.parent) as SurfaceRecord | undefined;
        return parentRec ? parentRec.id : null;
      }
      return null;
    },
  };
}

// Flatten `parent`'s subsurface subtree into `out` as compositor ids, in draw
// order (each child after its parent). Assembles a window's full surface set
// for an offscreen snapshot (closing-animation phantom); includes children
// regardless of content -- the caller snapshots whatever is drawable.
export function collectSubsurfaceIds(
  state: CompositorState, parent: Resource, out: number[],
): void {
  for (const sub of childrenOf(state, parent)) {
    const childRec = state.surfaces.get(sub.surface) as SurfaceRecord | undefined;
    if (!childRec) continue;
    out.push(childRec.id);
    collectSubsurfaceIds(state, sub.surface, out);
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
    emitSubtreeStack(state, win.surfaceRec.resource, stack);
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

// Recompute the full draw stack (via rebuildStackWithPopups, the SINGLE owner of
// setStack) and re-derive subsurface placement. A tree change (a child gained
// content, set_position applied on parent commit, a sibling reorder) can move
// children without the parent's own rect changing, so reflow every root parent's
// subtree from its current rect -- the compositor recurses into nested children.
export function applySubsurfaces(state: CompositorState): void {
  rebuildStackWithPopups(state);
  reflowRootSubsurfaces(state);
}

// Reflow each root parent's subsurface subtree. Root = a parent surface that is
// not itself a subsurface's child; the compositor's reflow recurses into nested
// subsurfaces, so reflowing roots covers the whole forest without positioning a
// nested parent from a stale rect.
function reflowRootSubsurfaces(state: CompositorState): void {
  const order = state.subsurfaceOrder;
  if (!order || order.size === 0) return;
  if (!state.compositor.reflowSubsurfaces) return;
  const childSurfaces = new Set<Resource>();
  const subs = state.subsurfaces;
  if (subs) for (const rec of subs.values()) childSurfaces.add(rec.surface);
  for (const parentRes of order.keys()) {
    if (childSurfaces.has(parentRes)) continue;   // nested; reached via recursion
    const parentRec = state.surfaces.get(parentRes);
    if (parentRec) state.compositor.reflowSubsurfaces(parentRec.id);
  }
}
