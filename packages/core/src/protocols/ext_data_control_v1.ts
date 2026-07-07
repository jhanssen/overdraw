// Data-control: clipboard + primary-selection control for clients that
// bypass keyboard focus. Used by wl-clipboard (wl-copy / wl-paste),
// clipboard managers, and scripted automation -- anything that needs to
// read or set the current selection without holding wl_keyboard focus.
//
// This module serves BOTH wire families: ext_data_control_v1 and the
// legacy zwlr_data_control_v1 (wl-clipboard <= 2.2.1 and older clipboard
// managers bind only the latter; without it wl-copy maps an invisible
// toplevel to grab focus, which a tiler reflows around). The two
// protocols are request/event-identical for everything here; senders are
// picked per resource by interface name. One divergence: zwlr's
// primary_selection is since-version 2, so primary pushes to a v1 zwlr
// device are skipped.
//
// Differences vs. wl_data_device_manager:
//   - Per-client device receives BOTH selections (clipboard + primary).
//   - All bound devices are re-pushed on every selection change; there
//     is no focus gating. We subscribe once to selection.changed and
//     re-emit per device whose client matches the seat the device was
//     bound against.
//   - The handler does not advertise wl_data_source's DnD actions; this
//     protocol does not participate in drag-and-drop.
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
// without intermixed events from another selection. We send each burst
// inline within the single bus subscriber, so libwayland flushes them
// as a unit.

import type { Resource, WaylandFd } from "../types.js";
import type { Ctx } from "./ctx.js";
import { SELECTION_EVENT } from "../events/window-bus.js";
import { cancelDisplacedSource } from "./wl_data_device_manager.js";

import type { ExtDataControlManagerV1Handler }
  from "#protocols-gen/ext_data_control_manager_v1.js";
import type { ExtDataControlDeviceV1Handler }
  from "#protocols-gen/ext_data_control_device_v1.js";
import type { ExtDataControlSourceV1Handler }
  from "#protocols-gen/ext_data_control_source_v1.js";
import type { ExtDataControlOfferV1Handler }
  from "#protocols-gen/ext_data_control_offer_v1.js";

// Per-resource bookkeeping: offers minted by the control protocol need to
// know which source they came from (mirrors offerToSource for the wl
// data-device path) and whether they're X-backed. Module-scoped weak
// maps so the resource being destroyed reclaims its slot.
//
// Two source flavors:
//   - A control-protocol source (ext_data_control_source_v1) -- treated
//     identically to wl_data_source for our purposes; `mimes` and the
//     send-fd path live alongside the wl ones in state.dataSources /
//     state.primarySources so the existing forwarding code (and the
//     Xwayland bridge) does not need to special-case it.
//   - An X-backed source -- the bridge already publishes
//     state.xClipboardSource / xPrimarySource; on a control receive we
//     route to state.receiveForXSource.
const offerToWlSource = new WeakMap<Resource, Resource>();
const offerXBacked = new WeakMap<Resource, "clipboard" | "primary">();

// Family dispatch: the ext and zwlr sender objects have the same call
// shapes for everything this handler emits, so call sites work against
// the inferred union.
function isZwlr(resource: Resource): boolean {
  return resource.interfaceName.startsWith("zwlr_");
}
function deviceEvents(ctx: Ctx, device: Resource) {
  return isZwlr(device)
    ? ctx.events.zwlr_data_control_device_v1
    : ctx.events.ext_data_control_device_v1;
}
function offerEventsFor(ctx: Ctx, device: Resource) {
  return isZwlr(device)
    ? ctx.events.zwlr_data_control_offer_v1
    : ctx.events.ext_data_control_offer_v1;
}

// Devices we've bound, keyed by client id. We re-push on every
// selection.changed; closing a device drops it from the set.
function devicesFor(ctx: Ctx, clientId: number): Set<Resource> {
  const all = (ctx.state.dataControlDevices ??= new Map<number, Set<Resource>>());
  let s = all.get(clientId);
  if (!s) { s = new Set<Resource>(); all.set(clientId, s); }
  return s;
}

function pushClipboardTo(ctx: Ctx, device: Resource): void {
  if (device.destroyed) return;
  const dev = deviceEvents(ctx, device);
  const wlSource = ctx.state.selection ?? null;
  const xSource = ctx.state.xClipboardSource ?? null;
  if (!wlSource && !xSource) {
    dev.send_selection(device, null);
    return;
  }
  const mimes = wlSource
    ? (ctx.state.dataSources?.get(wlSource)?.mimes ?? [])
    : (xSource ? xSource.mimes : []);
  const offer = dev.send_data_offer(device, null) as Resource;
  if (!offer) return;
  if (wlSource) offerToWlSource.set(offer, wlSource);
  else offerXBacked.set(offer, "clipboard");
  for (const mime of mimes) {
    offerEventsFor(ctx, device).send_offer(offer, mime);
  }
  dev.send_selection(device, offer);
}

function pushPrimaryTo(ctx: Ctx, device: Resource): void {
  if (device.destroyed) return;
  // zwlr: primary_selection is since-version 2; a v1 binding must not
  // receive it (event-version client-abort).
  if (isZwlr(device) && device.version < 2) return;
  const dev = deviceEvents(ctx, device);
  const wlSource = ctx.state.primarySelection ?? null;
  const xSource = ctx.state.xPrimarySource ?? null;
  if (!wlSource && !xSource) {
    dev.send_primary_selection(device, null);
    return;
  }
  const mimes = wlSource
    ? (ctx.state.primarySources?.get(wlSource)?.mimes ?? [])
    : (xSource ? xSource.mimes : []);
  const offer = dev.send_data_offer(device, null) as Resource;
  if (!offer) return;
  if (wlSource) offerToWlSource.set(offer, wlSource);
  else offerXBacked.set(offer, "primary");
  for (const mime of mimes) {
    offerEventsFor(ctx, device).send_offer(offer, mime);
  }
  dev.send_primary_selection(device, offer);
}

function pushBothTo(ctx: Ctx, device: Resource): void {
  pushClipboardTo(ctx, device);
  pushPrimaryTo(ctx, device);
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
        if (kind === "clipboard") pushClipboardTo(ctx, device);
        else pushPrimaryTo(ctx, device);
      }
    }
  });
}

export default function makeExtDataControlManager(ctx: Ctx): ExtDataControlManagerV1Handler {
  ensureSubscription(ctx);
  return {
    create_data_source(_resource, id) {
      // Store alongside wl_data_device sources so the forwarding paths
      // (Xwayland bridge, wl_data_device fan-out) see them uniformly.
      // The source starts orphaned (no selection slot yet); set_selection
      // or set_primary_selection promotes it.
      (ctx.state.dataSources ??= new Map()).set(id, { mimes: [] });
    },
    get_data_device(_resource, id, _seat) {
      const clientId = ctx.addon.clientId(id);
      devicesFor(ctx, clientId).add(id);
      // Seed the device with the current selections so a client that
      // binds late doesn't see "empty until something changes."
      pushBothTo(ctx, id);
    },
    destroy(_resource) { /* destructor */ },
  };
}

export function makeExtDataControlDevice(ctx: Ctx): ExtDataControlDeviceV1Handler {
  function consume(resource: Resource, source: Resource | null, kind: "clipboard" | "primary"): void {
    // The spec forbids reusing a source in a second set_selection /
    // set_primary_selection (and offering more mimes after use), but real
    // clients (some clipboard managers) do both; killing them over it is worse
    // than tolerating it, so we accept it rather than post the protocol error.
    //
    // Hand the source to the standard selection state. From this point
    // every wl_data_device-side path (focus push, X bridge mirror, etc.)
    // sees it as the current source. The wl_data_source / ext source
    // distinction is invisible to those paths -- they only read mimes
    // off state.dataSources / primarySources.
    if (kind === "clipboard") {
      // If we're promoting an ext source, register it in the primary
      // map removed from the clipboard map (and vice versa). The
      // resource itself is the key; both maps share Resource keys
      // distinguishable by which slot the source is registered under.
      // For simplicity we never have an ext source in BOTH maps at
      // once: create_data_source registered it in dataSources, and a
      // primary set_selection moves it to primarySources.
      if (source) {
        const dataEntry = ctx.state.dataSources?.get(source);
        if (dataEntry) {
          // Already in the right map.
        } else {
          const primaryEntry = ctx.state.primarySources?.get(source);
          if (primaryEntry) {
            ctx.state.primarySources?.delete(source);
            (ctx.state.dataSources ??= new Map()).set(source, primaryEntry);
          } else {
            (ctx.state.dataSources ??= new Map()).set(source, { mimes: [] });
          }
        }
      }
      cancelDisplacedSource(ctx, ctx.state.selection ?? null, source);
      ctx.state.selection = source;
      ctx.state.onWlSelectionChanged?.("clipboard", source, "data");
      ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "clipboard" });
      // Push to the keyboard-focused client (focus follows for the
      // regular data_device path; control devices are fanned out from
      // the bus subscription).
      const focusClient = ctx.state.seat?.kbFocus?.clientId;
      if (focusClient != null) reemitClipboardForFocus(ctx, focusClient);
      else reemitClipboardForFocus(ctx, ctx.addon.clientId(resource));
    } else {
      if (source) {
        const primEntry = ctx.state.primarySources?.get(source);
        if (primEntry) {
          // Already there.
        } else {
          const dataEntry = ctx.state.dataSources?.get(source);
          if (dataEntry) {
            ctx.state.dataSources?.delete(source);
            (ctx.state.primarySources ??= new Map()).set(source, dataEntry);
          } else {
            (ctx.state.primarySources ??= new Map()).set(source, { mimes: [] });
          }
        }
      }
      cancelDisplacedSource(ctx, ctx.state.primarySelection ?? null, source);
      ctx.state.primarySelection = source;
      ctx.state.onWlSelectionChanged?.("primary", source, "primary");
      ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "primary" });
      const focusClient = ctx.state.seat?.kbFocus?.clientId;
      if (focusClient != null) reemitPrimaryForFocus(ctx, focusClient);
      else reemitPrimaryForFocus(ctx, ctx.addon.clientId(resource));
    }
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

// Defer reemit-to-focused-client work to the wl_data_device_manager
// module rather than duplicating the offer-minting logic. Two thin
// wrappers; if the data-device module hasn't installed its hooks yet
// (test bring-up order), the calls are silent no-ops.
function reemitClipboardForFocus(ctx: Ctx, clientId: number): void {
  ctx.state.sendSelectionToClient?.(clientId);
}
function reemitPrimaryForFocus(ctx: Ctx, clientId: number): void {
  ctx.state.sendPrimaryToClient?.(clientId);
}

export function makeExtDataControlSource(ctx: Ctx): ExtDataControlSourceV1Handler {
  return {
    offer(resource, mimeType) {
      // ext sources are stored alongside wl sources -- the source could
      // be in either selection's map by the time mimes arrive (mostly
      // they arrive BEFORE set_selection, but mid-stream offers are
      // legal too).
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
      if (wasClipboard) {
        ctx.state.selection = null;
        ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "clipboard" });
      }
      if (wasPrimary) {
        ctx.state.primarySelection = null;
        ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind: "primary" });
      }
    },
  };
}

export function makeExtDataControlOffer(ctx: Ctx): ExtDataControlOfferV1Handler {
  return {
    receive(resource, mimeType, fd: WaylandFd) {
      // X-backed offer: route to the selection bridge (same path the
      // wl_data_offer.receive forward uses). The dispatcher owns the
      // request fd; transfer it to the bridge, which closes it.
      const xKind = offerXBacked.get(resource);
      if (xKind && ctx.state.receiveForXSource) {
        ctx.state.receiveForXSource(xKind, mimeType, fd.takeRawFd());
        return;
      }
      // Wl-source path. send_send takes a dup (libwayland owns it once the
      // event is queued); our request fd must be CLOSED here -- the
      // dispatcher owns it and nothing else will close it. A merely-taken
      // fd would hold the receiver's pipe write-end open forever, so the
      // reading client never sees EOF.
      const source = offerToWlSource.get(resource);
      if (!source || source.destroyed) { fd.close(); return; }
      // The source is a wl_data_source, an ext_data_control_source_v1, or
      // a zwlr_data_control_source_v1. All have a `send` event carrying
      // (mime, fd); dispatch to whichever family the source resource is
      // registered against.
      if (source.interfaceName === "ext_data_control_source_v1") {
        ctx.events.ext_data_control_source_v1.send_send(source, mimeType, fd.dup());
      } else if (source.interfaceName === "zwlr_data_control_source_v1") {
        ctx.events.zwlr_data_control_source_v1.send_send(source, mimeType, fd.dup());
      } else {
        // wl_data_source.send_send for clipboard sources and
        // zwp_primary_selection_source_v1.send_send for primary sources;
        // disambiguate by which selection map the source lives in.
        if (ctx.state.dataSources?.has(source)) {
          ctx.events.wl_data_source.send_send(source, mimeType, fd.dup());
        } else if (ctx.state.primarySources?.has(source)) {
          ctx.events.zwp_primary_selection_source_v1.send_send(source, mimeType, fd.dup());
        }
      }
      fd.close();
    },
    destroy(resource) {
      offerToWlSource.delete(resource);
      offerXBacked.delete(resource);
    },
  };
}
