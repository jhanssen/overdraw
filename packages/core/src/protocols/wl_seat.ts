// wl_seat / wl_pointer / wl_keyboard: route host input to overdraw's own
// clients. handleInput() hit-tests the WM stack on each event.
//
// Pointer events always follow the pointer (Wayland semantics, not a
// policy choice). Keyboard focus is the 'focus' plugin's call: at each
// coarse focus-relevant event the seat fire-and-forgets a decide() via
// the FocusDriver and applies the result on the next tick. handleInput
// stays synchronous -- per-pointer-motion does NOT invoke decide, only
// surface-boundary crossings and the other coarse events do (see
// FocusReason in @overdraw/focus-types).

import { signature as seatSig } from "#protocols-gen/wl_seat.js";
import type { WlSeatHandler } from "#protocols-gen/wl_seat.js";
import type { WlPointerHandler } from "#protocols-gen/wl_pointer.js";
import { WlPointer_Error } from "#protocols-gen/wl_pointer.js";
import type { WlKeyboardHandler } from "#protocols-gen/wl_keyboard.js";
import type { Ctx, SeatFocus, SeatViewTransform } from "./ctx.js";
import {
  SEAT_VIEW_IDENTITY, seatViewToWorldX, seatViewToWorldY,
} from "./ctx.js";
import { computeGrabRect } from "../input/grab-math.js";
import type { Resource, InputEvent } from "../types.js";
import { KEYBOARD_EVENT } from "../events/window-bus.js";
import { markWindowChanged } from "./window-changes.js";
import type { FocusDriver } from "./focus-driver.js";
import { hitTestSurfaceTree, type SurfaceHit } from "../surface-hit-test.js";
import { popupOutputOrigin, popupChainLayerRooted } from "./xdg_popup.js";
import { dispatchRelativeMotion } from "./zwp_relative_pointer_manager_v1.js";
import { isPointerLocked, notifyPointerFocus, notifyPointerMotion } from "./zwp_pointer_constraints_v1.js";
import { releaseDeadVirtualKeyboards } from "./zwp_virtual_keyboard_manager_v1.js";
import { keyboardShortcutsInhibited, notifyShortcutsInhibitorFocus }
  from "./zwp_keyboard_shortcuts_inhibit_manager_v1.js";

// `bind` is a synthetic on-bind hook, not a protocol request.
type SeatHandler = WlSeatHandler & { bind(resource: Resource): void };

// Pure helper: purge seat state that references torn-down `wl_resource`s.
// Extracted so the per-frame disconnect sweep is unit-testable without the
// full `makeSeat` ctx (events / addon / state.surfaces / ...).
//
// Returns the (possibly null) new kbFocus / focus -- the caller assigns
// these back onto its seat object. The two per-client `Set` maps are
// mutated in place (entries with all-destroyed resources are also dropped
// from the map so it does not grow without bound across reconnect churn).
//
// libwayland's client-disconnect contract is "resources are marked destroyed,
// the wl_client* is freed, and addresses may be recycled by a future
// connection." `clientId` here is the `wl_client*` value, so a new client
// landing at a recycled address must NOT inherit the dead client's keyboards
// or pointers via these maps -- hence dropping `.destroyed` entries.
export interface SweepableSeatState {
  kbFocus: SeatFocus | null;
  focus: SeatFocus | null;
}
export function sweepDestroyedSeatState(
  seat: SweepableSeatState,
  pointersByClient: Map<number, Set<Resource>>,
  keyboardsByClient: Map<number, Set<Resource>>,
  lastEnterSerial?: Map<Resource, number>,
  clientCursors?: Map<number, unknown>,
): void {
  if (seat.kbFocus && seat.kbFocus.surfaceRec.resource.destroyed) {
    seat.kbFocus = null;
  }
  if (seat.focus && seat.focus.surfaceRec.resource.destroyed) {
    seat.focus = null;
  }
  for (const [cid, set] of keyboardsByClient) {
    for (const k of [...set]) if (k.destroyed) set.delete(k);
    if (set.size === 0) keyboardsByClient.delete(cid);
  }
  for (const [cid, set] of pointersByClient) {
    for (const p of [...set]) if (p.destroyed) set.delete(p);
    if (set.size === 0) pointersByClient.delete(cid);
  }
  // Per-pointer enter serials: drop entries for destroyed pointers.
  if (lastEnterSerial) {
    for (const p of [...lastEnterSerial.keys()]) {
      if (p.destroyed) lastEnterSerial.delete(p);
    }
  }
  // Per-client cursor preferences are keyed by clientId, which libwayland
  // recycles -- a new client at a recycled address must not inherit a dead
  // client's cursor (including hidden:true). A cursor preference can only
  // be set through a wl_pointer request, so a clientId with no surviving
  // pointers (pruned above) has no owner for its preference: drop it.
  if (clientCursors) {
    for (const cid of [...clientCursors.keys()]) {
      if (!pointersByClient.has(cid)) clientCursors.delete(cid);
    }
  }
}

const CAP = seatSig.enums.capability.entries; // { pointer:1, keyboard:2, touch:4 }


// Geometry offset of a wl_surface's xdg_surface.set_window_geometry,
// or (0, 0) when none is set. CSD clients (GTK4 etc.) declare a
// sub-rect of the buffer as "the window content"; surface-local
// coords are relative to the BUFFER, not the geometry rect, so
// translating output-space pointer positions back to surface-local
// requires adding the geometry offset back after subtracting the
// WM-assigned content position. Layer-shell / popup / cursor
// surfaces don't carry an xdg_surface and naturally return (0, 0).
function surfaceGeometryOffset(
  ctx: Ctx, res: Resource,
): { x: number; y: number } {
  const sRec = ctx.state.surfaces.get(res);
  const g = sRec?.xdgSurface?.geometry;
  return g ? { x: g.x, y: g.y } : { x: 0, y: 0 };
}

export default function makeSeat(ctx: Ctx, driver: FocusDriver): SeatHandler {
  // wl_pointer resources grouped by owning client id. A client may have several
  // (one per wl_seat bind); events go to all of that client's pointers.
  const pointersByClient = new Map<number, Set<Resource>>();
  const keyboardsByClient = new Map<number, Set<Resource>>();

  function clientPointers(clientId: number): Set<Resource> {
    let s = pointersByClient.get(clientId);
    if (!s) { s = new Set(); pointersByClient.set(clientId, s); }
    return s;
  }
  function clientKeyboards(clientId: number): Set<Resource> {
    let s = keyboardsByClient.get(clientId);
    if (!s) { s = new Set(); keyboardsByClient.set(clientId, s); }
    return s;
  }
  // Last pointer position (output space), tracked on motion; used for popup
  // click-away dismissal at button-press time (button events carry no position).
  let lastX = 0, lastY = 0;
  // Timestamp of the last pointer motion/enter, reused for the synthesized
  // motion repickPointer sends. Clients only read deltas from wl_pointer
  // timestamps; reusing the last real device time keeps the stream monotonic
  // without guessing at the input backend's clock domain.
  let lastTime = 0;
  // Whether the host pointer is currently over the compositor at all
  // (nested backend sends pointerLeave when it isn't). Gates repickPointer:
  // while outside, lastX/lastY are stale and nothing should gain focus.
  let pointerInside = false;
  // Last-known modsDepressed mask, used to diff modifier-release events
  // for the binding chain's release callback path.
  let lastModsDepressed = 0;

  // Cursor state. Shared with makePointer via ctx.state.seat
  // (which we publish below). Per-pointer-resource latest enter serial
  // for set_cursor serial validation; per-client cursor preference
  // (the surface + hotspot, or "hidden"). Encapsulated as helpers so
  // makePointer doesn't reach into our maps directly.
  const lastEnterSerial = new Map<Resource, number>();
  interface ClientCursor {
    surfaceResource: Resource | null;
    hotspotX: number;
    hotspotY: number;
    hidden: boolean;
  }
  const clientCursors = new Map<number, ClientCursor>();
  // The reserved compositor-internal cursor surface id (matches the
  // constant in JsCompositor). Used to re-point the slot at the bundled
  // default cursor when no client owns it.
  const INTERNAL_CURSOR_ID = 0x7FFF_FFF0;

  function installCompositorDefaultCursor(): void {
    // Today: revert to whatever was installed at boot (the resolver's
    // 'default' shape stored on the internal cursor surface). When
    // sdk.cursor.setDefault lands, this is where the priority resolver
    // arbitrates between plugin default and built-in default.
    ctx.state.compositor.setCursorFromSurface?.(INTERNAL_CURSOR_ID, 0, 0);
  }

  function applyClientCursor(clientId: number): void {
    const c = clientCursors.get(clientId);
    if (!c) {
      installCompositorDefaultCursor();
      ctx.state.compositor.setCursorVisible?.(true);
      return;
    }
    if (c.hidden) {
      ctx.state.compositor.setCursorVisible?.(false);
      return;
    }
    if (!c.surfaceResource || c.surfaceResource.destroyed) {
      installCompositorDefaultCursor();
      ctx.state.compositor.setCursorVisible?.(true);
      return;
    }
    const sRec = ctx.state.surfaces.get(c.surfaceResource);
    if (!sRec) {
      installCompositorDefaultCursor();
      ctx.state.compositor.setCursorVisible?.(true);
      return;
    }
    ctx.state.compositor.setCursorVisible?.(true);
    ctx.state.compositor.setCursorFromSurface?.(sRec.id, c.hotspotX, c.hotspotY);
  }

  // Accessor object: exposes the cursor state to makePointer (and to
  // wl_surface.commit, so committing a client cursor surface re-applies
  // the client's preference if it's the active focus's). Published on
  // ctx.state.seat as `cursor` below.
  const cursorOps = {
    recordEnterSerial(p: Resource, serial: number): void {
      lastEnterSerial.set(p, serial);
    },
    clearEnterSerial(p: Resource): void {
      lastEnterSerial.delete(p);
    },
    lastEnterSerialFor(p: Resource): number | undefined {
      return lastEnterSerial.get(p);
    },
    setClientCursor(clientId: number, c: ClientCursor): void {
      clientCursors.set(clientId, c);
      // If this client's surface is the current pointer focus, apply
      // the new cursor immediately.
      const seat = ctx.state.seat;
      if (seat?.focus?.clientId === clientId) applyClientCursor(clientId);
    },
    // Called by wl_surface.commit when the surface has the "cursor"
    // role and might be a client's active cursor surface. Re-applies
    // the slot so the new texture is observed.
    onCursorSurfaceCommit(surfaceResource: Resource): void {
      const seat = ctx.state.seat;
      const focusClient = seat?.focus?.clientId;
      if (focusClient === undefined) return;
      const c = clientCursors.get(focusClient);
      if (!c || c.surfaceResource !== surfaceResource) return;
      applyClientCursor(focusClient);
    },
  };
  // Publish to ctx.state for cross-handler access (wl_pointer, wl_surface).
  // The 'cursor' field is added to SeatState below.

  // wl_keyboard.enter carries a wl_array of currently-pressed keys; we send empty.
  const EMPTY_KEYS = new Uint8Array(0);

  function sendKbEnter(target: SeatFocus): void {
    const serial = ctx.state.serial();
    for (const k of clientKeyboards(target.clientId)) {
      if (k.destroyed) continue;
      ctx.events.wl_keyboard.send_enter(k, serial, target.surfaceRec.resource, EMPTY_KEYS);
    }
  }
  function sendKbLeave(target: SeatFocus): void {
    // A destroyed surface must never ride the wire as an event argument:
    // its id may already be deleted client-side, and a leave referencing
    // it is a fatal protocol error for the recipient. The client that
    // destroyed the surface needs no leave for it.
    if (target.surfaceRec.resource.destroyed) return;
    const serial = ctx.state.serial();
    for (const k of clientKeyboards(target.clientId)) {
      if (k.destroyed) continue;
      ctx.events.wl_keyboard.send_leave(k, serial, target.surfaceRec.resource);
    }
  }

  // wl_pointer.frame is since v5; sending it to an older binding aborts the
  // client. Gate every frame on the resource's bound version.
  function pointerFrame(p: Resource): void {
    if (p.version >= 5) ctx.events.wl_pointer.send_frame(p);
  }

  // Pending wl_pointer axis frame. Axis sub-events (axis value/discrete,
  // axis_source, axis_stop) accumulate here and flush on pointerFrame, emitted
  // in spec order (axis_source first, then per-axis discrete -> value -> stop,
  // then frame). Both the libinput backend and zwlr_virtual_pointer_v1 send an
  // explicit pointerFrame after a scroll group, so a single flush closes it.
  // Index 0 = vertical, 1 = horizontal.
  let axisPending = false;
  let axisSource: number | null = null;
  let axisTime = 0;
  const axisAcc = [
    { value: 0, hasValue: false, value120: 0, hasValue120: false, stop: false },
    { value: 0, hasValue: false, value120: 0, hasValue120: false, stop: false },
  ];
  function resetAxisAcc(): void {
    axisPending = false; axisSource = null; axisTime = 0;
    for (const a of axisAcc) {
      a.value = 0; a.hasValue = false; a.value120 = 0; a.hasValue120 = false; a.stop = false;
    }
  }
  function flushAxis(): void {
    if (!axisPending) return;
    const target = ctx.state.seat?.focus;
    if (target) {
      for (const p of clientPointers(target.clientId)) {
        if (p.destroyed) continue;
        if (axisSource !== null && p.version >= 5) ctx.events.wl_pointer.send_axis_source(p, axisSource);
        for (let a = 0; a < 2; a++) {
          const d = axisAcc[a];
          // relative_direction (v9): we never invert scroll, so it's always
          // identical (0); sent before the axis it describes.
          if ((d.hasValue || d.hasValue120) && p.version >= 9)
            ctx.events.wl_pointer.send_axis_relative_direction(p, a, 0);
          // High-resolution step: value120 (v8) for modern clients, downgraded
          // to the deprecated axis_discrete (v5..7) as whole detents.
          if (d.hasValue120) {
            if (p.version >= 8) ctx.events.wl_pointer.send_axis_value120(p, a, d.value120);
            else if (p.version >= 5) ctx.events.wl_pointer.send_axis_discrete(p, a, Math.round(d.value120 / 120));
          }
          if (d.hasValue) ctx.events.wl_pointer.send_axis(p, axisTime, a, d.value);
          if (d.stop && p.version >= 5) ctx.events.wl_pointer.send_axis_stop(p, axisTime, a);
        }
        pointerFrame(p);
      }
    }
    resetAxisAcc();
  }

  // Find the topmost surface under an output-space point. Searches the
  // full compositor z-order from top to bottom: overlay layer-shell,
  // top layer-shell, popups (above their parent toplevel), WM
  // toplevels, bottom layer-shell, background layer-shell. Every
  // candidate's full surface tree (root + subsurfaces) is walked via
  // `hitTestSurfaceTree`, so subsurfaces with their own input regions
  // receive input directly. Respects wl_surface input regions on every
  // surface in every tree.
  //
  // The default (no applied input region, or null applied = "infinite")
  // matches the whole surface rect; an empty input region (Region with
  // no rects) makes that surface entirely click-through and the search
  // falls through to whatever is behind it.
  function pick(x: number, y: number): SeatFocus | null {
    const above = pickLayer(x, y, ["overlay", "top"]);
    if (above) return above;
    // Content surfaces live in world coordinates: the pointer's glass
    // position maps into the world through the content camera of the
    // output it is on (identity camera = same point). Layer-shell trees
    // (and popups rooted at them) stay in glass coordinates. This mirrors
    // the render side's cameraExempt gating -- the two must agree or
    // clicks land beside pixels.
    const view = contentViewAt(x, y);
    const popup = pickPopup(x, y, view);
    if (popup) return popup;
    const win = pickToplevel(
      seatViewToWorldX(view, x), seatViewToWorldY(view, y), view);
    if (win) return win;
    return pickLayer(x, y, ["bottom", "background"]);
  }

  // The glass->world view transform of the output under a glass-space
  // point. Identity when the point is on no output or no camera is set.
  function contentViewAt(x: number, y: number): SeatViewTransform {
    const cams = ctx.state.outputCameras;
    if (!cams || cams.size === 0 || !ctx.state.outputs) return SEAT_VIEW_IDENTITY;
    for (const o of ctx.state.outputs.values()) {
      const p = o.logicalPosition;
      const s = o.logicalSize;
      if (x >= p.x && x < p.x + s.width && y >= p.y && y < p.y + s.height) {
        const cam = cams.get(o.id);
        if (!cam) return SEAT_VIEW_IDENTITY;
        return {
          originX: p.x, originY: p.y,
          camX: cam.x, camY: cam.y, zoom: cam.zoom,
        };
      }
    }
    return SEAT_VIEW_IDENTITY;
  }

  // Build a SeatFocus from a SurfaceHit produced by hitTestSurfaceTree.
  // The accepting surface may be the candidate root or any subsurface
  // descendant; either way, the hit carries the output-space rect of
  // the surface that actually accepted, so motion events can compute
  // surface-local coords against the right surface. `view` is the
  // glass->world transform the hit was made through (identity for glass-
  // anchored candidates); stored so local-coord math can re-apply it.
  function toFocus(
    hit: SurfaceHit, rootSurfaceId: number, view: SeatViewTransform,
  ): SeatFocus {
    const clientId = ctx.addon.clientId(hit.surfaceRec.resource);
    return {
      surfaceId: hit.surfaceRec.id,
      surfaceRec: hit.surfaceRec,
      rootSurfaceId,
      clientId,
      rect: hit.rect,
      view,
    };
  }

  // Surface-local coords for an output-space point on a hit surface.
  // Surface-local coords are relative to the wl_surface's origin, which
  // (for CSD clients with set_window_geometry) is NOT the same as the
  // WM-assigned content rect's origin: the geometry rect declares a
  // sub-region of the buffer, so the visible top-left of the window
  // corresponds to surface-local (geom.x, geom.y), not (0, 0). Add the
  // offset back. For X clients the surface buffer is oversized by the
  // global X scale (see docs/xwayland-design.md "HiDPI"); the X client's
  // surface-local frame is in those oversized pixels, so multiply.
  function surfaceLocalCoords(
    hit: SeatFocus, x: number, y: number,
  ): { sx: number; sy: number } {
    const goff = surfaceGeometryOffset(ctx, hit.surfaceRec.resource);
    const hitRole = ctx.state.surfacesById?.get(hit.surfaceId)?.role;
    const xn = hitRole === "xwayland" ? (ctx.state.xwaylandScale ?? 1) : 1;
    // hit.rect is in the hit's own space (world for content, glass for
    // layer trees); re-apply the view transform the hit was made with.
    return {
      sx: ((seatViewToWorldX(hit.view, x) - hit.rect.x) + goff.x) * xn,
      sy: ((seatViewToWorldY(hit.view, y) - hit.rect.y) + goff.y) * xn,
    };
  }

  // WM-toplevel candidate. windowAt walks the visible toplevel order;
  // each toplevel's tree (toplevel + subsurfaces) is hit-tested in
  // turn. The acceptor on windowAt rejects toplevels whose ROOT input
  // region drops the point so windowAt keeps walking; the subsurface-
  // aware tree hit happens once windowAt returns a candidate.
  // `x`/`y` are already world coordinates (the caller applied `view`).
  function pickToplevel(
    x: number, y: number, view: SeatViewTransform,
  ): SeatFocus | null {
    const wm = ctx.state.wm;
    if (!wm) return null;
    // walked: per windowAt's accept callback, the toplevel is a
    // candidate iff its tree hits at all (root OR a subsurface).
    let bestHit: SurfaceHit | null = null;
    let bestRootId = 0;
    const win = wm.windowAt(x, y, (w) => {
      const root = ctx.state.surfaces.get(w.surfaceRec.resource);
      if (!root) return false;
      const hit = hitTestSurfaceTree(ctx.state, root, w.rect, x, y);
      if (!hit) return false;
      bestHit = hit;
      bestRootId = root.id;
      return true;
    });
    if (!win || !bestHit) return null;
    return toFocus(bestHit, bestRootId, view);
  }

  // Topmost mapped popup under the point, walking each popup's full
  // tree. Popups are above their parent toplevel; within the popup map
  // insertion order approximates parent-before-child, so iterate in
  // REVERSE so a child popup (a submenu) wins over its parent popup.
  function pickPopup(
    x: number, y: number, view: SeatViewTransform,
  ): SeatFocus | null {
    const popups = ctx.state.popups;
    if (!popups || popups.size === 0) return null;
    const ordered = [...popups.values()].reverse();
    for (const pr of ordered) {
      if (!pr.mapped) continue;
      const root = pr.xdgSurface.surface;
      if (!root) continue;
      const origin = popupOutputOrigin(ctx.state, pr);
      if (!origin) continue;
      const rect = {
        x: origin.x + pr.rect.x,
        y: origin.y + pr.rect.y,
        width: pr.rect.width,
        height: pr.rect.height,
      };
      // A toplevel-rooted popup's rect is in world coordinates (its parent
      // pans with the camera); a layer-rooted chain is glass-anchored.
      // Test each popup with the point in its own space.
      const pview = popupChainLayerRooted(ctx.state, pr) ? SEAT_VIEW_IDENTITY : view;
      const hit = hitTestSurfaceTree(ctx.state, root, rect,
        seatViewToWorldX(pview, x), seatViewToWorldY(pview, y));
      if (hit) return toFocus(hit, root.id, pview);
    }
    return null;
  }

  // Topmost layer-shell surface in the given protocol-layer set under
  // the point, walking each candidate's full tree. Iterates
  // state.layerSurfaces in reverse insertion order; within the same
  // layer the most-recently-mapped surface wins (the spec says ordering
  // within a layer is undefined, so insertion-order is acceptable).
  // Caller passes layers in the desired check order (overlay before
  // top, etc.).
  function pickLayer(
    x: number, y: number,
    layers: ReadonlyArray<"background" | "bottom" | "top" | "overlay">,
  ): SeatFocus | null {
    const ls = ctx.state.layerSurfaces;
    if (!ls) return null;
    for (const layer of layers) {
      const candidates = [...ls.values()].reverse();
      for (const rec of candidates) {
        if (!rec.mapped || rec.destroyed) continue;
        if (rec.applied.layer !== layer) continue;
        const r = rec.rect;
        if (!r) continue;
        const root = rec.surface;
        if (root.resource.destroyed) continue;
        const hit = hitTestSurfaceTree(ctx.state, root, r, x, y);
        if (hit) return toFocus(hit, root.id, SEAT_VIEW_IDENTITY);
      }
    }
    return null;
  }

  // Move keyboard focus to `target` (or clear with null). Sends wl_keyboard
  // leave/enter on change. No-op if already focused there.
  function setKbFocus(target: SeatFocus | null): void {
    const seat = ctx.state.seat;
    if (!seat) return;
    const cur = seat.kbFocus;
    if (cur && target && cur.surfaceId === target.surfaceId) return;
    if (cur && (!target || cur.surfaceId !== target.surfaceId)) sendKbLeave(cur);
    seat.kbFocus = target;
    if (target) sendKbEnter(target);
    // keyboard.focus event: the clipboard layer (re)sends the selection to the
    // newly focused client (selection follows keyboard focus); the XWM mirrors
    // focus to X via SetInputFocus / WM_TAKE_FOCUS.
    ctx.state.bus?.emit(KEYBOARD_EVENT.focus, {
      surfaceId: target ? target.surfaceId : null,
      prevSurfaceId: cur ? cur.surfaceId : null,
      clientId: target ? target.clientId : null,
    });
    // Activation changed for the window losing AND the window gaining focus; the
    // window.change stream reports each (decorations restyle active/inactive).
    if (cur && (!target || cur.surfaceId !== target.surfaceId)) {
      markWindowChanged(ctx.state, cur.surfaceId, "activated");
    }
    if (target) markWindowChanged(ctx.state, target.surfaceId, "activated");
    // Flip keyboard-shortcuts inhibitors active/inactive with focus.
    notifyShortcutsInhibitorFocus(ctx, cur?.surfaceId, target?.surfaceId);
  }

  // Build a SeatFocus for a surface id, handling WM toplevels (rect via
  // wm.getSnapshot), layer-shell surfaces (rect via state.layerSurfaces),
  // and xwayland override-redirect overlays (rect via state.overrideRedirects).
  // Returns null when the surface is unknown or unmapped. These targets
  // carry keyboard focus (no pointer-local math), so the view stays identity.
  function focusTargetFor(surfaceId: number): SeatFocus | null {
    const s = ctx.state.surfacesById?.get(surfaceId);
    if (!s || s.resource.destroyed) return null;
    const clientId = ctx.addon.clientId(s.resource);
    // Layer-shell first: the WM doesn't know about these.
    if (s.layerSurface?.rect) {
      const r = s.layerSurface.rect;
      return { surfaceId, surfaceRec: s, rootSurfaceId: surfaceId, clientId, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, view: SEAT_VIEW_IDENTITY };
    }
    // Override-redirect xwayland overlay: rect tracked separately from the
    // WM (the overlay isn't in wm.state.windows). 3.4 will mirror focus to
    // X via SetInputFocus / WM_TAKE_FOCUS; this just exposes the rect so
    // the seat can deliver wl_keyboard.enter to the menu's wl_surface.
    if (s.role === "xwayland") {
      const orRect = ctx.state.overrideRedirects?.get(surfaceId);
      if (orRect) {
        return { surfaceId, surfaceRec: s, rootSurfaceId: surfaceId, clientId, rect: { ...orRect }, view: SEAT_VIEW_IDENTITY };
      }
    }
    const snap = ctx.state.wm?.getSnapshot(surfaceId);
    if (!snap) return null;
    return { surfaceId, surfaceRec: s, rootSurfaceId: surfaceId, clientId, rect: snap.rect, view: SEAT_VIEW_IDENTITY };
  }

  // Topmost mapped layer surface in protocol layers top|overlay with
  // keyboard_interactivity === "exclusive". Returns null when none.
  // Tie-break: insertion order (later wins), then overlay before top.
  // Bottom and background layers are not eligible (spec: "the compositor
  // is allowed to use normal focus semantics").
  function pickExclusiveLayerSurface(): import("./ctx.js").LayerSurfaceRecord | null {
    const ls = ctx.state.layerSurfaces;
    if (!ls) return null;
    let pick: import("./ctx.js").LayerSurfaceRecord | null = null;
    for (const rec of ls.values()) {
      if (!rec.mapped || rec.destroyed) continue;
      if (rec.applied.keyboardInteractivity !== "exclusive") continue;
      const l = rec.applied.layer;
      if (l !== "top" && l !== "overlay") continue;
      // Overlay layer always beats top.
      if (!pick) { pick = rec; continue; }
      if (pick.applied.layer === "overlay" && l !== "overlay") continue;
      if (pick.applied.layer !== "overlay" && l === "overlay") { pick = rec; continue; }
      // Same layer: later insertion wins (Map preserves insertion order;
      // a later iteration step replaces the earlier pick).
      pick = rec;
    }
    return pick;
  }

  // Apply a focus result by surface id. null clears. Silent no-op if the
  // surface unmapped between dispatch and apply (the focus driver does not
  // care about apply failures; the kb focus simply stays where it was).
  // Layer-shell exclusive override: when a qualifying exclusive surface
  // exists, any focus target is replaced with that surface.
  function applyKeyboardFocus(surfaceId: number | null): void {
    const exclusive = pickExclusiveLayerSurface();
    if (exclusive) {
      const t = focusTargetFor(exclusive.surface.id);
      setKbFocus(t);
      return;
    }
    if (surfaceId === null) { setKbFocus(null); return; }
    const t = focusTargetFor(surfaceId);
    if (t) setKbFocus(t);
  }

  // Recompute the exclusive-layer-focus state. Called from the layer-shell
  // handler whenever a layer surface is mapped, unmapped, or has its
  // keyboard_interactivity / layer changed. When an exclusive layer is
  // mapped and kbFocus isn't already on it, install it. When no exclusive
  // layer is mapped but kbFocus is still on one (it just unmapped), re-run
  // the focus driver under normal semantics.
  function reevaluateExclusiveLayerFocus(): void {
    const seat = ctx.state.seat;
    if (!seat) return;
    const exclusive = pickExclusiveLayerSurface();
    if (exclusive) {
      const t = focusTargetFor(exclusive.surface.id);
      if (t && (!seat.kbFocus || seat.kbFocus.surfaceId !== t.surfaceId)) {
        setKbFocus(t);
      }
      return;
    }
    // No exclusive anymore. If kbFocus was on a layer surface that's no
    // longer qualified (e.g. it just unmapped), re-run the driver.
    const cur = seat.kbFocus;
    if (cur) {
      const s = ctx.state.surfacesById?.get(cur.surfaceId);
      if (!s || s.unmapped || s.resource.destroyed
          || (s.layerSurface && (s.layerSurface.destroyed || !s.layerSurface.mapped))) {
        // Re-resolve via the focus driver under normal semantics.
        dispatchFocus("explicit");
      }
    }
  }

  function sendEnter(target: SeatFocus, sx: number, sy: number): void {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_enter(p, serial, target.surfaceRec.resource, sx, sy);
      // Stash the enter serial per pointer resource so a
      // subsequent set_cursor request from the client can be validated
      // against it.
      lastEnterSerial.set(p, serial);
      pointerFrame(p);
    }
    // Switch the cursor slot to this client's preference. set_cursor
    // may have arrived BEFORE enter (the client races); apply whatever
    // we have, or fall back to the compositor default if nothing.
    applyClientCursor(target.clientId);
  }

  function sendLeave(target: SeatFocus): void {
    // Same rule as sendKbLeave: never reference a destroyed surface in a
    // leave event. The cursor/serial cleanup still runs -- the pointer
    // focus is gone either way.
    const gone = target.surfaceRec.resource.destroyed;
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      if (!gone) {
        ctx.events.wl_pointer.send_leave(p, serial, target.surfaceRec.resource);
        pointerFrame(p);
      }
      // Clear the recorded enter serial so a late set_cursor for the
      // prior focus is rejected.
      lastEnterSerial.delete(p);
    }
    // Pointer left the client's surface: revert to compositor default.
    installCompositorDefaultCursor();
    ctx.state.compositor.setCursorVisible?.(true);
  }

  // Dispatch a focus decide() with the current snapshot. When a layer-shell
  // exclusive-keyboard surface is mapped on top/overlay, skip the driver
  // entirely and force focus to that surface -- the focus plugin does not
  // see layer-shell exclusivity (a core-level invariant above policy).
  function dispatchFocus(reason: import("./focus-driver.js").FocusReason,
                        trigger?: number, surfaceUnderPointer?: number | null): void {
    const seat = ctx.state.seat;
    const exclusive = pickExclusiveLayerSurface();
    if (exclusive) {
      const t = focusTargetFor(exclusive.surface.id);
      if (t) setKbFocus(t);
      return;
    }
    const cur = seat?.kbFocus?.surfaceId ?? null;
    const sup = surfaceUnderPointer !== undefined
      ? surfaceUnderPointer
      : (seat?.focus?.rootSurfaceId ?? seat?.focus?.surfaceId ?? null);
    driver.dispatch({
      reason,
      pointer: { x: lastX, y: lastY, surfaceUnderPointer: sup },
      currentKeyboardFocus: cur,
      ...(trigger !== undefined ? { trigger } : {}),
    });
  }

  // Map a grab to an XCursor theme shape name. Resize cursors use the
  // X11-style corner/edge names ('top_left_corner', 'left_side', etc.)
  // that ship in every XCursor theme.
  function grabCursorShape(g: import("./ctx.js").PointerGrab): string {
    if (g.kind === "move") return "move";
    if (g.kind === "camera-pan") return "grabbing";
    switch (g.edges) {
      case "top": return "top_side";
      case "bottom": return "bottom_side";
      case "left": return "left_side";
      case "right": return "right_side";
      case "top-left": return "top_left_corner";
      case "top-right": return "top_right_corner";
      case "bottom-left": return "bottom_left_corner";
      case "bottom-right": return "bottom_right_corner";
    }
  }

  // Apply a pointer-motion event to an active grab. Move/resize: compute
  // the new floating rect from the grab's anchor + startRect + current
  // pointer position, then push it to the WM. Camera-pan: the content
  // under the hand follows it -- a glass delta pans the camera by
  // -delta/zoom in world units, written transiently (render/damage/input
  // update per frame; the residency sweep + X re-narration wait for
  // endGrab's settled write).
  function applyGrabMotion(g: import("./ctx.js").PointerGrab, x: number, y: number): void {
    if (g.kind === "camera-pan") {
      const dx = x - g.lastX;
      const dy = y - g.lastY;
      if (dx === 0 && dy === 0) return;
      g.lastX = x;
      g.lastY = y;
      const cam = ctx.state.outputCameras?.get(g.outputId) ?? { x: 0, y: 0, zoom: 1 };
      ctx.state.compositor.setOutputCamera?.(
        g.outputId, cam.x - dx / cam.zoom, cam.y - dy / cam.zoom, cam.zoom, true);
      return;
    }
    const ws = ctx.state.wm?.getWindowState(g.surfaceId) ?? null;
    // The floating rect lives in world coordinates; pointer travel is
    // glass. Convert the deltas through the viewing camera (translation
    // cancels, leaving /zoom) so the window tracks the hand 1:1 on
    // glass even while zoomed out (fit/roam). The camera is static for
    // the grab's duration -- the animations broker's cameraGate denies
    // camera moves during grabs -- so the transform is stable.
    const view = contentViewAt(x, y);
    const rect = computeGrabRect(g,
      (x - g.anchorX) / view.zoom,
      (y - g.anchorY) / view.zoom,
      ws?.constraints ?? null);
    ctx.state.wm?.setFloatingRect(g.surfaceId, rect);
  }

  // Route one normalized input event.
  // Make the keymap for `keymapId` active (0 = default seat keymap, else a
  // virtual keyboard's registered keymap) before its keys are fed to xkb. The
  // seat keymap is global to all wl_keyboards, so on a real change we re-send
  // the new keymap to every bound keyboard; clients re-mmap and reinterpret
  // subsequent keycodes under it. Cheap no-op when the keymap is unchanged.
  function activateKeymap(keymapId: number): void {
    if (!ctx.addon.setActiveKeymap(keymapId)) return;
    const km = ctx.addon.keymapInfo();
    if (!km) return;
    for (const set of keyboardsByClient.values()) {
      for (const k of set) {
        if (k.destroyed) continue;
        // send_keymap takes the raw fd out of the WaylandFd, so each keyboard
        // needs its own dup.
        ctx.events.wl_keyboard.send_keymap(k, km.format, km.fd.dup(), km.size);
      }
    }
    // The WaylandFd from keymapInfo() is unused (every client got a dup); close
    // it so it doesn't leak.
    try { km.fd.close(); } catch { /* already taken/closed */ }
  }

  function handleInput(ev: InputEvent): void {
    const seat = ctx.state.seat;
    if (!seat) return;

    // During a drag-and-drop grab, the pointer is owned by the DnD machinery:
    // motion drives data_device enter/leave/motion to the surface under the
    // pointer (NOT wl_pointer), and a button release drops. Normal wl_pointer
    // routing is suppressed for the drag's duration (matches real compositors;
    // GTK in particular relies on the pointer being unfocused during a drag).
    if (seat.drag) {
      if (ev.type === "pointerMotion" || ev.type === "pointerEnter") {
        const x = ev.x ?? 0, y = ev.y ?? 0;
        seat.drag.onMotion(x, y, pick(x, y));
      } else if (ev.type === "pointerButton" && !ev.pressed) {
        seat.drag.onButton(false);
      }
      // Other pointer events are swallowed during the drag.
      return;
    }

    // Interactive pointer grab (move / resize). While active, motion
    // drives the grabbed window's floating rect; pointer events are not
    // forwarded to clients. Keyboard / button events still go through
    // the normal flow below (the binding chain's release path consumes
    // the binding's button-up + modifier-up, ending the grab via the
    // release callback's action).
    if (seat.grab && (ev.type === "pointerMotion" || ev.type === "pointerEnter")) {
      lastX = ev.x ?? 0;
      lastY = ev.y ?? 0;
      lastTime = ev.time ?? lastTime;
      pointerInside = true;
      ctx.state.compositor.setCursorPosition?.(lastX, lastY);
      applyGrabMotion(seat.grab, lastX, lastY);
      return;
    }

    switch (ev.type) {
      case "pointerMotion":
      case "pointerEnter": {
        const x = ev.x ?? 0;
        const y = ev.y ?? 0;
        lastX = x; lastY = y;
        lastTime = ev.time ?? lastTime;
        pointerInside = true;
        // Move the software cursor with the pointer. The
        // compositor's cursor slot draws above every layer; visibility
        // and texture-installed gate inclusion -- so this is cheap when
        // no cursor is set up yet. pointerEnter restores visibility
        // after a prior pointerLeave hide.
        if (ev.type === "pointerEnter") ctx.state.compositor.setCursorVisible?.(true);
        ctx.state.compositor.setCursorPosition?.(x, y);
        // Feed kinematic state machine. State.cursorKinematics is wired
        // in main.ts; harnesses that don't bring up cursor leave it
        // absent (the call is optional-chained).
        ctx.state.cursorKinematics?.update(x, y, ev.time ?? performance.now());
        const hit = pick(x, y);
        const prevPointerSurface = seat.focus?.surfaceId ?? null;
        if (seat.focus && (!hit || hit.surfaceId !== seat.focus.surfaceId)) {
          sendLeave(seat.focus);
          seat.focus = null;
        }
        if (!hit) {
          notifyPointerFocus(ctx, null);
          if (prevPointerSurface !== null) {
            dispatchFocus("pointer-leave", undefined, null);
          }
          return;
        }
        const { sx, sy } = surfaceLocalCoords(hit, x, y);
        if (!seat.focus) {
          seat.focus = hit;
          sendEnter(hit, sx, sy);
        } else if (!isPointerLocked(ctx)) {
          // While the pointer is locked (zwp_locked_pointer_v1) the cursor is
          // frozen; the client reads motion via zwp_relative_pointer_v1 below
          // instead of wl_pointer.motion.
          for (const p of clientPointers(hit.clientId)) {
            if (p.destroyed) continue;
            ctx.events.wl_pointer.send_motion(p, ev.time, sx, sy);
            pointerFrame(p);
          }
        }
        // zwp_relative_pointer_v1: deliver unaccelerated deltas to the focused
        // client regardless of surface-local position. Real motion only (enter
        // carries no delta).
        if (ev.type === "pointerMotion") {
          dispatchRelativeMotion(ctx, clientPointers(hit.clientId), ev);
        }
        // Pointer-constraints: track focus + (for region-gated locks) region
        // entry so locks/confines activate on the right surface.
        notifyPointerFocus(ctx, hit.surfaceId);
        if (ev.type === "pointerMotion") notifyPointerMotion(ctx);
        // Focus dispatch only on surface change (coarse event), not per
        // motion within the same surface. Keyboard focus / activation
        // target the root toplevel, not the (possibly subsurface) hit.
        if (prevPointerSurface !== hit.surfaceId) {
          dispatchFocus("pointer-enter", hit.rootSurfaceId, hit.rootSurfaceId);
        }
        break;
      }
      case "pointerLeave": {
        pointerInside = false;
        const prev = seat.focus?.surfaceId ?? null;
        notifyPointerFocus(ctx, null);
        if (seat.focus) { sendLeave(seat.focus); seat.focus = null; }
        if (prev !== null) {
          dispatchFocus("pointer-leave", undefined, null);
        }
        // Host pointer left the overdraw window: hide the software
        // cursor. setCursorVisible(true) is restored either on
        // pointerEnter below or on the next external cursor install
        // (depending on policy; today we restore on next motion via
        // the install-time visibility default).
        ctx.state.compositor.setCursorVisible?.(false);
        break;
      }
      case "pointerButton": {
        // A press outside a grabbing popup dismisses it but is STILL
        // delivered to whatever surface is under it. Swallowing the
        // press makes the user click twice to interact with anything
        // else (once to dismiss, once to act) -- and on the popup's
        // own opener button (the GTK4 hamburger menu being the canonical
        // case) the swallowed first click means the button never sees
        // its toggle press, so the menu won't reopen. wlroots' popup
        // grab follows the same model: the press is sent, the client
        // dismisses the popup itself in response.
        if (ev.pressed) ctx.state.dismissGrabbedPopup?.(lastX, lastY);
        const button = ev.button ?? 0;

        // Consult the binding chain. Press: dispatchPress (with the
        // current mod mask). Release: dispatchRelease. The chain consumes
        // (suppresses client forwarding) when a binding matches its press
        // OR when a release participates in a held instance.
        let consumed = false;
        const chain = ctx.state.bindingChain;
        if (chain && button !== 0) {
          if (ev.pressed) {
            const r = chain.dispatchPress({
              kind: "button", mods: lastModsDepressed, button,
            });
            consumed = r.consume;
          } else {
            const r = chain.dispatchRelease({ kind: "button", button });
            consumed = r.consume;
          }
        }
        // Pointer-drag grabs (move/resize/camera-pan, hotkey- or
        // client-initiated) set endOnButtonUp: the seat auto-ends the
        // grab on the next button release. This must run BEFORE the
        // consumed early-return -- the binding chain consumes a release
        // that participates in a held chord instance (button up,
        // modifier still down) and fires the binding's releaseAction
        // only at instance end, so a drag gesture must end on the
        // button lift here regardless.
        if (seat.grab && !ev.pressed && seat.grab.endOnButtonUp) {
          seat.endGrab();
        }
        if (consumed) return;

        // While a grab is active, button events are not forwarded to the
        // client (the user is manipulating compositor geometry, not the
        // client). The binding chain still saw the event above, so the
        // grab's release callback gets to fire normally.
        if (seat.grab) return;

        if (!seat.focus) return;
        const serial = ctx.state.serial();
        const state = ev.pressed ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_button(p, serial, ev.time, button, state);
          pointerFrame(p);
        }
        if (ev.pressed) {
          const rootId = seat.focus.rootSurfaceId ?? seat.focus.surfaceId;
          dispatchFocus("pointer-button", rootId, rootId);
          // Click-to-raise: a press on a toplevel's content surface
          // raises it (and its modal subtree, redirecting up the
          // chain if the press landed on a modal dialog). Focus and
          // raise are decoupled here on purpose; a pointer-follows-
          // focus policy can still walk over windows without
          // reordering them. Raise targets the root toplevel, not a
          // subsurface the press may have landed on.
          ctx.state.wm?.raiseWindow(rootId);
        }
        break;
      }
      case "pointerAxis": {
        // Pointer-scroll hotkeys: a discrete wheel detent (value120) can fire a
        // binding ("Mod+scroll_up"). Vertical: +down/-up; horizontal: +right/
        // -left. When a binding matches it consumes the scroll (not forwarded to
        // the client). High-resolution / touchpad scroll (no value120) is never
        // a binding trigger and forwards normally.
        if (ev.value120) {
          const horiz = !!ev.horizontal;
          const pos = ev.value120 > 0;
          const dir: 0 | 1 | 2 | 3 = horiz ? (pos ? 3 : 2) : (pos ? 1 : 0);
          const chain = ctx.state.bindingChain;
          if (chain && chain.dispatchPress({ kind: "scroll", mods: lastModsDepressed, dir }).consume) {
            return;
          }
        }
        // Accumulate into the pending frame; flushed on pointerFrame so
        // axis_source / relative_direction / value120 / value / stop emit in
        // spec order within one frame.
        const a = ev.horizontal ? 1 : 0;
        axisPending = true;
        axisTime = ev.time ?? axisTime;
        if (ev.value !== undefined) { axisAcc[a].value += ev.value; axisAcc[a].hasValue = true; }
        if (ev.value120) { axisAcc[a].value120 += ev.value120; axisAcc[a].hasValue120 = true; }
        break;
      }
      case "pointerAxisSource": {
        axisPending = true;
        axisSource = ev.axisSource ?? null;
        break;
      }
      case "pointerAxisStop": {
        const a = ev.horizontal ? 1 : 0;
        axisPending = true;
        axisTime = ev.time ?? axisTime;
        axisAcc[a].stop = true;
        break;
      }
      case "pointerFrame": {
        flushAxis();
        break;
      }
      case "keyboardKey": {
        // Before processing a (real) key, release any keys still held by a
        // virtual keyboard whose client died -- otherwise a stuck modifier
        // (e.g. Ctrl from a killed lan-mouse) poisons this keystroke. Cheap: a
        // no-op unless a dead virtual keyboard is registered.
        releaseDeadVirtualKeyboards(ctx);
        // Make this keyboard's keymap active before feeding xkb. Real input
        // carries keymapId 0 (default); a virtual keyboard carries its own
        // registered id. On a change the new keymap is (re-)sent to clients so
        // they interpret the key under the right layout.
        activateKeymap(ev.keymapId ?? 0);
        // Always feed xkb state, even when no client is focused: the chain
        // consults modifier state to match bindings, and xkb's mod state
        // must track every keystroke regardless of where it goes.
        const pressed = !!ev.pressed;
        const prevMods = lastModsDepressed;
        const mods = ctx.addon.keyUpdate(ev.key ?? 0, pressed);
        lastModsDepressed = mods.modsDepressed;

        // VT-switch keysyms (Ctrl+Alt+Fn under standard keymaps translate to
        // XKB_KEY_XF86Switch_VT_N): intercept before forwarding to clients
        // so the user's focused window never sees these. Both press and
        // release are consumed. addon.switchVT routes through libseat
        // -> kernel; the seat's disable_seat callback then pauses overdraw.
        // No-op in nested mode (addon.switchVT returns false).
        if (mods.keysym >= 0x1008fe01 && mods.keysym <= 0x1008fe0c) {
          if (pressed) {
            const vt = mods.keysym - 0x1008fe00;
            ctx.addon.switchVT(vt);
          }
          return;  // never deliver VT keys (press or release) to clients
        }

        // Consult the binding chain.
        //   - press: dispatchPress; consume on match.
        //   - release: dispatchRelease for (a) the released keysym AND
        //     (b) every modifier bit that just became unset. Consume if
        //     any held instance participated.
        // Key-up events bypass the press path (bindings fire on press
        // only); xkb still sees them so subsequent presses have the
        // right modifier state.
        // Bindings match the shift-level-0 keysym so a held Shift is purely a
        // modifier bit (Mod+Shift+j matches the 'j' symbol, not 'J'). Fall
        // back to the translated keysym if the keymap reported no base symbol.
        const matchSym = mods.baseKeysym || mods.keysym;
        let consumed = false;
        // When the focused surface has an active shortcuts inhibitor
        // (zwp_keyboard_shortcuts_inhibitor_v1), the compositor's bindings are
        // suppressed so every key reaches the client. VT-switch is handled
        // above this point and stays effective.
        const chain = keyboardShortcutsInhibited(ctx) ? null : ctx.state.bindingChain;
        if (chain) {
          if (pressed && matchSym !== 0) {
            const r = chain.dispatchPress({
              kind: "key",
              mods: mods.modsDepressed, keysym: matchSym,
            });
            consumed = r.consume;
          } else if (!pressed) {
            // Released a modifier? Diff the mask and dispatch each
            // newly-unset bit.
            const droppedBits = prevMods & ~mods.modsDepressed;
            for (let bit = 1; bit !== 0 && bit <= droppedBits; bit <<= 1) {
              if ((droppedBits & bit) !== 0) {
                const r = chain.dispatchRelease({ kind: "mod", bit });
                if (r.consume) consumed = true;
              }
            }
            // Released a non-mod key? Dispatch the release for the same
            // (base) keysym the press matched on, so a press/release pair
            // tracks consistently regardless of Shift.
            if (matchSym !== 0) {
              const r = chain.dispatchRelease({ kind: "key", keysym: matchSym });
              if (r.consume) consumed = true;
            }
          }
        }

        const kb = seat.kbFocus;
        if (!kb || consumed) return;
        // Forward to the focused client's keyboards. Raw evdev keycode;
        // client interprets via the keymap.
        const keySerial = ctx.state.serial();
        const state = pressed ? 1 : 0;
        for (const k of clientKeyboards(kb.clientId)) {
          if (k.destroyed) continue;
          ctx.events.wl_keyboard.send_key(k, keySerial, ev.time, ev.key ?? 0, state);
          const modSerial = ctx.state.serial();
          ctx.events.wl_keyboard.send_modifiers(
            k, modSerial, mods.modsDepressed, mods.modsLatched, mods.modsLocked, mods.group);
        }
        break;
      }
      case "keyboardModifiers": {
        // Real backends never send standalone modifier events -- modifiers are
        // derived from key presses in the keyboardKey case above. This path is
        // for a virtual keyboard's explicit modifiers request: set the device
        // keymap's xkb state directly from the supplied masks (so a subsequent
        // key resolves under them) and forward the canonical masks to the
        // focused client.
        activateKeymap(ev.keymapId ?? 0);
        const mods = ctx.addon.setModifiers(
          ev.modsDepressed ?? 0, ev.modsLatched ?? 0, ev.modsLocked ?? 0, ev.group ?? 0);
        lastModsDepressed = mods.modsDepressed;
        const kb = seat.kbFocus;
        if (!kb) break;
        for (const k of clientKeyboards(kb.clientId)) {
          if (k.destroyed) continue;
          const modSerial = ctx.state.serial();
          ctx.events.wl_keyboard.send_modifiers(
            k, modSerial, mods.modsDepressed, mods.modsLatched, mods.modsLocked, mods.group);
        }
        break;
      }
      // pointerFrame is coalesced above.
      default:
        break;
    }
  }

  // Called by the WM map sweep when a freshly-mapped toplevel gains
  // presentable content. The focus plugin decides whether to focus it.
  function focusWindow(
    surfaceId: number, _surfaceRec: { resource: Resource },
    _rect: { x: number; y: number; width: number; height: number },
  ): void {
    dispatchFocus("window-mapped", surfaceId, undefined);
  }

  // Re-derive the surface under the (stationary) pointer after the scene
  // changed beneath it -- a relayout swapped tiles, a workspace switch
  // replaced the stack. Produces the same leave/enter/motion sequence and
  // focus-policy dispatch a zero-length pointer motion would, so
  // follow-pointer keyboard focus and client hover state track scene
  // changes, not just device input. No-op while a move/resize grab or a
  // DnD drag owns the pointer, or while the host pointer is outside the
  // compositor.
  function repickPointer(): void {
    const seat = ctx.state.seat;
    if (!seat || seat.grab || seat.drag || !pointerInside) return;
    const hit = pick(lastX, lastY);
    const prevPointerSurface = seat.focus?.surfaceId ?? null;
    if (seat.focus && (!hit || hit.surfaceId !== seat.focus.surfaceId)) {
      sendLeave(seat.focus);
      seat.focus = null;
    }
    if (!hit) {
      notifyPointerFocus(ctx, null);
      if (prevPointerSurface !== null) {
        dispatchFocus("pointer-leave", undefined, null);
      }
      return;
    }
    const { sx, sy } = surfaceLocalCoords(hit, lastX, lastY);
    if (!seat.focus) {
      seat.focus = hit;
      sendEnter(hit, sx, sy);
    } else {
      // Same surface, but its rect may have moved under the pointer:
      // refresh the cached hit and the client's surface-local position.
      const pr = seat.focus.rect, nr = hit.rect;
      const moved = pr.x !== nr.x || pr.y !== nr.y
        || pr.width !== nr.width || pr.height !== nr.height;
      seat.focus = hit;
      if (moved && !isPointerLocked(ctx)) {
        for (const p of clientPointers(hit.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_motion(p, lastTime, sx, sy);
          pointerFrame(p);
        }
      }
    }
    notifyPointerFocus(ctx, hit.surfaceId);
    if (prevPointerSurface !== hit.surfaceId) {
      dispatchFocus("pointer-enter", hit.rootSurfaceId, hit.rootSurfaceId);
    }
  }

  ctx.state.seat = {
    pointersByClient, keyboardsByClient,
    focus: null, kbFocus: null, handleInput, focusWindow,
    applyKeyboardFocus,
    dispatchFocusEvent(reason, trigger) { dispatchFocus(reason, trigger); },
    pick,
    repickPointer,
    pointerPosition() { return { x: lastX, y: lastY }; },
    reevaluateExclusiveLayerFocus,
    drag: null,
    // Cursor handling shared with makePointer (set_cursor) and
    // wl_surface.commit (cursor-role surface texture refresh).
    cursor: cursorOps,
    // Begin a DnD pointer grab. While set, handleInput routes pointer motion/
    // button to these callbacks instead of wl_pointer (see handleInput). The
    // data-device module supplies onMotion/onButton and clears drag on drop/abort.
    beginDrag(d) {
      // Releasing the normal pointer focus so the dragged-over client doesn't
      // also get wl_pointer events (Wayland convention; some toolkits require it).
      if (seat0?.focus) { sendLeave(seat0.focus); seat0.focus = null; }
      if (seat0) seat0.drag = d;
    },
    endDrag() { if (seat0) seat0.drag = null; },
    grab: null,
    beginGrab(g) {
      if (!seat0 || seat0.grab) return;
      seat0.grab = g;
      // Release the pointer focus during the grab: motion events drive
      // geometry, not client wl_pointer; the focused client shouldn't
      // see a stale enter+motion sequence.
      if (seat0.focus) { sendLeave(seat0.focus); seat0.focus = null; }
      // Install the grab cursor shape (move / resize-corner). The
      // installGrabCursor hook is wired by main.ts to the cursor
      // broker's resolver; absent it (GPU-free tests), this is a
      // no-op.
      ctx.state.installGrabCursor?.(grabCursorShape(g));
    },
    endGrab() {
      if (!seat0) return;
      const ended = seat0.grab;
      seat0.grab = null;
      // Restore the default cursor. The hook is responsible for
      // routing this through the cursor broker's priority chain
      // (plugin override > client cursor > setDefault > theme default).
      ctx.state.installGrabCursor?.(null);
      // A move grab that ends is a DROP: report where (the pointer's
      // world position through the content camera -- drops land where
      // the cursor is, correct while fitted/roaming) and whether the
      // window was tiled before the grab floated it. The workspace
      // plugin's membership-on-drag policy consumes this (re-parent to
      // the island under the cursor; re-tile if it was managed).
      if (ended?.kind === "move") {
        const view = contentViewAt(lastX, lastY);
        ctx.state.pluginBus?.emit("window.drag-dropped", {
          surfaceId: ended.surfaceId,
          wasManaged: ended.wasManaged === true,
          x: seatViewToWorldX(view, lastX),
          y: seatViewToWorldY(view, lastY),
        });
      }
      // A camera-pan streamed transient camera writes; settle now with
      // one non-transient write of the final value (residency sweep +
      // X re-narration), then repick -- the world moved under a
      // stationary pointer, so enter/leave must track what's actually
      // under it rather than waiting for the next device motion.
      if (ended?.kind === "camera-pan") {
        const cam = ctx.state.outputCameras?.get(ended.outputId)
          ?? { x: 0, y: 0, zoom: 1 };
        ctx.state.compositor.setOutputCamera?.(
          ended.outputId, cam.x, cam.y, cam.zoom);
        repickPointer();
      }
      // After ending the grab, the next pointer motion will land an
      // enter on whichever surface is now under the pointer.
    },
    sweepDestroyed() {
      if (!seat0) return;
      // Release keys held by a virtual keyboard whose client disconnected
      // without lifting them, so a stuck modifier doesn't poison real input.
      releaseDeadVirtualKeyboards(ctx);
      sweepDestroyedSeatState(seat0, pointersByClient, keyboardsByClient,
        lastEnterSerial, clientCursors);
    },
    // Synchronous focus invalidation for a surface being torn down. Drops
    // kb/pointer focus records pointing at it WITHOUT sending leave (the
    // surface is gone; the sweep-based path would leave a stale record
    // live until the next frame, and any focus change in that window
    // would send leave referencing the destroyed resource).
    clearFocusForSurface(surfaceId) {
      if (!seat0) return;
      const kf = seat0.kbFocus;
      if (kf && (kf.surfaceId === surfaceId || kf.rootSurfaceId === surfaceId)) {
        seat0.kbFocus = null;
      }
      const pf = seat0.focus;
      if (pf && (pf.surfaceId === surfaceId || pf.rootSurfaceId === surfaceId)) {
        seat0.focus = null;
      }
    },
  };
  const seat0 = ctx.state.seat;

  return {
    // Global bind: advertise pointer + keyboard capabilities.
    bind(resource) {
      ctx.events.wl_seat.send_capabilities(resource, CAP.pointer | CAP.keyboard);
      // wl_seat.name is since v2. Sending it to a v1 bind aborts the client
      // ("listener function for opcode 1 of wl_seat is NULL").
      if (resource.version >= 2) ctx.events.wl_seat.send_name(resource, "seat0");
    },
    get_pointer(resource, pointer) {
      const clientId = ctx.addon.clientId(resource);
      clientPointers(clientId).add(pointer);
      pointer.__clientId = clientId;
    },
    get_keyboard(resource, keyboard) {
      const clientId = ctx.addon.clientId(resource);
      clientKeyboards(clientId).add(keyboard);
      keyboard.__clientId = clientId;
      // Send the keymap so the client can interpret keycodes. Each client gets
      // its own dup of the memfd (a WaylandFd; send_keymap takes the raw fd out).
      const km = ctx.addon.keymapInfo();
      if (km) {
        ctx.events.wl_keyboard.send_keymap(keyboard, km.format, km.fd, km.size);
      }
      // wl_keyboard.repeat_info is since v4.
      if (keyboard.version >= 4) ctx.events.wl_keyboard.send_repeat_info(keyboard, 25, 600);
    },
    get_touch(_resource, _touch) {},
    release(_resource) {},
  };
}

// wl_pointer / wl_keyboard child-resource handlers: just handle release/destroy.
export function makePointer(ctx: Ctx): WlPointerHandler {
  return {
    set_cursor(resource, serial, surface, hx, hy) {
      const seat = ctx.state.seat;
      if (!seat) return;
      // Validate against the most-recent enter serial for this
      // pointer resource. Stale requests (serial < latest enter) are
      // silently dropped per protocol convention. A missing entry means
      // no current enter for this resource (client never had focus, or
      // already left); also drop.
      const exp = seat.cursor.lastEnterSerialFor(resource);
      if (exp === undefined || serial < exp) return;

      const clientId = ctx.addon.clientId(resource);

      if (!surface) {
        // NULL surface => client wants no cursor over its surface.
        seat.cursor.setClientCursor(clientId, {
          surfaceResource: null,
          hotspotX: 0,
          hotspotY: 0,
          hidden: true,
        });
        return;
      }

      // Role lock: the surface is permanently bound to role "cursor".
      // The spec requires a surface have only one role for its lifetime.
      // Other role-attach paths (xdg_toplevel get_toplevel, subsurface,
      // popup) check sRec.role; reaching here from any of those with a
      // cursor-roled surface posts a protocol error THERE.
      const sRec = ctx.state.surfaces.get(surface);
      if (sRec) {
        if (sRec.role && sRec.role !== "cursor") {
          ctx.addon.postError(resource, WlPointer_Error.role,
            `wl_pointer.set_cursor: surface already has the "${sRec.role}" role`);
          return;
        }
        sRec.role = "cursor";
      }

      seat.cursor.setClientCursor(clientId, {
        surfaceResource: surface,
        hotspotX: hx,
        hotspotY: hy,
        hidden: false,
      });
    },
    release(resource) {
      const seat = ctx.state.seat;
      seat?.cursor.clearEnterSerial(resource);
      cleanup(ctx, resource);
    },
  };
}

export function makeKeyboard(ctx: Ctx): WlKeyboardHandler {
  return {
    release(resource) { cleanupKb(ctx, resource); },
  };
}

function cleanup(ctx: Ctx, resource: Resource): void {
  const seat = ctx.state.seat;
  if (!seat) return;
  const clientId = resource.__clientId as number | undefined;
  if (clientId === undefined) return;
  const set = seat.pointersByClient.get(clientId);
  if (set) set.delete(resource);
}
function cleanupKb(ctx: Ctx, resource: Resource): void {
  const seat = ctx.state.seat;
  if (!seat) return;
  for (const set of seat.keyboardsByClient.values()) set.delete(resource);
}
