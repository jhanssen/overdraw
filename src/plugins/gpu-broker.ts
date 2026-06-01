// Core-side GPU broker for plugin Workers (C-M4 step 4c). Runs on the CORE main
// thread. The plugin Worker owns its wire client + device + rendering; the core
// owns the side channel and the compositor. This object services the Worker's
// SDK requests (routed via the plugin runtime's onRequest hook): broker the wire
// connection, relay instance injection, allocate the shared surface buffer, drive
// the per-frame producer/consumer fence dance, and composite the plugin's overlay
// at the core-decided rect + layer.

import type { Addon } from "../types.js";
import type { CompositorSink } from "../protocols/ctx.js";
import type { OverlayBroker, OverlayLayer } from "../overlay.js";
import type { OverlayAnchor } from "../overlay-position.js";
import type { DawnWire } from "../gpu/compositor.js";
import { SlotStates, createSlotStates } from "./surface-slots.js";

const pCreateConn = (a: Addon) => new Promise<{ connId: number; fd: number }>((res, rej) =>
  a.pluginCreateConnection((r: { connId: number; fd: number } | null) => r ? res(r) : rej(new Error("createConnection"))));
const pInject = (a: Addon, connId: number, id: number, gen: number) => new Promise<void>((res, rej) =>
  a.pluginInjectInstance(connId, id, gen, (ok: boolean) => ok ? res() : rej(new Error("injectInstance"))));
const pAlloc = (a: Addon, connId: number, w: number, h: number, ptId: number, ptGen: number, pdId: number, pdGen: number) =>
  new Promise<{ surfaceBufId: number }>((res, rej) =>
    a.pluginAllocSurfaceBufferW(connId, w, h, ptId, ptGen, pdId, pdGen,
      (r: { surfaceBufId: number } | null) => r ? res(r) : rej(new Error("allocSurfaceBuffer"))));
const pProducerBegin = (a: Addon, id: number) => new Promise<void>((res, rej) =>
  a.pluginSurfaceProducerBegin(id, (ok: boolean) => ok ? res() : rej(new Error("producerBegin"))));
const pConsumerBegin = (a: Addon, id: number) => new Promise<void>((res, rej) =>
  a.pluginSurfaceConsumerBegin(id, (ok: boolean) => ok ? res() : rej(new Error("consumerBegin"))));

// A logical overlay surface backed by a ring of slots (each slot is one shared
// dmabuf with its own surfaceBufId). The producer renders into one slot while the
// consumer holds a read bracket on the latest-presented slot -> smooth animation.
interface OverlaySurface {
  surfaceId: number;      // compositor surface id (== overlay broker id)
  width: number;
  height: number;
  slots: number[];        // surfaceBufIds, indexed by ring-slot index
  consumerSlot: number;   // ring-slot index currently bracket-open for the consumer (-1)
  slotStates: SlotStates; // shared FREE/ACQUIRED/PRESENTED/DRAINING ownership (SAB)
}

export interface GpuBrokerDeps {
  addon: Addon;
  compositor: CompositorSink;
  overlays: OverlayBroker;
  dawn: DawnWire;
  coreDeviceHandle: bigint;
  // Generic hooks the broker fires WITHOUT understanding what they mean (it stays
  // surface-agnostic). The decoration layer uses these to learn its surface ids
  // and first-present timing; default no-ops.
  //  - onSurfaceAllocated: a surface.alloc carried a `decorates` tag (the window id
  //    it decorates); links the new surface id to that window.
  //  - onSurfacePresented: a surface received a frame (called every present).
  onSurfaceAllocated?: (surfaceId: number, decoratesWindowId: number) => void;
  onSurfacePresented?: (surfaceId: number) => void;
}

export function createGpuBroker(deps: GpuBrokerDeps) {
  const { addon, compositor, overlays, dawn, coreDeviceHandle } = deps;
  const onSurfaceAllocated = deps.onSurfaceAllocated ?? (() => {});
  const onSurfacePresented = deps.onSurfacePresented ?? (() => {});
  const connByPlugin = new Map<string, number>();
  // overlay surfaceId -> geometry pending until its slots are bound.
  const pendingAlloc = new Map<number, { width: number; height: number; overlaySurfaceId: number }>();
  // surfaceBufId -> its OverlaySurface (so present can find the ring).
  const surfaceByBuf = new Map<number, OverlaySurface>();
  // overlay surfaceId -> OverlaySurface.
  const surfaces = new Map<number, OverlaySurface>();

  return async function onRequest(pluginName: string, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, number | string | bigint | { x: number; y: number; width: number; height: number } | undefined>;
    switch (method) {
      case "gpu.connect": {
        const r = await pCreateConn(addon);
        connByPlugin.set(pluginName, r.connId);
        return { connId: r.connId, fd: r.fd };
      }
      case "gpu.injectInstance":
        await pInject(addon, p.connId as number, p.id as number, p.generation as number);
        return null;
      case "gpu.setTickDevice":
        addon.pluginSetTickDevice(p.connId as number, p.id as number, p.generation as number);
        return null;
      case "surface.alloc": {
        // Core decides the rect + layer (overlay broker) and assigns the surface
        // id. Two geometry sources: an EXPLICIT rect (decorations -- the core
        // already decided it via the inset reservation) or anchor params
        // (overlays). The ring's slots are allocated per-slot at bindProducer.
        const width = p.width as number, height = p.height as number;
        const slots = (p.slots as number) ?? 2;
        const explicitRect = p.rect as { x: number; y: number; width: number; height: number } | undefined;
        const handle = explicitRect
          ? overlays.createAt(pluginName, (p.layer as OverlayLayer) ?? "above", explicitRect)
          : overlays.create(pluginName, {
              layer: (p.layer as OverlayLayer) ?? "overlay",
              anchor: (p.anchor as OverlayAnchor) ?? "center", width, height, margin: p.margin as number,
            });
        // Shared slot-ownership state (SAB) for this surface's ring. Shared to the
        // Worker in the response; both sides agree on FREE/ACQUIRED/PRESENTED/
        // DRAINING via atomics (surface-slots.ts).
        const { sab, states } = createSlotStates(slots);
        const surf: OverlaySurface = {
          surfaceId: handle.surfaceId, width, height, slots: [], consumerSlot: -1,
          slotStates: new SlotStates(sab),
        };
        void states;
        surfaces.set(handle.surfaceId, surf);
        pendingAlloc.set(handle.surfaceId, { width, height, overlaySurfaceId: handle.surfaceId });
        // If this surface decorates a window, tell the decoration layer the link
        // (generic tag; the broker does not interpret it).
        const decorates = p.decorates as number | undefined;
        if (typeof decorates === "number") onSurfaceAllocated(handle.surfaceId, decorates);
        return { overlayId: handle.surfaceId, rect: handle.rect, slotsSab: sab };
      }
      case "surface.bindProducer": {
        const overlayId = p.overlayId as number;
        const pend = pendingAlloc.get(overlayId);
        const connId = connByPlugin.get(pluginName);
        const surf = surfaces.get(overlayId);
        if (!pend || connId === undefined || !surf) throw new Error("bindProducer: bad state");
        const alloc = await pAlloc(addon, connId, pend.width, pend.height,
          p.texId as number, p.texGen as number, p.devId as number, p.devGen as number);
        surf.slots.push(alloc.surfaceBufId);
        surfaceByBuf.set(alloc.surfaceBufId, surf);
        // Open the producer bracket on this slot so the plugin can render into it.
        await pProducerBegin(addon, alloc.surfaceBufId);
        return { surfaceBufId: alloc.surfaceBufId };
      }
      case "surface.present": {
        const connId = connByPlugin.get(pluginName);
        const slotIdx = p.slot as number;            // ring-slot index (SAB-tracked)
        const slotBufId = p.surfaceBufId as number;  // the slot's surfaceBufId
        const surf = surfaceByBuf.get(slotBufId);
        if (connId === undefined || !surf) throw new Error("present: unknown surface");
        // Producer done on the presented slot (deferred on the plugin-wire serial).
        addon.pluginSurfaceProducerEndW(slotBufId, (p.wireSerial as bigint) ?? 0n);
        // Switch the consumer read bracket to the just-presented slot. OPEN the new
        // bracket + install its texture BEFORE freeing the old one, so the surface
        // always has an open, valid consumer bracket when renderFrame samples it.
        const prevIdx = surf.consumerSlot;
        await pConsumerBegin(addon, slotBufId);      // waits this slot's producer fence
        const tex = dawn.wrapTexture(coreDeviceHandle, addon.pluginConsumerTexture(slotBufId));
        compositor.setSurfaceTexture?.(surf.surfaceId, tex, surf.width, surf.height);
        surf.consumerSlot = slotIdx;
        // The just-presented slot is the new latest (the worker CAS'd it to
        // PRESENTED). Demote + recycle the PREVIOUS slot: PRESENTED->DRAINING now,
        // then free it (DRAINING->FREE) + end its consumer bracket + reopen its
        // producer bracket ONLY after the compositor submit that last sampled it
        // completes on the GPU (afterCurrentFrame) -- else EndAccess races the read.
        if (prevIdx >= 0 && prevIdx !== slotIdx) {
          const prevBufId = surf.slots[prevIdx];
          surf.slotStates.demote(prevIdx);           // PRESENTED -> DRAINING (atomic)
          const recycle = (): void => {
            addon.pluginSurfaceConsumerEnd(prevBufId);
            void pProducerBegin(addon, prevBufId);
            surf.slotStates.free(prevIdx);            // DRAINING -> FREE; wakes producer
          };
          if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(recycle);
          else recycle();
        }
        // A frame is now installed for this surface; notify the decoration layer
        // (it filters for its own surfaces) so a first decoration frame can release
        // the gated content. Generic; the broker does not interpret it.
        onSurfacePresented(surf.surfaceId);
        return null;
      }
      default:
        throw new Error(`gpu-broker: unknown method '${method}'`);
    }
  };
}
