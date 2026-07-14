// wl_data_device_manager / wl_data_device / wl_data_source / wl_data_offer:
// clipboard (selection) AND drag-and-drop are implemented.
//
// DnD: start_drag takes a seat pointer grab; pointer motion drives
// data_device enter/motion/leave to the surface under the pointer (minting a
// fresh data_offer per enter); accept/set_actions negotiate the action
// (negotiateDndAction); a button release over an accepting target sends drop and
// the same receive->send fd transfer as clipboard, then finish -> dnd_finished.
// A drag-icon surface (if given) is composited following the pointer.
// FLAGGED: the drag-icon path is implemented but not yet covered by a test (the
// DnD test uses a NULL icon); everything else is verified by test/dnd.gpu.mjs.
//
// Selection flow (copy/paste):
//   source client: create_data_source -> offer(mime)... -> set_selection(src)
//   compositor: store selection; to the KEYBOARD-FOCUSED client's data_device,
//     send data_offer(new wl_data_offer) -> offer(mime)... -> selection(offer).
//   receiver: data_offer.receive(mime, pipe-write-fd)
//   compositor: forward to the source via data_source.send(mime, fd)
//   source writes the bytes into fd; receiver reads its pipe.

import type { WlDataDeviceManagerHandler } from "#protocols-gen/wl_data_device_manager.js";
import type { WlDataDeviceHandler } from "#protocols-gen/wl_data_device.js";
import type { WlDataSourceHandler } from "#protocols-gen/wl_data_source.js";
import type { WlDataOfferHandler } from "#protocols-gen/wl_data_offer.js";
import type { ZwpPrimarySelectionDeviceManagerV1Handler } from "#protocols-gen/zwp_primary_selection_device_manager_v1.js";
import type { ZwpPrimarySelectionDeviceV1Handler } from "#protocols-gen/zwp_primary_selection_device_v1.js";
import type { ZwpPrimarySelectionSourceV1Handler } from "#protocols-gen/zwp_primary_selection_source_v1.js";
import type { ZwpPrimarySelectionOfferV1Handler } from "#protocols-gen/zwp_primary_selection_offer_v1.js";
import type { Ctx } from "./ctx.js";
import { seatViewToWorldX, seatViewToWorldY } from "./ctx.js";
import type { Resource, WaylandFd } from "../types.js";
import { KEYBOARD_EVENT, SELECTION_EVENT } from "../events/window-bus.js";

// Tell a source it lost ownership of a selection slot (the spec's
// "cancelled" on replacement). The selection state is shared across all three
// selection protocols, so the displaced source may belong to any of them --
// dispatch the cancelled event by the resource's interface. No-op if the slot
// is unchanged or the source is the same one re-asserting.
export function cancelDisplacedSource(
  ctx: Ctx, prev: Resource | null, replacement: Resource | null,
): void {
  if (!prev || prev === replacement || prev.destroyed) return;
  switch (prev.interfaceName) {
    case "wl_data_source":
      ctx.events.wl_data_source.send_cancelled(prev); break;
    case "zwp_primary_selection_source_v1":
      ctx.events.zwp_primary_selection_source_v1.send_cancelled(prev); break;
    case "ext_data_control_source_v1":
      ctx.events.ext_data_control_source_v1.send_cancelled(prev); break;
    case "zwlr_data_control_source_v1":
      ctx.events.zwlr_data_control_source_v1.send_cancelled(prev); break;
  }
}

// Forward a receive() request to the source backing an offer. Like
// cancelDisplacedSource, the source may belong to any of the selection
// protocols (a data-control client's source can own the clipboard that a
// wl_data_device client pastes from), so the send event must be dispatched
// by the resource's interface -- each family's `send` has a different
// opcode, and posting through the wrong sender emits a different event
// entirely on the recipient's interface.
//
// Fd ownership: send_send takes a dup (libwayland owns it once the event is
// queued); the request fd itself is CLOSED here -- the dispatcher owns it
// and nothing else will close it. A merely-taken fd would hold the
// receiver's pipe write-end open forever, so the reading client never sees
// EOF after the source finishes writing.
export function forwardReceiveToSource(
  ctx: Ctx, source: Resource | null, mimeType: string, fd: WaylandFd,
): void {
  if (source && !source.destroyed) {
    switch (source.interfaceName) {
      case "wl_data_source":
        ctx.events.wl_data_source.send_send(source, mimeType, fd.dup()); break;
      case "zwp_primary_selection_source_v1":
        ctx.events.zwp_primary_selection_source_v1.send_send(source, mimeType, fd.dup()); break;
      case "ext_data_control_source_v1":
        ctx.events.ext_data_control_source_v1.send_send(source, mimeType, fd.dup()); break;
      case "zwlr_data_control_source_v1":
        ctx.events.zwlr_data_control_source_v1.send_send(source, mimeType, fd.dup()); break;
    }
  }
  fd.close();
}

// Map a wl_data_offer resource back to the source it represents, so receive() can
// forward to the right source. Lives module-scope (keyed by offer resource).
const offerToSource = new WeakMap<Resource, Resource>();

// X-backed offers (clipboard or primary). When set, wl_data_offer.receive /
// primary receive on the offer routes to the selection bridge instead of
// forwarding to a wl source. Keyed by the offer resource.
const xBackedOffer = new WeakMap<Resource, "clipboard" | "primary">();

// dnd_action enum (wl_data_device_manager): none=0, copy=1, move=2, ask=4.
const DND = { none: 0, copy: 1, move: 2, ask: 4 } as const;

// Active drag-and-drop session (at most one). Lives module-scope.
interface DragSession {
  ctx: Ctx;
  source: Resource | null;      // wl_data_source being dragged (null = internal)
  sourceActions: number;        // actions the source declared (set_actions)
  icon: Resource | null;        // optional drag-icon wl_surface
  // The data_device of the client currently under the pointer + its surface.
  focusDevice: Resource | null;
  focusClientId: number | null;
  focusSurfaceId: number | null;
  offer: Resource | null;       // the data_offer minted for the current focus
  offerAccepted: boolean;       // receiver called accept(mime)
  offerActions: number;         // receiver's set_actions mask
  offerPreferred: number;       // receiver's preferred action
  dropped: boolean;
}
let drag: DragSession | null = null;

// Map a drag data_offer back to its drag session, so accept/set_actions/finish
// on the offer reach the session.
const dragOfferSession = new WeakMap<Resource, DragSession>();

// Compute the negotiated DnD action from masks: intersect source + receiver;
// honor the receiver's preferred if it is in the intersection, else copy>move>ask.
// Exported for unit testing (the pure negotiation logic).
export function negotiateDndAction(sourceActions: number, offerActions: number, offerPreferred: number): number {
  const common = sourceActions & offerActions;
  if (common === 0) return DND.none;
  if (offerPreferred && (common & offerPreferred)) return offerPreferred;
  if (common & DND.copy) return DND.copy;
  if (common & DND.move) return DND.move;
  if (common & DND.ask) return DND.ask;
  return DND.none;
}
function negotiate(d: DragSession): number {
  return negotiateDndAction(d.sourceActions, d.offerActions, d.offerPreferred);
}

// (Re)send the negotiated action to both the receiver's offer and the source.
// action is since 3 on both interfaces; a peer bound below v3 has no listener
// for the opcode and would be aborted, so gate on each resource's version.
function sendActions(d: DragSession): void {
  const action = negotiate(d);
  if (d.offer && !d.offer.destroyed && d.offer.version >= 3)
    d.ctx.events.wl_data_offer.send_action(d.offer, action);
  if (d.source && !d.source.destroyed && d.source.version >= 3)
    d.ctx.events.wl_data_source.send_action(d.source, action);
}

// Send wl_data_device.leave to the currently-focused client and clear focus.
function dragLeave(d: DragSession): void {
  if (d.focusDevice && !d.focusDevice.destroyed)
    d.ctx.events.wl_data_device.send_leave(d.focusDevice);
  if (d.offer) dragOfferSession.delete(d.offer);
  d.focusDevice = null; d.focusClientId = null; d.focusSurfaceId = null;
  d.offer = null; d.offerAccepted = false; d.offerActions = 0; d.offerPreferred = 0;
}

// Pointer moved during a drag (from the seat grab). Enter/leave/motion to the
// surface under the pointer, minting a fresh data_offer on each new enter.
function dragMotion(d: DragSession, x: number, y: number,
                    hit: { surfaceId: number; clientId: number;
                           rect: { x: number; y: number };
                           view: import("./ctx.js").SeatViewTransform } | null): void {
  // Move the drag icon (if any) to follow the pointer.
  updateDragIcon(d, x, y);

  if (!hit) { if (d.focusSurfaceId != null) dragLeave(d); return; }

  if (d.focusSurfaceId !== hit.surfaceId) {
    // Entered a new surface: leave the old, mint an offer for the new client.
    if (d.focusSurfaceId != null) dragLeave(d);
    const devices = d.ctx.state.dataDevices?.get(hit.clientId);
    if (!devices || devices.size === 0) return; // client has no data_device
    const device = [...devices].find((r) => !r.destroyed);
    if (!device) return;
    const mimes = d.source ? (d.ctx.state.dataSources?.get(d.source)?.mimes ?? []) : [];
    const offer = d.ctx.events.wl_data_device.send_data_offer(device, null) as Resource;
    if (!offer) return;
    dragOfferSession.set(offer, d);
    offerToSource.set(offer, d.source as Resource);
    for (const mime of mimes) d.ctx.events.wl_data_offer.send_offer(offer, mime);
    // source_actions tells the receiver what the source supports (since 3;
    // skip for a receiver bound below v3, which has no listener for it).
    if (d.source && offer.version >= 3)
      d.ctx.events.wl_data_offer.send_source_actions(offer, d.sourceActions);
    d.focusDevice = device; d.focusClientId = hit.clientId; d.focusSurfaceId = hit.surfaceId;
    d.offer = offer;
    const serial = d.ctx.state.serial();
    const surfaceRec = d.ctx.state.surfacesById?.get(hit.surfaceId);
    // X target surfaces use oversized buffers (see docs/xwayland-design.md
    // "HiDPI"); X clients expect surface-local coords in those oversized
    // pixels. Other roles pass through 1:1.
    const xn = surfaceRec?.role === "xwayland" ? (d.ctx.state.xwaylandScale ?? 1) : 1;
    // hit.rect is in the hit's own space (world for content, glass for layer
    // trees); re-apply the view transform the hit was made with.
    const sx = (seatViewToWorldX(hit.view, x) - hit.rect.x) * xn;
    const sy = (seatViewToWorldY(hit.view, y) - hit.rect.y) * xn;
    if (surfaceRec)
      d.ctx.events.wl_data_device.send_enter(device, serial, surfaceRec.resource, sx, sy, offer);
  } else if (d.focusDevice && !d.focusDevice.destroyed) {
    const surfaceRec = d.focusSurfaceId !== null
      ? d.ctx.state.surfacesById?.get(d.focusSurfaceId) : null;
    const xn = surfaceRec?.role === "xwayland" ? (d.ctx.state.xwaylandScale ?? 1) : 1;
    const sx = (seatViewToWorldX(hit.view, x) - hit.rect.x) * xn;
    const sy = (seatViewToWorldY(hit.view, y) - hit.rect.y) * xn;
    d.ctx.events.wl_data_device.send_motion(d.focusDevice, 0, sx, sy);
  }
}

// Drop (pointer released). If a target accepted, send drop + let it receive;
// else abort (source.cancelled). Ends the seat grab either way.
function dragButtonReleased(d: DragSession): void {
  const success = d.focusDevice != null && d.offerAccepted && negotiate(d) !== DND.none;
  if (success && d.focusDevice && !d.focusDevice.destroyed) {
    d.ctx.events.wl_data_device.send_drop(d.focusDevice);
    // dnd_drop_performed is since 3.
    if (d.source && !d.source.destroyed && d.source.version >= 3)
      d.ctx.events.wl_data_source.send_dnd_drop_performed(d.source);
    d.dropped = true;
    // The receiver now receive()s + finish()es; we keep the session alive until
    // finish (handled in the offer.finish handler) to send dnd_finished.
    d.ctx.state.seat?.endDrag();
    hideDragIcon(d);
    return;
  }
  // Unsuccessful drop: leave + cancel.
  if (d.focusDevice) dragLeave(d);
  if (d.source && !d.source.destroyed) d.ctx.events.wl_data_source.send_cancelled(d.source);
  endDrag(d);
}

function endDrag(d: DragSession): void {
  d.ctx.state.seat?.endDrag();
  hideDragIcon(d);
  if (drag === d) drag = null;
}

// --- drag icon: composite the icon surface following the pointer (reuses the
// compositor placement/stack; the icon is drawn on top). ---
function updateDragIcon(d: DragSession, x: number, y: number): void {
  if (!d.icon || d.icon.destroyed) return;
  const rec = d.ctx.state.surfaces.get(d.icon);
  if (!rec) return;
  // Position the icon at the pointer, shifted by its accumulated buffer offset
  // (clients attach with a negative offset to place the grab point under the
  // cursor). Draws on top via the stack rebuild.
  d.ctx.state.compositor.setSurfaceLayout(
    rec.id, Math.round(x + (rec.offsetDx ?? 0)), Math.round(y + (rec.offsetDy ?? 0)), 0, 0);
  pushDragIconStack(d, rec.id);
}
function pushDragIconStack(d: DragSession, iconId: number): void {
  // Append the icon id above the current WM/subsurface stack so it draws last.
  // applySubsurfaces rebuilds the base stack; we add the icon on top here.
  const wm = d.ctx.state.wm;
  if (!wm) return;
  const base: number[] = [];
  for (const win of wm.state.windows) base.push(win.surfaceId);
  base.push(iconId);
  d.ctx.state.compositor.setStack(base);
}
function hideDragIcon(d: DragSession): void {
  if (!d.icon) return;
  const rec = d.ctx.state.surfaces.get(d.icon);
  if (rec) d.ctx.state.compositor.removeSurface(rec.id);
}

// Send the current selection to one client's data_device(s). Mints a
// wl_data_offer (server-side new_id event), advertises each mime, then points the
// client at it via selection(). If there is no selection, sends selection(null).
// Falls back to the Xwayland-backed source when no wl client owns the
// selection and an X client does.
function sendSelectionTo(ctx: Ctx, clientId: number): void {
  const devices = ctx.state.dataDevices?.get(clientId);
  if (!devices || devices.size === 0) return;
  const wlSource = ctx.state.selection ?? null;
  const xSource = ctx.state.xClipboardSource ?? null;
  const mimes = wlSource ? (ctx.state.dataSources?.get(wlSource)?.mimes ?? [])
              : xSource ? xSource.mimes : [];

  for (const device of devices) {
    if (device.destroyed) continue;
    if (!wlSource && !xSource) {
      ctx.events.wl_data_device.send_selection(device, null);
      continue;
    }
    // data_offer is an event carrying a server-minted new_id; postEvent returns
    // the new wl_data_offer resource. Pass null as the new_id slot -- the
    // trampoline treats a non-number new_id arg as "mint server-side".
    const offer = ctx.events.wl_data_device.send_data_offer(device, null) as Resource;
    if (!offer) continue;
    if (wlSource) offerToSource.set(offer, wlSource);
    else xBackedOffer.set(offer, "clipboard");
    for (const mime of mimes) ctx.events.wl_data_offer.send_offer(offer, mime);
    ctx.events.wl_data_device.send_selection(device, offer);
  }
}

// --- primary selection (zwp_primary_selection_*): same flow, separate state and
// interfaces (no DnD). ---
const primaryOfferToSource = new WeakMap<Resource, Resource>();

function sendPrimaryTo(ctx: Ctx, clientId: number): void {
  const devices = ctx.state.primaryDevices?.get(clientId);
  if (!devices || devices.size === 0) return;
  const wlSource = ctx.state.primarySelection ?? null;
  const xSource = ctx.state.xPrimarySource ?? null;
  const mimes = wlSource ? (ctx.state.primarySources?.get(wlSource)?.mimes ?? [])
              : xSource ? xSource.mimes : [];
  for (const device of devices) {
    if (device.destroyed) continue;
    if (!wlSource && !xSource) {
      ctx.events.zwp_primary_selection_device_v1.send_selection(device, null);
      continue;
    }
    const offer = ctx.events.zwp_primary_selection_device_v1
      .send_data_offer(device, null) as Resource;
    if (!offer) continue;
    if (wlSource) primaryOfferToSource.set(offer, wlSource);
    else xBackedOffer.set(offer, "primary");
    for (const mime of mimes) ctx.events.zwp_primary_selection_offer_v1.send_offer(offer, mime);
    ctx.events.zwp_primary_selection_device_v1.send_selection(device, offer);
  }
}

// The owner of a selection slot is gone (its source was destroyed
// explicitly, or its client disconnected and the per-frame sweep noticed).
// Clear the slot, rescind the X-side claim via the Xwayland selection
// bridge, broadcast to data-control observers, and re-push to the
// keyboard-focused client so it drops the now-dangling offer (falling back
// to an X-backed source when one exists).
export function selectionOwnerGone(ctx: Ctx, kind: "clipboard" | "primary"): void {
  const focusClient = ctx.state.seat?.kbFocus?.clientId;
  if (kind === "clipboard") {
    ctx.state.selection = null;
    ctx.state.onWlSelectionChanged?.("clipboard", null, "data");
    ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "clipboard" });
    if (focusClient != null) sendSelectionTo(ctx, focusClient);
  } else {
    ctx.state.primarySelection = null;
    ctx.state.onWlSelectionChanged?.("primary", null, "primary");
    ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "primary" });
    if (focusClient != null) sendPrimaryTo(ctx, focusClient);
  }
}

// Per-frame disconnect sweep (wired in installProtocols alongside the
// other protocol sweeps). A client that vanished ran none of the destroy
// handlers, so a selection it owned would stay claimed forever: every
// paste would EOF instantly and the X bridge would keep a phantom owner.
// Run the same owner-gone path as an explicit source destroy, and drop
// source records / device registrations keyed to destroyed resources.
export function sweepDataDeviceState(ctx: Ctx): void {
  if (ctx.state.selection?.destroyed) selectionOwnerGone(ctx, "clipboard");
  if (ctx.state.primarySelection?.destroyed) selectionOwnerGone(ctx, "primary");
  for (const m of [ctx.state.dataSources, ctx.state.primarySources]) {
    if (!m) continue;
    for (const r of [...m.keys()]) if (r.destroyed) m.delete(r);
  }
  for (const m of [ctx.state.dataDevices, ctx.state.primaryDevices,
                   ctx.state.dataControlDevices]) {
    if (!m) continue;
    for (const [cid, set] of [...m.entries()]) {
      for (const r of [...set]) if (r.destroyed) set.delete(r);
      if (set.size === 0) m.delete(cid);
    }
  }
}

export default function makeDataDeviceManager(ctx: Ctx): WlDataDeviceManagerHandler {
  // Expose the per-client push helpers so sibling protocol modules
  // (ext_data_control) can re-fan a selection change to the keyboard-
  // focused client without duplicating offer-minting code.
  ctx.state.sendSelectionToClient = (clientId) => sendSelectionTo(ctx, clientId);
  ctx.state.sendPrimaryToClient = (clientId) => sendPrimaryTo(ctx, clientId);

  // Resend BOTH selections to a client when it gains keyboard focus (selection
  // follows keyboard focus). Subscribe to the bus keyboard.focus event. The bus is
  // optional (GPU-free tests may omit it); subscribe only when present.
  ctx.state.bus?.on(KEYBOARD_EVENT.focus, ({ clientId }) => {
    if (clientId != null) { sendSelectionTo(ctx, clientId); sendPrimaryTo(ctx, clientId); }
  });
  // The Xwayland selection bridge fires this when an X client publishes a
  // selection: re-push to the focused wayland client so it sees the X-backed
  // offer. Composes with the bus subscription above for focus-driven pushes.
  // The bridge installs / clears state.onXSelectionAvailable; we set our own
  // closure once so subsequent installs land in the same path.
  const onX = (kind: "clipboard" | "primary"): void => {
    const focusClient = ctx.state.seat?.kbFocus?.clientId;
    if (focusClient == null) return;
    if (kind === "clipboard") sendSelectionTo(ctx, focusClient);
    else sendPrimaryTo(ctx, focusClient);
  };
  ctx.state.onXSelectionAvailable = onX;

  return {
    create_data_source(_resource, id) {
      (ctx.state.dataSources ??= new Map()).set(id, { mimes: [] });
    },
    get_data_device(_resource, id, _seat) {
      const clientId = ctx.addon.clientId(id);
      let set = ctx.state.dataDevices?.get(clientId);
      if (!set) { set = new Set(); (ctx.state.dataDevices ??= new Map()).set(clientId, set); }
      set.add(id);
    },
  };
}

export function makeDataDevice(ctx: Ctx): WlDataDeviceHandler {
  return {
    start_drag(_resource, source, _origin, icon, _serial) {
      // Begin a DnD session: take the seat pointer grab; pointer motion now drives
      // data_device enter/motion/leave to the surface under the pointer, and a
      // button release drops. (Serial validation is lenient here.)
      if (drag) endDrag(drag);
      const iconRec = icon ?? null;
      drag = {
        ctx, source: source ?? null,
        sourceActions: source ? (ctx.state.dataSources?.get(source)?.dndActions ?? 0) : 0,
        icon: iconRec,
        focusDevice: null, focusClientId: null, focusSurfaceId: null,
        offer: null, offerAccepted: false, offerActions: 0, offerPreferred: 0,
        dropped: false,
      };
      const d = drag;
      ctx.state.seat?.beginDrag({
        onMotion: (x, y, hit) => dragMotion(d, x, y, hit),
        onButton: (pressed) => { if (!pressed) dragButtonReleased(d); },
      });
    },
    set_selection(resource, source, _serial) {
      // Tell the displaced owner it lost the selection.
      cancelDisplacedSource(ctx, ctx.state.selection ?? null, source ?? null);
      ctx.state.selection = source ?? null;
      // Notify the Xwayland selection bridge so it can claim / release the
      // X side. No-op when no bridge is installed.
      ctx.state.onWlSelectionChanged?.("clipboard", source ?? null, "data");
      // Broadcast the change so any subscriber that bypasses keyboard-
      // focus gating (the data-control protocol) re-pushes its offers.
      ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "clipboard" });
      // Push to the currently keyboard-focused client (selection follows focus).
      const focusClient = ctx.state.seat?.kbFocus?.clientId;
      if (focusClient != null) sendSelectionTo(ctx, focusClient);
      else {
        // No focused client: also push to the setter's own client (some clients
        // expect to observe their own selection). Harmless if unfocused.
        const own = ctx.addon.clientId(resource);
        sendSelectionTo(ctx, own);
      }
    },
    release(resource) {
      const clientId = ctx.addon.clientId(resource);
      const set = ctx.state.dataDevices?.get(clientId);
      if (set) {
        set.delete(resource);
        if (set.size === 0) ctx.state.dataDevices?.delete(clientId);
      }
    },
  };
}

export function makeDataSource(ctx: Ctx): WlDataSourceHandler {
  return {
    offer(resource, mimeType) {
      const rec = ctx.state.dataSources?.get(resource);
      if (rec) rec.mimes.push(mimeType);
    },
    destroy(resource) {
      ctx.state.dataSources?.delete(resource);
      if (ctx.state.selection === resource) selectionOwnerGone(ctx, "clipboard");
    },
    set_actions(resource, dndActions) {
      // Source declares the DnD actions it supports (copy/move/ask).
      const rec = ctx.state.dataSources?.get(resource);
      if (rec) rec.dndActions = dndActions;
      if (drag && drag.source === resource) { drag.sourceActions = dndActions; sendActions(drag); }
    },
  };
}

export function makeDataOffer(ctx: Ctx): WlDataOfferHandler {
  return {
    accept(resource, _serial, mimeType) {
      // DnD: the receiver accepts (or rejects, mimeType=null) the offered type.
      const d = dragOfferSession.get(resource);
      if (d) {
        d.offerAccepted = mimeType != null;
        if (d.source && !d.source.destroyed && mimeType != null)
          ctx.events.wl_data_source.send_target(d.source, mimeType);
      }
    },
    receive(resource, mimeType, fd: WaylandFd) {
      // X-backed offers (an X client owns the clipboard): the dispatcher
      // owns the request fd; transfer it to the selection bridge, which
      // closes it after the X transfer completes.
      const xKind = xBackedOffer.get(resource);
      if (xKind && ctx.state.receiveForXSource) {
        ctx.state.receiveForXSource(xKind, mimeType, fd.takeRawFd());
        return;
      }
      forwardReceiveToSource(ctx, offerToSource.get(resource) ?? null, mimeType, fd);
    },
    destroy(resource) {
      offerToSource.delete(resource);
      dragOfferSession.delete(resource);
    },
    finish(resource) {
      // DnD complete: the receiver finished reading. Tell the source.
      const d = dragOfferSession.get(resource);
      if (d && d.dropped) {
        // dnd_finished is since 3.
        if (d.source && !d.source.destroyed && d.source.version >= 3)
          ctx.events.wl_data_source.send_dnd_finished(d.source);
        endDrag(d);
      }
    },
    set_actions(resource, dndActions, preferred) {
      const d = dragOfferSession.get(resource);
      if (d) { d.offerActions = dndActions; d.offerPreferred = preferred; sendActions(d); }
    },
  };
}

// --- primary-selection handlers (middle-click paste). No DnD on this protocol. ---

export function makePrimaryManager(ctx: Ctx): ZwpPrimarySelectionDeviceManagerV1Handler {
  return {
    create_source(_resource, id) {
      (ctx.state.primarySources ??= new Map()).set(id, { mimes: [] });
    },
    get_device(_resource, id, _seat) {
      const clientId = ctx.addon.clientId(id);
      let set = ctx.state.primaryDevices?.get(clientId);
      if (!set) { set = new Set(); (ctx.state.primaryDevices ??= new Map()).set(clientId, set); }
      set.add(id);
    },
    destroy(_resource) {},
  };
}

export function makePrimaryDevice(ctx: Ctx): ZwpPrimarySelectionDeviceV1Handler {
  return {
    set_selection(resource, source, _serial) {
      cancelDisplacedSource(ctx, ctx.state.primarySelection ?? null, source ?? null);
      ctx.state.primarySelection = source ?? null;
      ctx.state.onWlSelectionChanged?.("primary", source ?? null, "primary");
      ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "primary" });
      const focusClient = ctx.state.seat?.kbFocus?.clientId;
      if (focusClient != null) sendPrimaryTo(ctx, focusClient);
      else sendPrimaryTo(ctx, ctx.addon.clientId(resource));
    },
    destroy(resource) {
      const clientId = ctx.addon.clientId(resource);
      const set = ctx.state.primaryDevices?.get(clientId);
      if (set) {
        set.delete(resource);
        if (set.size === 0) ctx.state.primaryDevices?.delete(clientId);
      }
    },
  };
}

export function makePrimarySource(ctx: Ctx): ZwpPrimarySelectionSourceV1Handler {
  return {
    offer(resource, mimeType) {
      const rec = ctx.state.primarySources?.get(resource);
      if (rec) rec.mimes.push(mimeType);
    },
    destroy(resource) {
      ctx.state.primarySources?.delete(resource);
      if (ctx.state.primarySelection === resource) selectionOwnerGone(ctx, "primary");
    },
  };
}

export function makePrimaryOffer(ctx: Ctx): ZwpPrimarySelectionOfferV1Handler {
  return {
    receive(resource, mimeType, fd: WaylandFd) {
      const xKind = xBackedOffer.get(resource);
      if (xKind && ctx.state.receiveForXSource) {
        ctx.state.receiveForXSource(xKind, mimeType, fd.takeRawFd());
        return;
      }
      forwardReceiveToSource(ctx, primaryOfferToSource.get(resource) ?? null, mimeType, fd);
    },
    destroy(resource) { primaryOfferToSource.delete(resource); },
  };
}
