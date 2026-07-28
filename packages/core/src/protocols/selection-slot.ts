// Shared selection-slot machinery for the selection protocols
// (wl_data_device, zwp_primary_selection, ext/zwlr data-control). Two
// slots exist -- clipboard and primary -- each holding at most one source;
// six device interfaces observe them. This module owns the per-slot state
// accessors, the per-interface transport dispatch (offer minting, mime
// advertisement, announce events), the offer->backing bookkeeping shared
// by every offer interface, and the claim/relinquish flows. The protocol
// modules keep only their handler wiring and family-specific extras (DnD,
// data-control source-map adoption).

import type { Resource, WaylandFd } from "../types.js";
import type { Ctx } from "./ctx.js";
import { SELECTION_EVENT } from "../events/window-bus.js";

export type SlotKind = "clipboard" | "primary";
export const SLOT_KINDS: readonly SlotKind[] = ["clipboard", "primary"];

export interface SourceRecord { mimes: string[]; dndActions?: number }
type XSource = import("../xwayland/selection.js").XSelectionSource;

// Per-slot state accessors: which CompositorState fields back each slot.
// `devices` is the focus-gated wl-family device registry (the data-control
// families keep their own registry in state.dataControlDevices and are
// fanned out from the selection.changed bus subscription instead).
interface SlotAccess {
  readonly bridgeProtocol: "data" | "primary";
  getSource(ctx: Ctx): Resource | null;
  setSource(ctx: Ctx, source: Resource | null): void;
  getXSource(ctx: Ctx): XSource | null;
  sources(ctx: Ctx): Map<Resource, SourceRecord> | undefined;
  ensureSources(ctx: Ctx): Map<Resource, SourceRecord>;
  devices(ctx: Ctx): Map<number, Set<Resource>> | undefined;
}

export const SLOT: Record<SlotKind, SlotAccess> = {
  clipboard: {
    bridgeProtocol: "data",
    getSource: (ctx) => ctx.state.selection ?? null,
    setSource: (ctx, source) => { ctx.state.selection = source; },
    getXSource: (ctx) => ctx.state.xClipboardSource ?? null,
    sources: (ctx) => ctx.state.dataSources,
    ensureSources: (ctx) => (ctx.state.dataSources ??= new Map()),
    devices: (ctx) => ctx.state.dataDevices,
  },
  primary: {
    bridgeProtocol: "primary",
    getSource: (ctx) => ctx.state.primarySelection ?? null,
    setSource: (ctx, source) => { ctx.state.primarySelection = source; },
    getXSource: (ctx) => ctx.state.xPrimarySource ?? null,
    sources: (ctx) => ctx.state.primarySources,
    ensureSources: (ctx) => (ctx.state.primarySources ??= new Map()),
    devices: (ctx) => ctx.state.primaryDevices,
  },
};

// Per-device-interface transport: how to mint an offer, advertise a mime
// on it, and announce it (or null) on the device. `supports` gates which
// slots an interface carries: the wl and zwp families each carry exactly
// one slot; the data-control families carry both, except that zwlr's
// primary_selection event is since-version 2 -- sending it to a v1
// binding aborts the client, so v1 zwlr devices skip primary entirely.
interface SlotTransport {
  supports(device: Resource, kind: SlotKind): boolean;
  mintOffer(ctx: Ctx, device: Resource): Resource | null;
  sendMime(ctx: Ctx, offer: Resource, mime: string): void;
  announce(ctx: Ctx, device: Resource, kind: SlotKind, offer: Resource | null): void;
}

const TRANSPORTS: Record<string, SlotTransport> = {
  wl_data_device: {
    supports: (_device, kind) => kind === "clipboard",
    // data_offer is an event carrying a server-minted new_id; postEvent
    // returns the new offer resource. Pass null as the new_id slot -- the
    // trampoline treats a non-number new_id arg as "mint server-side".
    mintOffer: (ctx, device) =>
      ctx.events.wl_data_device.send_data_offer(device, null) as Resource | null,
    sendMime: (ctx, offer, mime) => ctx.events.wl_data_offer.send_offer(offer, mime),
    announce: (ctx, device, _kind, offer) =>
      ctx.events.wl_data_device.send_selection(device, offer),
  },
  zwp_primary_selection_device_v1: {
    supports: (_device, kind) => kind === "primary",
    mintOffer: (ctx, device) =>
      ctx.events.zwp_primary_selection_device_v1.send_data_offer(device, null) as Resource | null,
    sendMime: (ctx, offer, mime) =>
      ctx.events.zwp_primary_selection_offer_v1.send_offer(offer, mime),
    announce: (ctx, device, _kind, offer) =>
      ctx.events.zwp_primary_selection_device_v1.send_selection(device, offer),
  },
  ext_data_control_device_v1: {
    supports: () => true,
    mintOffer: (ctx, device) =>
      ctx.events.ext_data_control_device_v1.send_data_offer(device, null) as Resource | null,
    sendMime: (ctx, offer, mime) =>
      ctx.events.ext_data_control_offer_v1.send_offer(offer, mime),
    announce: (ctx, device, kind, offer) => {
      if (kind === "clipboard") ctx.events.ext_data_control_device_v1.send_selection(device, offer);
      else ctx.events.ext_data_control_device_v1.send_primary_selection(device, offer);
    },
  },
  zwlr_data_control_device_v1: {
    supports: (device, kind) => kind === "clipboard" || device.version >= 2,
    mintOffer: (ctx, device) =>
      ctx.events.zwlr_data_control_device_v1.send_data_offer(device, null) as Resource | null,
    sendMime: (ctx, offer, mime) =>
      ctx.events.zwlr_data_control_offer_v1.send_offer(offer, mime),
    announce: (ctx, device, kind, offer) => {
      if (kind === "clipboard") ctx.events.zwlr_data_control_device_v1.send_selection(device, offer);
      else ctx.events.zwlr_data_control_device_v1.send_primary_selection(device, offer);
    },
  },
};

// What backs a minted offer: a wl-side source (any selection family; also
// DnD offers, whose source may be null for an internal drag), or the
// Xwayland bridge's claim on a slot. One record per offer, shared by every
// offer interface; the offer resource being destroyed reclaims the entry.
type OfferBacking = { source: Resource | null } | { xKind: SlotKind };
const offerBacking = new WeakMap<Resource, OfferBacking>();

export function setOfferSource(offer: Resource, source: Resource | null): void {
  offerBacking.set(offer, { source });
}

export function dropOffer(offer: Resource): void {
  offerBacking.delete(offer);
}

// Tell a source it lost ownership of a selection slot (the spec's
// "cancelled" on replacement). The selection state is shared across all
// selection protocols, so the displaced source may belong to any of them --
// dispatch the cancelled event by the resource's interface. No-op if the
// slot is unchanged or the source is the same one re-asserting.
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

// receive() on any offer interface: an X-backed offer routes to the
// selection bridge (which takes ownership of the fd and closes it after
// the X transfer); a source-backed offer forwards to the source (the
// helper closes the request fd).
export function receiveFromOffer(
  ctx: Ctx, offer: Resource, mimeType: string, fd: WaylandFd,
): void {
  const backing = offerBacking.get(offer);
  if (backing && "xKind" in backing && ctx.state.receiveForXSource) {
    ctx.state.receiveForXSource(backing.xKind, mimeType, fd.takeRawFd());
    return;
  }
  forwardReceiveToSource(
    ctx, backing && "source" in backing ? backing.source : null, mimeType, fd);
}

// Push a slot's current contents to one device: resolve the wl source
// (else the X-backed source), announce null when neither exists, else
// mint an offer, advertise each mime, record the offer's backing, and
// announce the offer. The burst (data_offer -> per-mime offer ->
// announce) is sent inline so libwayland flushes it as a unit, per the
// data-control spec's atomicity requirement.
export function pushSlotToDevice(ctx: Ctx, kind: SlotKind, device: Resource): void {
  if (device.destroyed) return;
  const transport = TRANSPORTS[device.interfaceName];
  if (!transport || !transport.supports(device, kind)) return;
  const slot = SLOT[kind];
  const wlSource = slot.getSource(ctx);
  const xSource = slot.getXSource(ctx);
  if (!wlSource && !xSource) {
    transport.announce(ctx, device, kind, null);
    return;
  }
  const mimes = wlSource
    ? (slot.sources(ctx)?.get(wlSource)?.mimes ?? [])
    : (xSource ? xSource.mimes : []);
  const offer = transport.mintOffer(ctx, device);
  if (!offer) return;
  if (wlSource) setOfferSource(offer, wlSource);
  else offerBacking.set(offer, { xKind: kind });
  for (const mime of mimes) transport.sendMime(ctx, offer, mime);
  transport.announce(ctx, device, kind, offer);
}

// Push a slot to every wl-family device of one client (the focus-gated
// families; selection follows keyboard focus there).
export function sendSlotTo(ctx: Ctx, kind: SlotKind, clientId: number): void {
  const devices = SLOT[kind].devices(ctx)?.get(clientId);
  if (!devices) return;
  for (const device of devices) pushSlotToDevice(ctx, kind, device);
}

// A source claims (or clears) a slot: tell the displaced owner, store the
// new owner, notify the Xwayland selection bridge so it can claim /
// release the X side (no-op when no bridge is installed), and broadcast
// on the bus so subscribers that bypass keyboard-focus gating (the
// data-control fan-out) re-push their offers. The caller then pushes to
// whichever wl-family client should see the change.
export function claimSlot(ctx: Ctx, kind: SlotKind, source: Resource | null): void {
  const slot = SLOT[kind];
  cancelDisplacedSource(ctx, slot.getSource(ctx), source);
  slot.setSource(ctx, source);
  ctx.state.onWlSelectionChanged?.(kind, source, slot.bridgeProtocol);
  ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind });
}

// The owner of a selection slot is gone (its source was destroyed
// explicitly, or its client disconnected and the per-frame sweep noticed).
// Clear the slot, rescind the X-side claim via the Xwayland selection
// bridge, broadcast to data-control observers, and re-push to the
// keyboard-focused client so it drops the now-dangling offer (falling back
// to an X-backed source when one exists).
export function selectionOwnerGone(ctx: Ctx, kind: SlotKind): void {
  const slot = SLOT[kind];
  slot.setSource(ctx, null);
  ctx.state.onWlSelectionChanged?.(kind, null, slot.bridgeProtocol);
  ctx.state.bus?.emit(SELECTION_EVENT.changed, { kind });
  const focusClient = ctx.state.seat?.kbFocus?.clientId;
  if (focusClient != null) sendSlotTo(ctx, kind, focusClient);
}
