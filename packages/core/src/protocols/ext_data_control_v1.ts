// Data-control: clipboard + primary-selection control for clients that
// bypass keyboard focus. Used by wl-clipboard (wl-copy / wl-paste),
// clipboard managers, and scripted automation -- anything that needs to
// read or set the current selection without holding wl_keyboard focus.
//
// This module serves BOTH wire families: ext_data_control_v1 and the
// legacy zwlr_data_control_v1 (wl-clipboard <= 2.2.1 and older clipboard
// managers bind only the latter; without it wl-copy maps an invisible
// toplevel to grab focus, which a tiler reflows around). The two
// protocols are request/event-identical for everything here; the shared
// slot machinery (selection-slot.ts) picks senders per resource by
// interface name, including zwlr's since-version-2 gate on
// primary_selection (a v1 zwlr device is skipped for primary pushes).
//
// Differences vs. wl_data_device_manager:
//   - Per-client device receives BOTH selections (clipboard + primary).
//   - All bound devices are re-pushed on every selection change; there
//     is no focus gating. We subscribe once to selection.changed and
//     re-emit per bound device.
//   - No drag-and-drop; the handler never advertises DnD actions.
//
// State of truth: the existing wl_data_device state on CompositorState
// (state.selection / state.primarySelection / xClipboardSource /
// xPrimarySource and the per-source mime list). We do NOT mirror state
// into a parallel structure -- a control source claiming the selection
// calls state.onWlSelectionChanged (so the X bridge mirrors it) and the
// resulting state push fans out to every other bound device via the
// shared selection.changed bus event.
//
// Spec atomicity: the protocol requires the burst (data_offer ->
// per-mime offer events -> selection / primary_selection) to arrive
// without intermixed events from another selection. Each burst is sent
// inline within the single bus subscriber, so libwayland flushes them
// as a unit.

import type { Resource, WaylandFd } from "../types.js";
import type { Ctx } from "./ctx.js";
import type { SlotKind } from "./selection-slot.js";
import { SELECTION_EVENT } from "../events/window-bus.js";
import {
  SLOT, claimSlot, dropOffer, pushSlotToDevice, receiveFromOffer,
  selectionOwnerGone,
} from "./selection-slot.js";

import type { ExtDataControlManagerV1Handler }
  from "#protocols-gen/ext_data_control_manager_v1.js";
import type { ExtDataControlDeviceV1Handler }
  from "#protocols-gen/ext_data_control_device_v1.js";
import type { ExtDataControlSourceV1Handler }
  from "#protocols-gen/ext_data_control_source_v1.js";
import type { ExtDataControlOfferV1Handler }
  from "#protocols-gen/ext_data_control_offer_v1.js";

// Devices we've bound, keyed by client id. We re-push on every
// selection.changed; closing a device drops it from the set.
function devicesFor(ctx: Ctx, clientId: number): Set<Resource> {
  const all = (ctx.state.dataControlDevices ??= new Map<number, Set<Resource>>());
  let s = all.get(clientId);
  if (!s) { s = new Set<Resource>(); all.set(clientId, s); }
  return s;
}

// The single bus subscription. Installed lazily the first time
// makeManager runs; later installs replace the previous closure (idempotent
// for fresh ctx instances in tests).
function ensureSubscription(ctx: Ctx): void {
  if (ctx.state.dataControlBusInstalled) return;
  ctx.state.dataControlBusInstalled = true;
  ctx.state.bus?.on(SELECTION_EVENT.changed, ({ kind }) => {
    const all = ctx.state.dataControlDevices;
    if (!all) return;
    for (const set of all.values()) {
      for (const device of [...set]) {
        if (device.destroyed) { set.delete(device); continue; }
        pushSlotToDevice(ctx, kind, device);
      }
    }
  });
}

// Control sources live in the slot source maps alongside wl sources so
// every consumer (fan-out, X bridge, receive forwarding) sees them
// uniformly. create_data_source parks the record in dataSources; when a
// set_selection / set_primary_selection claims a slot, the record is
// adopted into that slot's map (moved from the other slot's map if it
// was parked there), so a source is never in both maps at once.
function adoptSourceRecord(ctx: Ctx, kind: SlotKind, source: Resource): void {
  const into = SLOT[kind].ensureSources(ctx);
  if (into.has(source)) return;
  const from = SLOT[kind === "clipboard" ? "primary" : "clipboard"].sources(ctx);
  const rec = from?.get(source);
  if (from && rec) { from.delete(source); into.set(source, rec); }
  else into.set(source, { mimes: [] });
}

export default function makeExtDataControlManager(ctx: Ctx): ExtDataControlManagerV1Handler {
  ensureSubscription(ctx);
  return {
    create_data_source(_resource, id) {
      (ctx.state.dataSources ??= new Map()).set(id, { mimes: [] });
    },
    get_data_device(_resource, id, _seat) {
      const clientId = ctx.addon.clientId(id);
      devicesFor(ctx, clientId).add(id);
      // Seed the device with the current selections so a client that
      // binds late doesn't see "empty until something changes."
      pushSlotToDevice(ctx, "clipboard", id);
      pushSlotToDevice(ctx, "primary", id);
    },
    destroy(_resource) { /* destructor */ },
  };
}

export function makeExtDataControlDevice(ctx: Ctx): ExtDataControlDeviceV1Handler {
  function consume(resource: Resource, source: Resource | null, kind: SlotKind): void {
    // The spec forbids reusing a source in a second set_selection /
    // set_primary_selection (and offering more mimes after use), but real
    // clients (some clipboard managers) do both; killing them over it is worse
    // than tolerating it, so we accept it rather than post the protocol error.
    if (source) adoptSourceRecord(ctx, kind, source);
    // Hand the source to the shared selection state. From this point
    // every wl_data_device-side path (focus push, X bridge mirror, etc.)
    // sees it as the current source; the bus emit inside claimSlot fans
    // the change out to every bound control device.
    claimSlot(ctx, kind, source);
    // Re-push to the keyboard-focused wl-family client (falling back to
    // the setter's own client) via the hooks wl_data_device_manager
    // installs; silent no-ops before that module's bring-up.
    const focusClient = ctx.state.seat?.kbFocus?.clientId;
    const target = focusClient ?? ctx.addon.clientId(resource);
    if (kind === "clipboard") ctx.state.sendSelectionToClient?.(target);
    else ctx.state.sendPrimaryToClient?.(target);
  }

  return {
    set_selection(resource, source) {
      consume(resource, source ?? null, "clipboard");
    },
    set_primary_selection(resource, source) {
      consume(resource, source ?? null, "primary");
    },
    destroy(resource) {
      const clientId = ctx.addon.clientId(resource);
      ctx.state.dataControlDevices?.get(clientId)?.delete(resource);
    },
  };
}

export function makeExtDataControlSource(ctx: Ctx): ExtDataControlSourceV1Handler {
  return {
    offer(resource, mimeType) {
      // The source could be in either slot's map by the time mimes
      // arrive (mostly they arrive BEFORE set_selection, but mid-stream
      // offers are legal too).
      const data = ctx.state.dataSources?.get(resource);
      if (data) { data.mimes.push(mimeType); return; }
      const prim = ctx.state.primarySources?.get(resource);
      if (prim) prim.mimes.push(mimeType);
    },
    destroy(resource) {
      const wasClipboard = ctx.state.selection === resource;
      const wasPrimary = ctx.state.primarySelection === resource;
      ctx.state.dataSources?.delete(resource);
      ctx.state.primarySources?.delete(resource);
      if (wasClipboard) selectionOwnerGone(ctx, "clipboard");
      if (wasPrimary) selectionOwnerGone(ctx, "primary");
    },
  };
}

export function makeExtDataControlOffer(ctx: Ctx): ExtDataControlOfferV1Handler {
  return {
    receive(resource, mimeType, fd: WaylandFd) {
      receiveFromOffer(ctx, resource, mimeType, fd);
    },
    destroy(resource) {
      dropOffer(resource);
    },
  };
}
