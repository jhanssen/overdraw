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
const pAlloc = (
  a: Addon, connId: number, w: number, h: number,
  ptId: number, ptGen: number, pdId: number, pdGen: number,
  pluginReservePointSerial: bigint,
) =>
  new Promise<{ surfaceBufId: number }>((res, rej) =>
    a.pluginAllocSurfaceBufferW(connId, w, h, ptId, ptGen, pdId, pdGen,
      pluginReservePointSerial,
      (r: { surfaceBufId: number } | null) => r ? res(r) : rej(new Error("allocSurfaceBuffer"))));

// Phase 5b: AllocComposeBuf. Reverse direction (core produces, plugin consumes).
// The plugin reserved its consumer texture; the core reserves its producer
// texture and ships AllocComposeBuf with all handles + the plugin's wireSerial.
const pAllocCompose = (
  a: Addon, connId: number, w: number, h: number,
  ctId: number, ctGen: number, cdId: number, cdGen: number,
  pluginReservePointSerial: bigint,
) =>
  new Promise<{ surfaceBufId: number }>((res, rej) =>
    a.coreAllocComposeBufferW(connId, w, h, ctId, ctGen, cdId, cdGen,
      pluginReservePointSerial,
      (r: { surfaceBufId: number } | null) => r ? res(r) : rej(new Error("allocComposeBuffer"))));

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
  alive: boolean;         // false once surface.destroy ran; pending deferred recycles
                          // must bail (their slots may be freed by the teardown).
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
  // Phase 5b compose buffers: surfaceBufId -> the wrapped core-device
  // producer texture + bookkeeping. For snapshot (live=false) the broker
  // does ONE compose pass at allocation. For live (live=true) the broker
  // registers the buffer with the compositor and the per-frame produce
  // loop renders into it; the broker releases the registration on
  // compose.release.
  // (Could later track per-plugin so destroy-on-plugin-stop teardowns
  // these along with overlays.)
  const composeBufs = new Map<number, {
    texture: GPUTexture; width: number; height: number; live: boolean;
  }>();

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
        const decorates = p.decorates as number | undefined;
        // A decoration is WINDOW-BOUND: it draws directly below its window's content
        // (z-bound to the window, via the WM stack), not on a flat layer. An overlay
        // with an explicit rect goes on its requested flat layer; an anchored overlay
        // is placed + clamped.
        const handle = typeof decorates === "number" && explicitRect
          ? overlays.createWindowBound(pluginName, explicitRect)
          : explicitRect
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
          slotStates: new SlotStates(sab), alive: true,
        };
        void states;
        surfaces.set(handle.surfaceId, surf);
        pendingAlloc.set(handle.surfaceId, { width, height, overlaySurfaceId: handle.surfaceId });
        // If this surface decorates a window, tell the decoration layer the link
        // (generic tag; the broker does not interpret it).
        if (typeof decorates === "number") onSurfaceAllocated(handle.surfaceId, decorates);
        return { overlayId: handle.surfaceId, rect: handle.rect, slotsSab: sab };
      }
      case "surface.bindProducer": {
        const overlayId = p.overlayId as number;
        const pend = pendingAlloc.get(overlayId);
        const connId = connByPlugin.get(pluginName);
        const surf = surfaces.get(overlayId);
        if (!pend || connId === undefined || !surf) throw new Error("bindProducer: bad state");
        // The worker captured `reservePointSerial` INSIDE reserveProducerTexture
        // (single chokepoint, see worker_wire.cpp::reserveProducerTexture). The
        // GPU process uses it to defer the producer-side InjectTexture until the
        // plugin wire reader has consumed past it -- making the recycled-handle
        // inject structurally safe whether or not the wire has caught up yet.
        const reservePointSerial = (p.reservePointSerial as bigint) ?? 0n;
        const alloc = await pAlloc(addon, connId, pend.width, pend.height,
          p.texId as number, p.texGen as number, p.devId as number, p.devGen as number,
          reservePointSerial);
        surf.slots.push(alloc.surfaceBufId);
        surfaceByBuf.set(alloc.surfaceBufId, surf);
        // The producer bracket is opened by the Worker itself, in-band on the
        // plugin wire, when it first acquires this slot (gpu.ts getCurrentTexture
        // -> plugin.writeBeginAccess). The broker no longer mediates it.
        return { surfaceBufId: alloc.surfaceBufId };
      }
      case "surface.present": {
        const connId = connByPlugin.get(pluginName);
        const slotIdx = p.slot as number;            // ring-slot index (SAB-tracked)
        const slotBufId = p.surfaceBufId as number;  // the slot's surfaceBufId
        const surf = surfaceByBuf.get(slotBufId);
        if (connId === undefined || !surf) throw new Error("present: unknown surface");
        // Producer End was written by the Worker in-band on the plugin wire
        // (gpu.ts present -> plugin.writeEndAccess) right after its render submit;
        // the broker no longer mediates it.
        // Switch the consumer read bracket to the just-presented slot. OPEN the new
        // bracket + install its texture BEFORE freeing the old one, so the surface
        // always has an open, valid consumer bracket when renderFrame samples it.
        const prevIdx = surf.consumerSlot;
        // Open the consumer read bracket in-band on the core wire. The kind=1
        // frame is FIFO-ordered before the next compositor sample batch, so the
        // bracket (with its wait on this slot's producer fence) is in before
        // renderFrame's samples are decoded -- no ctrl round-trip to await.
        addon.writeConsumerBegin(slotBufId);
        const tex = dawn.wrapTexture(coreDeviceHandle, addon.pluginConsumerTexture(slotBufId));
        compositor.setSurfaceTexture?.(surf.surfaceId, tex, surf.width, surf.height);
        surf.consumerSlot = slotIdx;
        // The just-presented slot is the new latest (the worker CAS'd it to
        // PRESENTED). Demote + recycle the PREVIOUS slot: PRESENTED->DRAINING now,
        // then end its consumer bracket + free it (DRAINING->FREE) ONLY after the
        // compositor submit that last sampled it completes on the GPU
        // (afterCurrentFrame) -- else the consumer EndAccess races the read.
        if (prevIdx >= 0 && prevIdx !== slotIdx) {
          const prevBufId = surf.slots[prevIdx];
          surf.slotStates.demote(prevIdx);           // PRESENTED -> DRAINING (atomic)
          const recycle = (): void => {
            // Bail if the surface was destroyed since this was queued: its slots
            // may already be freed by the teardown.
            if (!surf.alive) return;
            // End the prior slot's consumer bracket in-band. The afterCurrentFrame
            // gate (this runs inside `recycle`) already ensured the GPU read of
            // this slot completed; the kind=2 frame closes the decode-side bracket.
            addon.writeConsumerEnd(prevBufId);
            // Publish the slot as FREE. The producer bracket is now opened by the
            // Worker itself when it re-acquires this slot (gpu.ts getCurrentTexture
            // -> writeBeginAccess, FIFO-ordered before its render on the plugin
            // wire), so the broker no longer reopens it or gates free() on it --
            // the bracket-open/render ordering is intrinsic to the plugin wire.
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
      case "compose.snapshot": {
        // Phase 5b: Worker plugin asked for a snapshot compose. The plugin
        // has already reserved its consumer-side texture on its own wire
        // and is sending us the reserved handle. We:
        //   1. Allocate a compose dmabuf (core = producer, plugin = consumer)
        //      via coreAllocComposeBufferW -- core reserves its producer
        //      texture, sends AllocComposeBuf, awaits inject on both wires.
        //   2. Wrap the core's producer wgpu::Texture handle as a GPUTexture.
        //   3. Render the requested windows into it (composeIntoView with
        //      producerSurfaceBufId set -> producer Begin/End on the core
        //      wire chain a fence the plugin's consumer Begin will wait on).
        //   4. Reply {surfaceBufId, width, height}; the plugin wraps its
        //      consumer texture handle separately on its own device.
        const connId = connByPlugin.get(pluginName);
        if (connId === undefined) throw new Error("compose.snapshot: no plugin conn");
        const w = p.width as number, h = p.height as number;
        if (!w || !h) throw new Error("compose.snapshot: bad dims");
        const ctId = p.consumerTexId as number;
        const ctGen = p.consumerTexGen as number;
        const cdId = p.consumerDevId as number;
        const cdGen = p.consumerDevGen as number;
        const pluginSerial = (p.pluginReservePointSerial as bigint) ?? 0n;
        const windows = (p.windows as unknown as number[]) ?? [];

        const alloc = await pAllocCompose(addon, connId, w, h,
          ctId, ctGen, cdId, cdGen, pluginSerial);

        // The core's wrapped wgpu::Texture for this surface (the producer
        // side: TextureBinding|CopySrc|RenderAttachment -- compositor.h
        // reserveCoreComposeTexture). pluginConsumerTexture returns
        // whichever side is on the core's device, regardless of role.
        const tex = dawn.wrapTexture(coreDeviceHandle,
          addon.pluginConsumerTexture(alloc.surfaceBufId));
        composeBufs.set(alloc.surfaceBufId,
          { texture: tex, width: w, height: h, live: false });

        if (compositor.composeIntoView) {
          compositor.composeIntoView({
            outputId: 0,
            targetView: tex.createView(),
            windows,
            outW: w, outH: h,
            producerSurfaceBufId: alloc.surfaceBufId,
          });
        } else {
          throw new Error("compose.snapshot: compositor lacks composeIntoView");
        }
        return { surfaceBufId: alloc.surfaceBufId, width: w, height: h };
      }
      case "compose.live": {
        // Phase 5b-live: Worker plugin asks for a live compose. Same
        // allocation as snapshot, then registers the buffer with the
        // compositor's per-frame produce loop. The buffer's contents
        // track on-screen compositor state (subject to the per-frame
        // serialization with the plugin's consumer Begin/End brackets).
        //
        // We do an EAGER initial compose pass so the texture has frame-0
        // contents available the first time the plugin samples (matches
        // snapshot's 'texture valid immediately' contract; without this
        // the plugin's first sample would see an uninitialized dmabuf
        // until the next on-screen renderFrame).
        const connId = connByPlugin.get(pluginName);
        if (connId === undefined) throw new Error("compose.live: no plugin conn");
        const w = p.width as number, h = p.height as number;
        if (!w || !h) throw new Error("compose.live: bad dims");
        const ctId = p.consumerTexId as number;
        const ctGen = p.consumerTexGen as number;
        const cdId = p.consumerDevId as number;
        const cdGen = p.consumerDevGen as number;
        const pluginSerial = (p.pluginReservePointSerial as bigint) ?? 0n;
        const windows = (p.windows as unknown as number[]) ?? [];

        const alloc = await pAllocCompose(addon, connId, w, h,
          ctId, ctGen, cdId, cdGen, pluginSerial);

        const tex = dawn.wrapTexture(coreDeviceHandle,
          addon.pluginConsumerTexture(alloc.surfaceBufId));
        composeBufs.set(alloc.surfaceBufId,
          { texture: tex, width: w, height: h, live: true });

        if (!compositor.composeIntoView || !compositor.registerLiveCompose) {
          throw new Error("compose.live: compositor lacks live-compose machinery");
        }
        const targetView = tex.createView();
        // Initial frame-0 produce. After this the per-frame produce loop
        // takes over and re-renders on every renderFrame.
        compositor.composeIntoView({
          outputId: 0, targetView, windows,
          outW: w, outH: h, producerSurfaceBufId: alloc.surfaceBufId,
        });
        compositor.registerLiveCompose({
          surfaceBufId: alloc.surfaceBufId, targetView, windows,
          outW: w, outH: h,
        });
        return { surfaceBufId: alloc.surfaceBufId, width: w, height: h };
      }
      case "compose.release": {
        // Plugin is done with a compose snapshot or live target. Drop our
        // reference to the wrapped core-device texture, unregister from the
        // live-compose loop (no-op for snapshots), and ask the GPU process
        // to free the dmabuf + STMs + textures via ReleaseSurfaceBuf.
        const bufId = p.surfaceBufId as number;
        if (bufId === undefined) throw new Error("compose.release: bad surfaceBufId");
        const entry = composeBufs.get(bufId);
        if (entry?.live && compositor.unregisterLiveCompose) {
          compositor.unregisterLiveCompose(bufId);
        }
        composeBufs.delete(bufId);
        // Gate release on afterCurrentFrame: a previous compose pass's GPU
        // work may still be in flight on the core's queue (the producer
        // submit). Releasing the surfaceBuf before that completes drops
        // the STM/texture while Dawn still has a queue submission pointing
        // at it. The plugin has already issued its consumer End on its own
        // wire; afterCurrentFrame on the core ensures our producer submit
        // completed.
        const reap = () => addon.pluginReleaseSurfaceBuffer(bufId);
        if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(reap);
        else reap();
        return null;
      }
      case "surface.destroy": {
        const surfaceId = p.overlayId as number;
        const surf = surfaces.get(surfaceId);
        if (!surf) return null;   // already destroyed / unknown
        // Mark dead NOW (synchronously) so any pending deferred recycle bails before
        // touching slots the teardown is about to free.
        surf.alive = false;
        // Stop compositing it immediately (remove from its layer + the compositor's
        // surface map), so no further frame samples it.
        overlays.destroy(surfaceId);
        // Free the ring's GPU resources AFTER the compositor submit that last sampled
        // it completes (afterCurrentFrame) -- the currently-presented slot's consumer
        // bracket is open and a GPU read may be in flight. Then, per slot: end any
        // open consumer bracket and release the surfaceBuf (GPU process drops the
        // dmabuf/STM/textures; core reclaims its reservation).
        const slotBufIds = surf.slots.slice();
        const heldConsumerBuf = surf.consumerSlot >= 0 ? surf.slots[surf.consumerSlot] : -1;
        const teardown = (): void => {
          if (heldConsumerBuf >= 0) addon.writeConsumerEnd(heldConsumerBuf);
          for (const bufId of slotBufIds) addon.pluginReleaseSurfaceBuffer(bufId);
          for (const bufId of slotBufIds) surfaceByBuf.delete(bufId);
        };
        if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(teardown);
        else teardown();
        surfaces.delete(surfaceId);
        pendingAlloc.delete(surfaceId);
        return null;
      }
      default:
        throw new Error(`gpu-broker: unknown method '${method}'`);
    }
  };
}
