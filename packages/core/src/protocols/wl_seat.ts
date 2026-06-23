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
import type { Ctx, SeatFocus } from "./ctx.js";
import { computeGrabRect } from "../input/grab-math.js";
import type { Resource, InputEvent } from "../types.js";
import { KEYBOARD_EVENT } from "../events/window-bus.js";
import { markWindowChanged } from "./window-changes.js";
import type { FocusDriver } from "./focus-driver.js";
import { hitTestSurfaceTree, type SurfaceHit } from "../surface-hit-test.js";
import { popupOutputOrigin } from "./xdg_popup.js";

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
  // Last-known modsDepressed mask, used to diff modifier-release events
  // for the binding chain's release callback path.
  let lastModsDepressed = 0;

  // Phase 9c cursor state. Shared with makePointer via ctx.state.seat
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
    const popup = pickPopup(x, y);
    if (popup) return popup;
    const win = pickToplevel(x, y);
    if (win) return win;
    return pickLayer(x, y, ["bottom", "background"]);
  }

  // Build a SeatFocus from a SurfaceHit produced by hitTestSurfaceTree.
  // The accepting surface may be the candidate root or any subsurface
  // descendant; either way, the hit carries the output-space rect of
  // the surface that actually accepted, so motion events can compute
  // surface-local coords against the right surface.
  function toFocus(hit: SurfaceHit): SeatFocus {
    const clientId = ctx.addon.clientId(hit.surfaceRec.resource);
    return {
      surfaceId: hit.surfaceRec.id,
      surfaceRec: hit.surfaceRec,
      clientId,
      rect: hit.rect,
    };
  }

  // WM-toplevel candidate. windowAt walks the visible toplevel order;
  // each toplevel's tree (toplevel + subsurfaces) is hit-tested in
  // turn. The acceptor on windowAt rejects toplevels whose ROOT input
  // region drops the point so windowAt keeps walking; the subsurface-
  // aware tree hit happens once windowAt returns a candidate.
  function pickToplevel(x: number, y: number): SeatFocus | null {
    const wm = ctx.state.wm;
    if (!wm) return null;
    // walked: per windowAt's accept callback, the toplevel is a
    // candidate iff its tree hits at all (root OR a subsurface).
    let bestHit: SurfaceHit | null = null;
    const win = wm.windowAt(x, y, (w) => {
      const root = ctx.state.surfaces.get(w.surfaceRec.resource);
      if (!root) return false;
      const hit = hitTestSurfaceTree(ctx.state, root, w.rect, x, y);
      if (!hit) return false;
      bestHit = hit;
      return true;
    });
    if (!win || !bestHit) return null;
    return toFocus(bestHit);
  }

  // Topmost mapped popup under the point, walking each popup's full
  // tree. Popups are above their parent toplevel; within the popup map
  // insertion order approximates parent-before-child, so iterate in
  // REVERSE so a child popup (a submenu) wins over its parent popup.
  function pickPopup(x: number, y: number): SeatFocus | null {
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
      const hit = hitTestSurfaceTree(ctx.state, root, rect, x, y);
      if (hit) return toFocus(hit);
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
        if (hit) return toFocus(hit);
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
  }

  // Build a SeatFocus for a surface id, handling WM toplevels (rect via
  // wm.getSnapshot), layer-shell surfaces (rect via state.layerSurfaces),
  // and xwayland override-redirect overlays (rect via state.overrideRedirects).
  // Returns null when the surface is unknown or unmapped.
  function focusTargetFor(surfaceId: number): SeatFocus | null {
    const s = ctx.state.surfacesById?.get(surfaceId);
    if (!s || s.resource.destroyed) return null;
    const clientId = ctx.addon.clientId(s.resource);
    // Layer-shell first: the WM doesn't know about these.
    if (s.layerSurface?.rect) {
      const r = s.layerSurface.rect;
      return { surfaceId, surfaceRec: s, clientId, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    // Override-redirect xwayland overlay: rect tracked separately from the
    // WM (the overlay isn't in wm.state.windows). 3.4 will mirror focus to
    // X via SetInputFocus / WM_TAKE_FOCUS; this just exposes the rect so
    // the seat can deliver wl_keyboard.enter to the menu's wl_surface.
    if (s.role === "xwayland") {
      const orRect = ctx.state.overrideRedirects?.get(surfaceId);
      if (orRect) {
        return { surfaceId, surfaceRec: s, clientId, rect: { ...orRect } };
      }
    }
    const snap = ctx.state.wm?.getSnapshot(surfaceId);
    if (!snap) return null;
    return { surfaceId, surfaceRec: s, clientId, rect: snap.rect };
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
      // Phase 9c: stash the enter serial per pointer resource so a
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
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_leave(p, serial, target.surfaceRec.resource);
      // Clear the recorded enter serial so a late set_cursor for the
      // prior focus is rejected.
      lastEnterSerial.delete(p);
      pointerFrame(p);
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
      : (seat?.focus?.surfaceId ?? null);
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

  // Apply a pointer-motion event to an active grab: compute the new
  // floating rect from the grab's anchor + startRect + current pointer
  // position, then push it to the WM.
  function applyGrabMotion(g: import("./ctx.js").PointerGrab, x: number, y: number): void {
    const ws = ctx.state.wm?.getWindowState(g.surfaceId) ?? null;
    const rect = computeGrabRect(g, x, y, ws?.constraints ?? null);
    ctx.state.wm?.setFloatingRect(g.surfaceId, rect);
  }

  // Route one normalized input event.
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
        // Move the software cursor with the pointer (Phase 9c). The
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
          if (prevPointerSurface !== null) {
            dispatchFocus("pointer-leave", undefined, null);
          }
          return;
        }
        // Surface-local coords are relative to the wl_surface's
        // origin, which (for CSD clients with set_window_geometry) is
        // NOT the same as the WM-assigned content rect's origin: the
        // geometry rect declares a sub-region of the buffer, so the
        // visible top-left of the window corresponds to surface-local
        // (geom.x, geom.y), not (0, 0). Add the offset back.
        const goff = surfaceGeometryOffset(ctx, hit.surfaceRec.resource);
        const sx = (x - hit.rect.x) + goff.x;
        const sy = (y - hit.rect.y) + goff.y;
        if (!seat.focus) {
          seat.focus = hit;
          sendEnter(hit, sx, sy);
        } else {
          for (const p of clientPointers(hit.clientId)) {
            if (p.destroyed) continue;
            ctx.events.wl_pointer.send_motion(p, ev.time, sx, sy);
            pointerFrame(p);
          }
        }
        // Focus dispatch only on surface change (coarse event), not per
        // motion within the same surface.
        if (prevPointerSurface !== hit.surfaceId) {
          dispatchFocus("pointer-enter", hit.surfaceId, hit.surfaceId);
        }
        break;
      }
      case "pointerLeave": {
        const prev = seat.focus?.surfaceId ?? null;
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
        if (consumed) return;

        // While a grab is active, button events are not forwarded to the
        // client (the user is manipulating compositor geometry, not the
        // client). The binding chain still saw the event above, so the
        // grab's release callback gets to fire normally.
        //
        // Protocol-initiated grabs (xdg_toplevel.move/.resize) set
        // endOnButtonUp: the seat auto-ends the grab on the next
        // button release. Hotkey-initiated grabs leave it false (the
        // binding chain's release callback ends them via the
        // window.end-grab action).
        if (seat.grab) {
          if (!ev.pressed && seat.grab.endOnButtonUp) {
            seat.endGrab();
          }
          return;
        }

        if (!seat.focus) return;
        const serial = ctx.state.serial();
        const state = ev.pressed ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_button(p, serial, ev.time, button, state);
          pointerFrame(p);
        }
        if (ev.pressed) {
          dispatchFocus("pointer-button", seat.focus.surfaceId, seat.focus.surfaceId);
          // Click-to-raise: a press on a toplevel's content surface
          // raises it (and its modal subtree, redirecting up the
          // chain if the press landed on a modal dialog). Focus and
          // raise are decoupled here on purpose; a pointer-follows-
          // focus policy can still walk over windows without
          // reordering them.
          ctx.state.wm?.raiseWindow(seat.focus.surfaceId);
        }
        break;
      }
      case "pointerAxis": {
        if (!seat.focus) return;
        // wl_pointer.axis: 0 = vertical, 1 = horizontal (matches ev.horizontal).
        const axis = ev.horizontal ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_axis(p, ev.time, axis, ev.value ?? 0);
          pointerFrame(p);
        }
        break;
      }
      case "keyboardKey": {
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
        const chain = ctx.state.bindingChain;
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
      // keyboardModifiers from the host is not forwarded separately; we derive
      // modifiers from key events via xkb. pointerFrame is coalesced above.
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

  ctx.state.seat = {
    pointersByClient, keyboardsByClient,
    focus: null, kbFocus: null, handleInput, focusWindow,
    applyKeyboardFocus,
    dispatchFocusEvent(reason, trigger) { dispatchFocus(reason, trigger); },
    pick,
    pointerPosition() { return { x: lastX, y: lastY }; },
    reevaluateExclusiveLayerFocus,
    drag: null,
    // Phase 9c: cursor handling shared with makePointer (set_cursor) and
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
      seat0.grab = null;
      // Restore the default cursor. The hook is responsible for
      // routing this through the cursor broker's priority chain
      // (plugin override > client cursor > setDefault > theme default).
      ctx.state.installGrabCursor?.(null);
      // After ending the grab, the next pointer motion will land an
      // enter on whichever surface is now under the pointer.
    },
    sweepDestroyed() {
      if (!seat0) return;
      sweepDestroyedSeatState(seat0, pointersByClient, keyboardsByClient);
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
      // Phase 9c: validate against the most-recent enter serial for this
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
