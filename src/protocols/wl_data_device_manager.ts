// wl_data_device_manager / wl_data_device / wl_data_source / wl_data_offer:
// the clipboard (selection) path is implemented. Drag-and-drop on these same
// interfaces is NOT yet implemented (start_drag / accept / finish / set_actions
// and the dnd events) -- those are LOUD no-ops (warn once) pinned by a test, so
// the gap is explicit, not silent. DnD is the next slice on this protocol.
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

let warnedDnd = false;
function warnDnd(what: string): void {
  if (!warnedDnd) {
    warnedDnd = true;
    console.warn(`[overdraw] wl_data_device.${what}: drag-and-drop is not implemented (clipboard only).`);
  }
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
    start_drag(_resource, _source, _origin, _icon, _serial) { warnDnd("start_drag"); },
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
    set_actions(_resource, _dndActions) { warnDnd("source.set_actions"); },
  };
}

export function makeDataOffer(ctx: Ctx): WlDataOfferHandler {
  return {
    accept(_resource, _serial, _mimeType) { warnDnd("offer.accept"); },
    receive(resource, mimeType, fd: WaylandFd) {
      // Forward the receiver's pipe write-fd to the source: data_source.send.
      // The WaylandFd is consumed by the event encoder (takeWaylandFd).
      const source = offerToSource.get(resource);
      if (source && !source.destroyed) {
        ctx.events.wl_data_source.send_send(source, mimeType, fd);
      } else {
        // No source: close the fd so the receiver sees EOF rather than hanging.
        try { fd.close(); } catch { /* already closed */ }
      }
    },
    destroy(resource) { offerToSource.delete(resource); },
    finish(_resource) { warnDnd("offer.finish"); },
    set_actions(_resource, _dndActions, _preferred) { warnDnd("offer.set_actions"); },
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
