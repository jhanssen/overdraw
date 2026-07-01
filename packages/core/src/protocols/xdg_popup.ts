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
import { computeBaseStack, emitSubtreeStack } from "../subsurfaces.js";
import { primaryOutputOfSurface, primaryOutputId } from "./output-resolve.js";
import { detachSurfaceRole } from "./wl_surface.js";

// Output-space top-left of a parent xdg_surface: a toplevel uses its WM window
// rect; a popup parent uses its own resolved output position (recursively);
// a layer-surface parent (popup re-parented via zwlr_layer_surface_v1.
// get_popup) uses the layer-surface's applied rect. `parent` may be null when
// the popup was created with NULL parent and has not yet been layer-parented;
// in that case there is no resolvable origin and we return null. The
// PopupRecord-aware variant `popupOutputOrigin` is preferred for callers that
// have the popup record; this raw-XdgSurfaceRecord variant exists for the
// xdg-popup recursion and stays narrow to that case.
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
    const grand = popupOutputOrigin(state, pr);
    if (!grand) return null;
    return { x: grand.x + pr.rect.x, y: grand.y + pr.rect.y };
  }
  return null;
}

// Output-space top-left of the surface a popup is parented to. Resolves the
// xdg-shell parent chain OR the layer-shell parent's applied rect. Returns
// null when no origin can be computed (layer-parent has not applied its
// first configure yet, transient NULL-parent state, etc).
export function popupOutputOrigin(state: CompositorState, pr: PopupRecord): { x: number; y: number } | null {
  if (pr.layerParent) {
    const r = pr.layerParent.rect;
    return r ? { x: r.x, y: r.y } : null;
  }
  return parentOutputOrigin(state, pr.parent);
}

// Compute + store the popup rect and send the configure handshake. Shared by
// get_popup, reposition, and the zwlr_layer_surface_v1.get_popup path. When
// the popup has neither an xdg parent nor a layer parent yet (the transient
// state between xdg_surface.get_popup(NULL) and the layer-shell get_popup),
// the configure is suppressed -- the layer-shell handler calls back into
// configurePopup once the layer parent is assigned.
export function configurePopup(ctx: Ctx, pr: PopupRecord): void {
  const origin = popupOutputOrigin(ctx.state, pr);
  if (!origin) return; // unparented; defer the configure
  // Position-constrain the popup against its parent surface's CURRENT
  // output. A popup parented to a toplevel that has been moved to a
  // second monitor must be solved against that monitor's GLOBAL rect,
  // not output 0's -- otherwise the constraint solver pushes the popup
  // into negative parent-relative space (the parent's global X exceeds
  // output 0's right edge, so every candidate position is "outside" and
  // slide_x clamps left, landing the popup far to the left of the
  // parent on the wrong monitor).
  const parentSurfaceRes = parentSurfaceResourceOf(ctx.state, pr);
  const parentOutputId = parentSurfaceRes
    ? primaryOutputOfSurface(ctx.state, parentSurfaceRes)
    : primaryOutputId(ctx.state);
  const outEntry = ctx.state.outputs?.get(parentOutputId);
  // outputs[*].logicalPosition + logicalSize are the GLOBAL rect of
  // that output. Fall back to a safe single-output area at origin when
  // outputs is absent (test stubs).
  const outRect = outEntry
    ? {
        x: outEntry.logicalPosition.x, y: outEntry.logicalPosition.y,
        width: outEntry.logicalSize.width, height: outEntry.logicalSize.height,
      }
    : { x: 0, y: 0, width: 1920, height: 1080 };
  pr.rect = solvePopupPosition(
    pr.positioner, origin.x, origin.y,
    outRect.x, outRect.y, outRect.width, outRect.height);
  ctx.events.xdg_popup.send_configure(pr.resource, pr.rect.x, pr.rect.y, pr.rect.width, pr.rect.height);
  const serial = ctx.state.serial();
  pr.xdgSurface.lastConfigureSerial = serial;
  ctx.events.xdg_surface.send_configure(pr.xdgSurface.resource, serial);
}

// The wl_surface this popup is parented to: the root toplevel's wl_surface,
// the immediate parent popup's wl_surface, or the layer parent's wl_surface.
// Returns null only for malformed records (no resolvable parent).
function parentSurfaceResourceOf(
  state: CompositorState, pr: PopupRecord,
): Resource | null {
  if (pr.layerParent) return pr.layerParent.surface.resource;
  if (pr.parent && pr.parent.surface) return pr.parent.surface.resource;
  return null;
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
        // Detach the popup role: tear down the WM/compositor entry,
        // reset the wl_surface's mapped state so the SAME wl_surface
        // can be re-used for a fresh popup (the common GTK menu-open
        // pattern: destroy xdg_popup + xdg_surface, then
        // get_xdg_surface + get_popup again on the same wl_surface).
        // Without this reset, the next buffer commit's map sweep sees
        // s.mapped === true from this binding and silently skips the
        // re-map.
        const surf = pr.xdgSurface.surface;
        if (surf) detachSurfaceRole(ctx.state, surf);
        if (ctx.state.grabbedPopup === resource) ctx.state.grabbedPopup = undefined;
        ctx.state.popups?.delete(resource);
        rebuildStackWithPopups(ctx.state);
      }
    },
  };
}

// Is the output-space point inside the popup's on-screen rect?
function pointInPopup(ctx: Pick<Ctx, "state">, pr: PopupRecord, x: number, y: number): boolean {
  const origin = popupOutputOrigin(ctx.state, pr);
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

// Append X11 override-redirect overlays (menus, tooltips, etc.) to the
// content layer above all popups and toplevels. ORs are placed at the
// absolute X-root coords the X client supplied (identity-mapped to layout
// space in rootless mode); they have no parent-toplevel concept here, so
// they go on top of every toplevel + popup in the (global / per-output)
// stack pass.
function appendOverrideRedirects(state: CompositorState, stack: number[]): void {
  const ors = state.overrideRedirects;
  if (!ors || ors.size === 0) return;
  for (const [surfaceId, rect] of ors) {
    state.compositor.setSurfaceLayout(surfaceId, rect.x, rect.y, rect.width, rect.height);
    stack.push(surfaceId);
  }
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
    const origin = popupOutputOrigin(state, pr);
    if (!origin) continue;
    const surf = pr.xdgSurface.surface;
    const px = origin.x + pr.rect.x + (surf.offsetDx ?? 0);
    const py = origin.y + pr.rect.y + (surf.offsetDy ?? 0);
    // Positioning a popup cascades to its subsurface subtree (the compositor
    // derives each child's absolute placement from this parent rect + offset).
    state.compositor.setSurfaceLayout(surf.id, px, py, 0, 0);
    stack.push(pr.xdgSurface.surface.id);
    // A popup is a wl_surface and may itself parent subsurfaces; add its
    // subsurface subtree to the draw stack above it (membership only).
    emitSubtreeStack(state, pr.xdgSurface.surface.resource, stack);
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
//
// Per-output stack pushes are HELD when the surface-transaction broker has
// active holds. Reason: an outputStack change is a geometry change (it
// alters which output's pass draws a surface). If we pushed it immediately
// during a cross-output workspace move, the compositor would start
// rendering the moving surface in the destination output's pass while its
// `s.x`/`s.layoutW` (held by the WM resize-tx) are still on the source
// output -- the surface would draw at the wrong position, often
// straddling the output boundary at the wrong scale. The broker's
// onAfterApply hook flushes the cached per-output stacks atomically with
// the surface's new geometry.
export function rebuildStackWithPopups(state: CompositorState): void {
  const wm = state.wm;
  if (!wm) return;

  // --- Global stack: all toplevels in WM order + their subsurfaces + all
  // popups + xwayland override-redirect overlays on top.
  const globalStack: number[] = computeBaseStack(state, wm.state.windows);
  appendPopups(state, globalStack, () => true);
  appendOverrideRedirects(state, globalStack);
  state.compositor.setStack(globalStack);

  // --- Per-output filtered stacks. Each filter is a toplevel-id order; expand
  // it analogously to the global pass.
  const filters = state.outputToplevelStacks;
  if (!filters || filters.size === 0) return;
  if (!state.compositor.setOutputStack) return;

  // Compute every per-output stack, then either push directly to the
  // compositor or stash for the broker's onAfterApply to flush.
  const computed = new Map<number, number[]>();
  for (const [outputId, toplevelIds] of filters) {
    const byId = new Map<number, typeof wm.state.windows[number]>();
    for (const w of wm.state.windows) byId.set(w.surfaceId, w);
    const ordered: typeof wm.state.windows = [];
    for (const id of toplevelIds) {
      const w = byId.get(id);
      if (w) ordered.push(w);
    }
    const stack: number[] = computeBaseStack(state, ordered);
    const inFilter = new Set(toplevelIds);
    appendPopups(state, stack, (pr) => {
      if (pr.layerParent) return true;
      const root = popupRootToplevelId(state, pr);
      return root !== null && inFilter.has(root);
    });
    // Override-redirect overlays follow the same not-filtered behavior as the
    // global pass: they appear on every output's stack. (X menus have no
    // workspace concept; the X client positions them in absolute coords.)
    appendOverrideRedirects(state, stack);
    computed.set(outputId, stack);
  }

  const broker = state.surfaceTx;
  const heldDuringTx = broker && broker.size() > 0;
  if (heldDuringTx) {
    // Defer: the per-output stack push will happen in the broker's
    // onAfterApply hook (installed once by installProtocols). Stash the
    // latest computed stacks; later rebuilds will overwrite.
    state.deferredOutputStacks = computed;
    return;
  }
  // No active hold: push immediately.
  for (const [outputId, stack] of computed) {
    state.compositor.setOutputStack(outputId, stack);
  }
  state.deferredOutputStacks = undefined;
}

// Flush any per-output stacks that were deferred because the broker had
// holds when rebuildStackWithPopups was called. Invoked by the broker's
// onAfterApply hook.
export function flushDeferredOutputStacks(state: CompositorState): void {
  const cached = state.deferredOutputStacks;
  if (!cached) return;
  if (!state.compositor.setOutputStack) { state.deferredOutputStacks = undefined; return; }
  for (const [outputId, stack] of cached) {
    state.compositor.setOutputStack(outputId, stack);
  }
  state.deferredOutputStacks = undefined;
}
