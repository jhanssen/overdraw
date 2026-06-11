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
import type { SceneRegistry } from "./scene-registry.js";
import { createSceneRegistry } from "./scene-registry.js";
import { SlotStates, createSlotStates } from "./surface-slots.js";
import { SurfaceConsumer, SurfaceProducer } from "./surface-ring.js";

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
// dmabuf with its own surfaceBufId). The producer renders into one slot while
// the consumer holds a read bracket on the latest-presented slot -> smooth
// animation. The producer half lives in the plugin Worker (gpu.ts); this
// struct is the CONSUMER half on the core side.
interface OverlaySurface {
  surfaceId: number;      // compositor surface id (== overlay broker id)
  width: number;
  height: number;
  slots: number[];        // surfaceBufIds, indexed by ring-slot index
  slotTextures: (GPUTexture | null)[];  // consumer-side wrapped textures, lazily
  slotStates: SlotStates; // shared FREE/ACQUIRED/PRESENTED/DRAINING ownership (SAB)
  consumer: SurfaceConsumer;  // ring consumer half (writes consumer Begin/End +
                              // drives slot transitions PRESENTED -> DRAINING -> FREE)
  alive: boolean;         // false once surface.destroy ran; pending deferred recycles
                          // must bail (their slots may be freed by the teardown).
}

export interface GpuBrokerDeps {
  addon: Addon;
  compositor: CompositorSink;
  overlays: OverlayBroker;
  dawn: DawnWire;
  coreDeviceHandle: bigint;
  // Scene registry: Worker compose handles register their core-side
  // textures here so other SDK consumers (transitions, future intercept)
  // can resolve a SceneHandle.id back to a sampleable GPUTexture on
  // core's device. Optional today; when absent, compose.snapshot /
  // compose.live still work but the SceneHandles they hand back lack a
  // valid .id (transitions.run will reject them with a clear error).
  sceneRegistry?: SceneRegistry;
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
  // Fall back to a broker-private registry when none is supplied.
  // Callers that want to expose Worker SceneHandles to transitions (or
  // any other cross-SDK consumer) pass the shared registry main.ts /
  // the harness construct; tests that only exercise overlays leave it
  // unset and never look at the returned sceneIds.
  const sceneRegistry = deps.sceneRegistry ?? createSceneRegistry();
  const onSurfaceAllocated = deps.onSurfaceAllocated ?? (() => {});
  const onSurfacePresented = deps.onSurfacePresented ?? (() => {});
  const connByPlugin = new Map<string, number>();
  // overlay surfaceId -> geometry pending until its slots are bound.
  const pendingAlloc = new Map<number, { width: number; height: number; overlaySurfaceId: number }>();
  // surfaceBufId -> its OverlaySurface (so present can find the ring).
  const surfaceByBuf = new Map<number, OverlaySurface>();
  // overlay surfaceId -> OverlaySurface.
  const surfaces = new Map<number, OverlaySurface>();
  // Phase 5b compose buffers (snapshot, one-shot): surfaceBufId -> the
  // wrapped core-device producer texture. Held alive until release.
  // (Could later track per-plugin so destroy-on-plugin-stop teardowns
  // these along with overlays.)
  const composeBufs = new Map<number, { texture: GPUTexture; width: number; height: number }>();
  // Phase 5b-live compose rings: any slot's surfaceBufId -> the live ring it
  // belongs to. compose.release deregisters the whole ring on any slot id.
  interface LiveComposeRing {
    surfaceBufIds: number[];
    teardown: () => void;
  }
  const liveComposeRings = new Map<number, LiveComposeRing>();
  // Phase 8: surfaceBufId -> sceneId minted by the scene registry on
  // compose.snapshot / compose.live. Lets compose.release route through
  // the registry (so a transition pinning the scene defers teardown).
  // For live, only the FIRST slot's surfaceBufId maps to the sceneId
  // (the ring shares one logical scene).
  const sceneIdByBuf = new Map<number, number>();

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
        const slotStates = new SlotStates(sab);
        void states;
        // Forward declaration so the consumer's afterReadDone can refer to it
        // and call into compositor + addon without circular issues.
        const slotBufIds: number[] = [];
        const slotTextures: (GPUTexture | null)[] = [];
        const consumer = new SurfaceConsumer({
          slots: {
            surfaceBufId: (slot) => slotBufIds[slot],
            // Lazily wrap the consumer-side texture for this slot on first
            // access (textureFor is called from inside SurfaceConsumer.
            // beginConsume / swapToLatest).
            textureFor: (slot) => {
              if (slotTextures[slot]) return slotTextures[slot];
              const id = slotBufIds[slot];
              if (id === undefined) return null;
              const t = dawn.wrapTexture(coreDeviceHandle, addon.pluginConsumerTexture(id));
              slotTextures[slot] = t;
              return t;
            },
          },
          slotStates,
          writeBegin: (id) => addon.writeConsumerBegin(id),
          writeEnd: (id) => addon.writeConsumerEnd(id),
          afterReadDone: (cb) => {
            if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(cb);
            else cb();
          },
        });
        const surf: OverlaySurface = {
          surfaceId: handle.surfaceId, width, height,
          slots: slotBufIds, slotTextures, slotStates, consumer,
          alive: true,
        };
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
        // (gpu.ts present -> plugin.writeEndAccess); the broker no longer
        // mediates it.
        // Switch the consumer read bracket to the just-presented slot. The
        // SurfaceConsumer.swapToLatest opens the new slot's consumer Begin
        // BEFORE releasing the prior, so the surface always has a valid
        // sampleable texture for renderFrame -- and schedules the prior's
        // consumer End + DRAINING->FREE on afterCurrentFrame so it doesn't
        // race the just-issued GPU read.
        const tex = surf.consumer.swapToLatest(slotIdx);
        compositor.setSurfaceTexture?.(surf.surfaceId, tex, surf.width, surf.height);
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
        // p is the worker-side request bag; SDK has already validated shape.
        // eslint-disable-next-line no-restricted-syntax
        const windows = (p.windows as unknown as number[]) ?? [];

        const alloc = await pAllocCompose(addon, connId, w, h,
          ctId, ctGen, cdId, cdGen, pluginSerial);

        // The core's wrapped wgpu::Texture for this surface (the producer
        // side: TextureBinding|CopySrc|RenderAttachment -- compositor.h
        // reserveCoreComposeTexture). pluginConsumerTexture returns
        // whichever side is on the core's device, regardless of role.
        const tex = dawn.wrapTexture(coreDeviceHandle,
          addon.pluginConsumerTexture(alloc.surfaceBufId));
        composeBufs.set(alloc.surfaceBufId, { texture: tex, width: w, height: h });

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
        // Register with the scene registry so transitions (or any
        // future consumer) can resolve sceneId -> core-side texture.
        // The teardown closure runs only after BOTH the Worker's
        // compose.release and any holding pins have settled.
        const bufId = alloc.surfaceBufId;
        const sceneId = sceneRegistry.register(
          { texture: tex, outW: w, outH: h },
          () => {
            composeBufs.delete(bufId);
            const reap = () => addon.pluginReleaseSurfaceBuffer(bufId);
            if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(reap);
            else reap();
          },
        );
        sceneIdByBuf.set(bufId, sceneId);
        return { surfaceBufId: bufId, width: w, height: h, sceneId };
      }
      case "compose.live": {
        // Phase 5b-live: Worker plugin asked for a live compose. The plugin
        // has reserved SLOTS consumer textures on its own wire (one per ring
        // slot) and sent their handles. We:
        //   1. Allocate SLOTS dmabufs (one per slot via coreAllocComposeBufferW).
        //   2. Build a core-side SurfaceProducer over the ring; the per-slot
        //      wgpu::Texture comes from addon.pluginConsumerTexture (which
        //      for AllocComposeBuf returns the core-side / producer-side
        //      texture).
        //   3. Build a SAB-backed SlotStates and return it in the reply.
        //   4. Register a per-frame callback: tryAcquire a FREE slot,
        //      composeIntoView, presentSync. If no FREE slot is available
        //      (consumer hogging all of them), skip the frame -- the next
        //      consumer release will wake the next produce attempt.
        const connId = connByPlugin.get(pluginName);
        if (connId === undefined) throw new Error("compose.live: no plugin conn");
        const w = p.width as number, h = p.height as number;
        if (!w || !h) throw new Error("compose.live: bad dims");
        const slotsN = (p.slots as number) ?? 3;
        // SDK pre-validates the consumers / windows shape; cast at the boundary.
        // eslint-disable-next-line no-restricted-syntax
        const consumers = p.consumers as unknown as Array<{
          texId: number; texGen: number; devId: number; devGen: number;
          wireSerial: bigint;
        }>;
        if (!consumers || consumers.length !== slotsN) {
          throw new Error(`compose.live: expected ${slotsN} consumer handles, got ${consumers?.length}`);
        }
        // eslint-disable-next-line no-restricted-syntax
        const windows = (p.windows as unknown as number[]) ?? [];

        if (!compositor.composeIntoView || !compositor.registerLiveProducer) {
          throw new Error("compose.live: compositor lacks live-producer machinery");
        }

        // Allocate one dmabuf per slot. Each AllocComposeBuf call reserves
        // a core producer texture, sends the wire op, awaits inject.
        const slotBufIds: number[] = [];
        for (let i = 0; i < slotsN; i++) {
          const con = consumers[i];
          const a = await pAllocCompose(addon, connId, w, h,
            con.texId, con.texGen, con.devId, con.devGen, con.wireSerial);
          slotBufIds.push(a.surfaceBufId);
        }

        // Wrap each slot's CORE-side texture lazily as a GPUTexture on the
        // core device. The core's wgpu::Texture for AllocComposeBuf is
        // returned by addon.pluginConsumerTexture(surfaceBufId).
        const slotTextures: (GPUTexture | null)[] = new Array(slotsN).fill(null);
        const slotViews: (GPUTextureView | null)[] = new Array(slotsN).fill(null);
        const textureFor = (slot: number): GPUTexture | null => {
          if (slotTextures[slot]) return slotTextures[slot];
          const t = dawn.wrapTexture(coreDeviceHandle,
            addon.pluginConsumerTexture(slotBufIds[slot]));
          slotTextures[slot] = t;
          return t;
        };
        const viewFor = (slot: number): GPUTextureView => {
          if (slotViews[slot]) return slotViews[slot] as GPUTextureView;
          const t = textureFor(slot);
          if (!t) throw new Error(`compose.live: no texture for slot ${slot}`);
          const v = t.createView();
          slotViews[slot] = v;
          return v;
        };

        // Build the SAB + slot states. The SAB is sent to the plugin in
        // the reply so both sides share the same atomic slot states.
        const { sab } = createSlotStates(slotsN);
        const slotStates = new SlotStates(sab);

        // Build the core-side producer. writeBegin/writeEnd ride the core
        // wire (the core IS the producer for compose-live). onPresented
        // is a no-op -- the SAB notify in slotStates.present() is what
        // signals the consumer; no round-trip needed.
        const producer = new SurfaceProducer({
          slots: {
            surfaceBufId: (slot) => slotBufIds[slot],
            textureFor,
          },
          slotStates,
          writeBegin: (id) => addon.writeProducerBegin(id),
          writeEnd: (id) => addon.writeProducerEnd(id),
          onPresented: () => {},
          // Compose-live: pull-based consumer (plugin samples on its own
          // clock). Enforce single-PRESENTED invariant so the plugin's
          // awaitPresentedSlot returns the LATEST, not whichever slot got
          // PRESENTED first in a backlog of producer cycles.
          demoteStaleOnPresent: true,
        });

        // Per-frame callback: tryAcquire FREE slot, composeIntoView (without
        // producerSurfaceBufId; the SurfaceProducer's tryAcquire / presentSync
        // already write the producer Begin/End brackets on the core wire),
        // presentSync.
        const onFrame = (): void => {
          const got = producer.tryAcquire();
          if (!got) return;  // no FREE slot; skip this frame
          compositor.composeIntoView?.({
            outputId: 0,
            targetView: viewFor(got.slot),
            windows,
            outW: w, outH: h,
            // Intentionally no producerSurfaceBufId -- the SurfaceProducer
            // already wraps the pass in writeProducerBegin/End.
          });
          producer.presentSync();
        };
        const live = compositor.registerLiveProducer(onFrame);

        // Bookkeeping for compose.release: any slot id maps to this ring.
        const ring: LiveComposeRing = {
          surfaceBufIds: slotBufIds.slice(),
          teardown: () => {
            live.unregister();
            for (const id of slotBufIds) {
              const reap = () => addon.pluginReleaseSurfaceBuffer(id);
              if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(reap);
              else reap();
            }
          },
        };
        for (const id of slotBufIds) liveComposeRings.set(id, ring);

        // Register the live scene. resolveTexture returns whichever
        // slot is currently PRESENTED (the producer's
        // demoteStaleOnPresent guarantees at most one). The
        // representative .texture is slot 0's wrap; per-frame
        // consumers (transitions) use resolveTexture instead.
        const repTex = textureFor(0);
        if (!repTex) throw new Error("compose.live: slot 0 texture not wrappable");
        const sceneId = sceneRegistry.register(
          {
            texture: repTex, outW: w, outH: h,
            resolveTexture: (): GPUTexture | null => {
              const slot = slotStates.presentedSlot();
              if (slot < 0) return null;
              return textureFor(slot);
            },
          },
          () => { ring.teardown(); },
        );
        // Map the first slot's surfaceBufId to the sceneId so
        // compose.release can find it (Worker SDK sends the slot list;
        // we look up by slot 0 like the legacy LiveComposeRing map).
        sceneIdByBuf.set(slotBufIds[0], sceneId);

        return {
          slotsSab: sab,
          slots: slotBufIds.map((id) => ({ surfaceBufId: id })),
          sceneId,
        };
      }
      case "compose.release": {
        // Plugin is done with a compose snapshot or live ring. Both
        // route through the scene registry: a transition currently
        // pinning the scene defers the underlying surfaceBuf release
        // until the transition completes (unpin).
        // eslint-disable-next-line no-restricted-syntax
        const arr = p.surfaceBufIds as unknown as number[] | undefined;
        if (arr && Array.isArray(arr)) {
          // Live ring release. Look up the sceneId via slot 0.
          const sceneId = sceneIdByBuf.get(arr[0]);
          if (sceneId !== undefined) {
            sceneIdByBuf.delete(arr[0]);
            // Drop the ring map for every slot id so a (defensive)
            // future lookup doesn't see a stale entry. The actual
            // teardown still fires once the registry's pin count
            // reaches 0.
            const ring = liveComposeRings.get(arr[0]);
            if (ring) for (const id of ring.surfaceBufIds) liveComposeRings.delete(id);
            sceneRegistry.unregister(sceneId);
          }
          return null;
        }
        const bufId = p.surfaceBufId as number;
        if (bufId === undefined) throw new Error("compose.release: bad surfaceBufId(s)");
        const sceneId = sceneIdByBuf.get(bufId);
        if (sceneId !== undefined) {
          sceneIdByBuf.delete(bufId);
          sceneRegistry.unregister(sceneId);
        }
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
        // Close any open consumer bracket. SurfaceConsumer.destroy() routes
        // through endConsume which schedules its End + free on afterReadDone
        // (afterCurrentFrame) so a GPU read in flight completes first.
        surf.consumer.destroy();
        // Free the GPU process side of each slot's surfaceBuf. Also gated on
        // afterCurrentFrame because the consumer.destroy()'s recycles run on
        // that same hook and need to fire first.
        const slotBufIds = surf.slots.slice();
        const teardown = (): void => {
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
