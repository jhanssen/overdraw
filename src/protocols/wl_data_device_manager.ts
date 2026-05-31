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
import type { Resource, WaylandFd } from "../types.js";

// Map a wl_data_offer resource back to the source it represents, so receive() can
// forward to the right source. Lives module-scope (keyed by offer resource).
const offerToSource = new WeakMap<Resource, Resource>();

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
function sendActions(d: DragSession): void {
  const action = negotiate(d);
  if (d.offer && !d.offer.destroyed)
    d.ctx.events.wl_data_offer.send_action(d.offer, action);
  if (d.source && !d.source.destroyed)
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
                           rect: { x: number; y: number } } | null): void {
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
    const offer = d.ctx.events.wl_data_device.send_data_offer(device, null) as unknown as Resource;
    if (!offer) return;
    dragOfferSession.set(offer, d);
    offerToSource.set(offer, d.source as Resource);
    for (const mime of mimes) d.ctx.events.wl_data_offer.send_offer(offer, mime);
    // source_actions tells the receiver what the source supports.
    if (d.source) d.ctx.events.wl_data_offer.send_source_actions(offer, d.sourceActions);
    d.focusDevice = device; d.focusClientId = hit.clientId; d.focusSurfaceId = hit.surfaceId;
    d.offer = offer;
    const serial = d.ctx.state.serial();
    const surfaceRec = d.ctx.state.surfacesById?.get(hit.surfaceId);
    const sx = x - hit.rect.x, sy = y - hit.rect.y;
    if (surfaceRec)
      d.ctx.events.wl_data_device.send_enter(device, serial, surfaceRec.resource, sx, sy, offer);
  } else if (d.focusDevice && !d.focusDevice.destroyed) {
    const sx = x - hit.rect.x, sy = y - hit.rect.y;
    d.ctx.events.wl_data_device.send_motion(d.focusDevice, 0, sx, sy);
  }
}

// Drop (pointer released). If a target accepted, send drop + let it receive;
// else abort (source.cancelled). Ends the seat grab either way.
function dragButtonReleased(d: DragSession): void {
  const success = d.focusDevice != null && d.offerAccepted && negotiate(d) !== DND.none;
  if (success && d.focusDevice && !d.focusDevice.destroyed) {
    d.ctx.events.wl_data_device.send_drop(d.focusDevice);
    if (d.source && !d.source.destroyed)
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
  // Position the icon at the pointer; it draws on top via the stack rebuild.
  d.ctx.addon.setSurfaceLayout(rec.id, Math.round(x), Math.round(y), 0, 0);
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
  d.ctx.addon.setStack(base);
}
function hideDragIcon(d: DragSession): void {
  if (!d.icon) return;
  const rec = d.ctx.state.surfaces.get(d.icon);
  if (rec) d.ctx.addon.removeSurface(rec.id);
}

// Send the current selection to one client's data_device(s). Mints a
// wl_data_offer (server-side new_id event), advertises each mime, then points the
// client at it via selection(). If there is no selection, sends selection(null).
function sendSelectionTo(ctx: Ctx, clientId: number): void {
  const devices = ctx.state.dataDevices?.get(clientId);
  if (!devices || devices.size === 0) return;
  const source = ctx.state.selection ?? null;
  const mimes = source ? (ctx.state.dataSources?.get(source)?.mimes ?? []) : [];

  for (const device of devices) {
    if (device.destroyed) continue;
    if (!source) {
      ctx.events.wl_data_device.send_selection(device, null);
      continue;
    }
    // data_offer is an event carrying a server-minted new_id; postEvent returns
    // the new wl_data_offer resource (see trampoline). Pass null as the new_id
    // slot -- the trampoline treats a non-number new_id arg as "mint server-side".
    const offer = ctx.events.wl_data_device.send_data_offer(device, null) as unknown as Resource;
    if (!offer) continue;
    offerToSource.set(offer, source);
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
  const source = ctx.state.primarySelection ?? null;
  const mimes = source ? (ctx.state.primarySources?.get(source)?.mimes ?? []) : [];
  for (const device of devices) {
    if (device.destroyed) continue;
    if (!source) {
      ctx.events.zwp_primary_selection_device_v1.send_selection(device, null);
      continue;
    }
    const offer = ctx.events.zwp_primary_selection_device_v1
      .send_data_offer(device, null) as unknown as Resource;
    if (!offer) continue;
    primaryOfferToSource.set(offer, source);
    for (const mime of mimes) ctx.events.zwp_primary_selection_offer_v1.send_offer(offer, mime);
    ctx.events.zwp_primary_selection_device_v1.send_selection(device, offer);
  }
}

export default function makeDataDeviceManager(ctx: Ctx): WlDataDeviceManagerHandler {
  // Resend BOTH selections to a client when it gains keyboard focus (selection
  // follows keyboard focus). The seat is created during installProtocols before
  // globals are wired; defer hook registration a tick so it's present.
  queueMicrotask(() => {
    if (ctx.state.seat) {
      ctx.state.seat.onKbFocusChange = (clientId) => {
        if (clientId != null) { sendSelectionTo(ctx, clientId); sendPrimaryTo(ctx, clientId); }
      };
    }
  });

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
      ctx.state.selection = source ?? null;
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
    release(_resource) {},
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
      if (ctx.state.selection === resource) ctx.state.selection = null;
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
      // Forward the receiver's pipe write-fd to the source: data_source.send.
      // The WaylandFd is consumed by the event encoder (takeWaylandFd). Used by
      // both clipboard and DnD (the offer->source map is shared).
      const source = offerToSource.get(resource);
      if (source && !source.destroyed) {
        ctx.events.wl_data_source.send_send(source, mimeType, fd);
      } else {
        try { fd.close(); } catch { /* already closed */ }
      }
    },
    destroy(resource) {
      offerToSource.delete(resource);
      dragOfferSession.delete(resource);
    },
    finish(resource) {
      // DnD complete: the receiver finished reading. Tell the source.
      const d = dragOfferSession.get(resource);
      if (d && d.dropped) {
        if (d.source && !d.source.destroyed) ctx.events.wl_data_source.send_dnd_finished(d.source);
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
      ctx.state.primarySelection = source ?? null;
      const focusClient = ctx.state.seat?.kbFocus?.clientId;
      if (focusClient != null) sendPrimaryTo(ctx, focusClient);
      else sendPrimaryTo(ctx, ctx.addon.clientId(resource));
    },
    destroy(_resource) {},
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
      if (ctx.state.primarySelection === resource) ctx.state.primarySelection = null;
    },
  };
}

export function makePrimaryOffer(ctx: Ctx): ZwpPrimarySelectionOfferV1Handler {
  return {
    receive(resource, mimeType, fd: WaylandFd) {
      const source = primaryOfferToSource.get(resource);
      if (source && !source.destroyed) {
        ctx.events.zwp_primary_selection_source_v1.send_send(source, mimeType, fd);
      } else {
        try { fd.close(); } catch { /* already closed */ }
      }
    },
    destroy(resource) { primaryOfferToSource.delete(resource); },
  };
}
