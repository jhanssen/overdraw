// xdg_popup: a compositor-positioned, input-grabbing child surface (menus,
// dropdowns, tooltips). Created via xdg_surface.get_popup(parent, positioner).
// The compositor computes the popup rect from the positioner (popup-position.ts),
// sends xdg_popup.configure + xdg_surface.configure, and on first content maps it
// as a child drawn above its parent (placement reuses the compositor stack, like
// subsurfaces). A grab dismisses the popup (popup_done) on click-outside / Escape.

import type { XdgPopupHandler } from "#protocols-gen/xdg_popup.js";
import type { Ctx, XdgSurfaceRecord, PopupRecord, CompositorState } from "./ctx.js";
import type { Resource } from "../types.js";
import { solvePopupPosition } from "../popup-position.js";
import { computeBaseStack, emitSubtree } from "../subsurfaces.js";

// Output-space top-left of a parent xdg_surface: a toplevel uses its WM window
// rect; a popup parent uses its own resolved output position (recursively).
// `parent` may be null when the popup was created with a NULL parent and not
// yet re-parented via zwlr_layer_surface_v1.get_popup; in that case there is
// no resolvable origin and we return null. T7 (popup layer-parenting) extends
// this to also resolve a layer-shell parent origin via PopupRecord.layerParent.
export function parentOutputOrigin(state: CompositorState, parent: XdgSurfaceRecord | null): { x: number; y: number } | null {
  if (!parent) return null;
  if (parent.role === "toplevel" && parent.surface) {
    const surface = parent.surface;
    const win = state.wm?.state.windows.find((w) => w.surfaceId === surface.id);
    return win ? { x: win.rect.x, y: win.rect.y } : null;
  }
  if (parent.role === "popup" && parent.popup) {
    const pr = state.popups?.get(parent.popup);
    if (!pr) return null;
    const grand = parentOutputOrigin(state, pr.parent);
    if (!grand) return null;
    return { x: grand.x + pr.rect.x, y: grand.y + pr.rect.y };
  }
  return null;
}

// Compute + store the popup rect and send the configure handshake. Shared by
// get_popup and reposition.
export function configurePopup(ctx: Ctx, pr: PopupRecord): void {
  const origin = parentOutputOrigin(ctx.state, pr.parent) ?? { x: 0, y: 0 };
  const out = ctx.state.wm?.state.output ?? { width: 1920, height: 1080 };
  pr.rect = solvePopupPosition(pr.positioner, origin.x, origin.y, out.width, out.height);
  ctx.events.xdg_popup.send_configure(pr.resource, pr.rect.x, pr.rect.y, pr.rect.width, pr.rect.height);
  const serial = ctx.state.serial();
  pr.xdgSurface.lastConfigureSerial = serial;
  ctx.events.xdg_surface.send_configure(pr.xdgSurface.resource, serial);
}

export default function makeXdgPopup(ctx: Ctx): XdgPopupHandler {
  const rec = (resource: Resource): PopupRecord | undefined => ctx.state.popups?.get(resource);
  return {
    grab(resource, _seat, _serial) {
      // Mark this popup as grabbing: pointer button outside the popup tree
      // dismisses it (handled in the seat). For now, record it; dismissal is
      // driven by the seat's outside-click detection (see installProtocols).
      const pr = rec(resource);
      if (pr) ctx.state.grabbedPopup = resource;
    },
    reposition(resource, positioner, token) {
      const pr = rec(resource);
      const p = ctx.state.positioners?.get(positioner);
      if (!pr || !p) return;
      pr.positioner = { ...p };
      configurePopup(ctx, pr);
      ctx.events.xdg_popup.send_repositioned(resource, token);
    },
    destroy(resource) {
      const pr = rec(resource);
      if (pr) {
        const surf = pr.xdgSurface.surface;
        if (pr.mapped && surf) ctx.state.compositor.removeSurface(surf.id);
        if (ctx.state.grabbedPopup === resource) ctx.state.grabbedPopup = undefined;
        ctx.state.popups?.delete(resource);
        rebuildStackWithPopups(ctx.state);
      }
    },
  };
}

// Is the output-space point inside the popup's on-screen rect?
function pointInPopup(ctx: Pick<Ctx, "state">, pr: PopupRecord, x: number, y: number): boolean {
  const origin = parentOutputOrigin(ctx.state, pr.parent);
  if (!origin) return false;
  const px = origin.x + pr.rect.x, py = origin.y + pr.rect.y;
  return x >= px && x < px + pr.rect.width && y >= py && y < py + pr.rect.height;
}

// Called on pointer button press: if a popup holds a grab and the press is
// OUTSIDE the popup (and its ancestor popups), dismiss the popup chain
// (popup_done), innermost first. Returns true if a popup was dismissed (so the
// seat can swallow the click). This is the standard menu "click-away" behavior.
export function maybeDismissGrabbedPopup(ctx: Ctx, x: number, y: number): boolean {
  const grabRes = ctx.state.grabbedPopup;
  if (!grabRes) return false;
  const grabbed = ctx.state.popups?.get(grabRes);
  if (!grabbed) { ctx.state.grabbedPopup = undefined; return false; }
  // Inside the grabbed popup (or any still-mapped popup) -> keep it.
  for (const pr of ctx.state.popups?.values() ?? []) {
    if (pr.mapped && pointInPopup(ctx, pr, x, y)) return false;
  }
  // Outside all popups: dismiss the grabbed popup (client destroys it on done).
  ctx.events.xdg_popup.send_popup_done(grabRes);
  ctx.state.grabbedPopup = undefined;
  return true;
}

// Walk a popup's parent chain back to the root toplevel xdg_surface. Returns
// the root toplevel's surfaceId, or null if the chain is malformed (orphan
// popup, parent without a wl_surface). Used to attribute a popup to a single
// toplevel for per-output stack filtering.
function popupRootToplevelId(state: CompositorState, pr: PopupRecord): number | null {
  let parent: XdgSurfaceRecord | null = pr.parent;
  // Bounded walk to avoid pathological cycles (popups shouldn't cycle, but a
  // misbehaving client / mis-set state shouldn't lock us up). A layer-shell-
  // parented popup has parent === null; it has no root toplevel, so per-output
  // toplevel-filter expansion drops it (handled at the caller).
  for (let i = 0; i < 64; i++) {
    if (!parent) return null;
    if (parent.role === "toplevel") return parent.surface?.id ?? null;
    if (parent.role !== "popup" || !parent.popup) return null;
    const grand = state.popups?.get(parent.popup);
    if (!grand) return null;
    parent = grand.parent;
  }
  return null;
}

// Append the popup chain to `stack`, in parent-before-child order, setting each
// popup's output-space layout rect. `includePopup` filters which popups draw
// (per-output expansion uses the filter; global pass returns true for all).
// Subsurfaces parented under an included popup are walked the same way as for
// window roots.
function appendPopups(
  state: CompositorState,
  stack: number[],
  includePopup: (pr: PopupRecord) => boolean,
): void {
  // Mapped popups, ordered parent-before-child (creation order approximates this).
  for (const pr of state.popups?.values() ?? []) {
    if (!pr.mapped || !pr.xdgSurface.surface) continue;
    if (!includePopup(pr)) continue;
    const origin = parentOutputOrigin(state, pr.parent);
    if (!origin) continue;
    const px = origin.x + pr.rect.x, py = origin.y + pr.rect.y;
    state.compositor.setSurfaceLayout(pr.xdgSurface.surface.id, px, py, 0, 0);
    stack.push(pr.xdgSurface.surface.id);
    // A popup is a wl_surface and may itself parent subsurfaces; place its
    // subsurface subtree above it (same walk as for window roots).
    emitSubtree(state, pr.xdgSurface.surface.resource, px, py, stack);
  }
}

// Rebuild the draw stack: WM windows (back-to-front) each followed by their
// subsurfaces, then mapped popups on top (a popup draws above its parent; nested
// popups above their parent popup). Popups are placed at their parent's output
// origin + the popup's parent-relative rect.
//
// Also republishes every per-output toplevel filter
// (state.outputToplevelStacks) as a fully-expanded list (toplevels + their
// subsurface subtrees + popups whose root toplevel is in the filter), in the
// filter's order. The compositor's per-output stack is a strict override of
// the global stack, so the filter must contain the full draw list -- a
// toplevels-only list would clobber subsurfaces and popups (workspace plugin
// only knows toplevels). Single owner of all setStack / setOutputStack pushes.
export function rebuildStackWithPopups(state: CompositorState): void {
  const wm = state.wm;
  if (!wm) return;

  // --- Global stack: all toplevels in WM order + their subsurfaces + all popups.
  const globalStack: number[] = computeBaseStack(state, wm.state.windows);
  appendPopups(state, globalStack, () => true);
  state.compositor.setStack(globalStack);

  // --- Per-output filtered stacks. Each filter is a toplevel-id order; expand
  // it analogously to the global pass.
  const filters = state.outputToplevelStacks;
  if (!filters || filters.size === 0) return;
  if (!state.compositor.setOutputStack) return;

  for (const [outputId, toplevelIds] of filters) {
    // Build the WM-window list in the filter's order. Surfaces in the filter
    // that aren't (yet) WM windows are dropped silently -- matches the
    // global pass, which only iterates WM windows.
    const byId = new Map<number, typeof wm.state.windows[number]>();
    for (const w of wm.state.windows) byId.set(w.surfaceId, w);
    const ordered: typeof wm.state.windows = [];
    for (const id of toplevelIds) {
      const w = byId.get(id);
      if (w) ordered.push(w);
    }
    const stack: number[] = computeBaseStack(state, ordered);

    // Popups whose root toplevel is in the filter.
    const inFilter = new Set(toplevelIds);
    appendPopups(state, stack, (pr) => {
      const root = popupRootToplevelId(state, pr);
      return root !== null && inFilter.has(root);
    });

    state.compositor.setOutputStack(outputId, stack);
  }
}
