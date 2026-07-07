// Generic surface-tree hit testing.
//
// Every input target on screen is a wl_surface: a root (xdg_toplevel /
// xdg_popup / zwlr_layer_surface_v1) plus its subsurface descendants.
// Hit-test must follow the same z-order the compositor draws in: a
// subsurface drawn above its parent must receive input before the parent,
// and within siblings the later-stacked child wins.
//
// `hitTestSurfaceTree` takes a root wl_surface resource, the root's
// output-space rect, and a point, and returns the topmost surface (root
// or any descendant) whose output-space rect contains the point AND
// whose applied input region (surface-local) accepts it. Returns null
// when no candidate in the tree accepts.
//
// Used by the seat's `pick()` for every candidate root type so popups,
// layer surfaces and toplevels all get the same subsurface-aware
// behavior.
//
// Subsurface size: subsurfaces don't carry a layout rect (the compositor
// sizes them to their attached buffer); their logical size is derived
// from the committed buffer dims, bufferScale and buffer_transform. A
// wp_viewport destination overrides both. A subsurface with no committed
// buffer has size 0 and is silently skipped.

import type { Resource } from "./types.js";
import type { CompositorState, SurfaceRecord } from "./protocols/ctx.js";
import { childrenOf } from "./subsurfaces.js";
import { logicalContentSize } from "./surface-geometry.js";

export interface SurfaceHit {
  // The surface that accepted the hit (root or any descendant).
  surfaceRec: SurfaceRecord;
  // Output-space rect of the accepting surface (so the caller can
  // compute surface-local coords for wl_pointer.enter/motion).
  rect: { x: number; y: number; width: number; height: number };
}

// Logical (post-bufferScale / buffer_transform / viewport-dst)
// dimensions of `s`. Returns null when the surface has no presentable
// content yet (no buffer attached, descriptor missing, dims zero).
// wp_viewport dst, when set, is the surface's logical size and wins
// over the buffer-derived dims.
function surfaceLogicalSize(
  state: CompositorState, s: SurfaceRecord,
): { w: number; h: number } | null {
  const vd = s.viewportDst;
  if (vd && vd.width > 0 && vd.height > 0) {
    return { w: vd.width, h: vd.height };
  }
  const buf = s.committed.buffer;
  if (!buf) return null;
  const desc = state.buffers?.get(buf);
  if (!desc || desc.width <= 0 || desc.height <= 0) return null;
  return logicalContentSize(desc.width, desc.height,
    s.committed.bufferScale ?? 1, s.committed.bufferTransform ?? 0, null);
}

// True iff `region` accepts the surface-local point (lx, ly). The
// initial state of a surface has inputRegion === undefined (or null
// after an explicit set_input_region with null) meaning "infinite":
// the whole surface accepts input. A non-null empty Region accepts
// nothing (click-through).
function inputRegionAccepts(
  s: SurfaceRecord, lx: number, ly: number,
): boolean {
  const region = s.inputRegion;
  if (region === undefined || region === null) return true;
  return region.contains(lx, ly);
}

// Walk `root`'s subsurface subtree and return the topmost subsurface
// whose output-space rect contains `(x, y)` and whose input region
// accepts the surface-local point. Order: depth-first from the topmost
// child, so a sub-subsurface above its parent subsurface wins; among
// siblings the LAST in subsurfaceOrder is topmost (per spec, the order
// list is bottom-to-top).
function hitTestSubsurfaces(
  state: CompositorState,
  parentRes: Resource,
  parentX: number,
  parentY: number,
  x: number,
  y: number,
): SurfaceHit | null {
  const children = childrenOf(state, parentRes);
  // Top-of-stack first.
  for (let i = children.length - 1; i >= 0; i--) {
    const sub = children[i];
    const childRec = state.surfaces.get(sub.surface);
    if (!childRec || childRec.resource.destroyed) continue;
    if (!childRec.hasContent) continue;
    const size = surfaceLogicalSize(state, childRec);
    if (!size) continue;
    const cx = parentX + sub.x;
    const cy = parentY + sub.y;
    // Recurse first: a deeper descendant of this child is above it.
    const deeper = hitTestSubsurfaces(state, sub.surface, cx, cy, x, y);
    if (deeper) return deeper;
    if (x < cx || x >= cx + size.w || y < cy || y >= cy + size.h) continue;
    if (!inputRegionAccepts(childRec, x - cx, y - cy)) continue;
    return { surfaceRec: childRec, rect: { x: cx, y: cy, width: size.w, height: size.h } };
  }
  return null;
}

// Public entry point. Hit-test against the surface tree rooted at
// `root` whose output-space top-left + size is `rootRect`. Returns the
// topmost hit (subsurface or root) or null when the tree rejects.
//
// Caller has typically already done a coarse rect check against
// `rootRect` (e.g. via the WM's window list or layer-shell rect
// iteration); this function still re-validates so the entry point is
// safe to call from any code path that has a root + rect.
export function hitTestSurfaceTree(
  state: CompositorState,
  root: SurfaceRecord,
  rootRect: { x: number; y: number; width: number; height: number },
  x: number, y: number,
): SurfaceHit | null {
  if (root.resource.destroyed) return null;
  // Descendants are above the root, so check them first.
  const childHit = hitTestSubsurfaces(state, root.resource, rootRect.x, rootRect.y, x, y);
  if (childHit) return childHit;
  // Then the root itself.
  if (x < rootRect.x || x >= rootRect.x + rootRect.width) return null;
  if (y < rootRect.y || y >= rootRect.y + rootRect.height) return null;
  // The input region is in surface-local (buffer) coords. For a CSD root that
  // declared a window geometry, the buffer origin sits geom.(x,y) above-left of
  // the on-screen content rect (the shadow margin), so the surface-local point
  // is (point - rootRect) + geom offset -- the same offset the seat adds when
  // it delivers wl_pointer coords. Subsurfaces carry no geometry (offset 0).
  const geom = root.xdgSurface?.geometry;
  const gx = geom ? geom.x : 0;
  const gy = geom ? geom.y : 0;
  if (!inputRegionAccepts(root, (x - rootRect.x) + gx, (y - rootRect.y) + gy)) return null;
  return { surfaceRec: root, rect: rootRect };
}
