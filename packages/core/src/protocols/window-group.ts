// Window group enumeration: given a top-level window's surfaceId,
// return every surface id that visually belongs to it -- the window's
// own content surface, its decoration surface (if any), and every
// subsurface in its subtree (recursively). Used by callers that need
// to apply a per-window operation to every member surface (e.g. the
// per-window setTransform / setOpacity broker handlers when animating
// a whole window, where the animation must move the decoration and
// any nested subsurfaces in lockstep with the content).

import type { Resource } from "../types.js";
import type { CompositorState, SubsurfaceRecord } from "./ctx.js";

// Walk `parent`'s subsurface subtree (z-order: insertion order, which
// matches what computeBaseStack emits today) and append each child's
// surfaceId to `out`. Recurses into nested subsurfaces. The order is
// deterministic and consistent with the compositor's draw order, so
// callers that depend on per-surface state being applied in a specific
// order can rely on it.
export function collectSubsurfaceIds(
  state: CompositorState, parent: Resource, out: number[],
): void {
  if (!state.subsurfaces) return;
  const children: SubsurfaceRecord[] = [];
  for (const sub of state.subsurfaces.values()) {
    if (sub.parent === parent) children.push(sub);
  }
  for (const sub of children) {
    const child = state.surfaces.get(sub.surface);
    if (!child) continue;
    out.push(child.id);
    collectSubsurfaceIds(state, sub.surface, out);
  }
}

// Resolve `windowId` to the full set of surface ids that visually
// belong to that window: the content surface, its bound decoration
// (if any), and every subsurface transitively rooted at it. Returns
// `[windowId]` (singleton) when `windowId` is not a managed WM window
// (e.g. a phantom, a layer surface, an override-redirect xwayland
// surface) so callers can use the same code path for both group and
// single-surface cases.
//
// Order: decoration first (matches the closing-driver and
// computeBaseStack draw order for visual consistency), then the
// content surface, then subsurfaces in z order. The order is
// significant only for operations whose per-surface side effect is
// order-dependent (none today); the typical caller just iterates and
// applies the same state value to each.
export function resolveWindowGroup(
  state: CompositorState, windowId: number,
): number[] {
  const out: number[] = [];
  const wmWin = state.wm?.state.windows.find((w) => w.surfaceId === windowId);
  if (wmWin) {
    if (wmWin.decorationSurfaceId !== undefined) out.push(wmWin.decorationSurfaceId);
    out.push(windowId);
    const surf = state.surfacesById?.get(windowId);
    if (surf) collectSubsurfaceIds(state, surf.resource, out);
    return out;
  }
  // Not a WM window: single-surface fallback so callers don't have to
  // special-case phantoms / layer surfaces / xwayland override-redirects.
  return [windowId];
}
