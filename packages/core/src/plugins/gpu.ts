// Plugin Worker-side GPU + surface SDK (C-M4 step 4c). Runs INSIDE the Worker.
// Brings up the plugin's own Dawn device over its own wire client (the core
// brokers the side channel) and exposes:
//   sdk.gpu                     -> the wrapped GPUDevice (dawn.node)
//   sdk.createOverlay(opts)     -> a Surface the plugin renders into; the core
//                                  decides the rect + composites it on a layer.
//
// The plugin addon (overdraw_plugin_native.node) owns the wire client; dawn.node
// wraps the device/textures. All side-channel control goes through the core via
// the Endpoint (request()).

import { createRequire } from "node:module";

import type { Endpoint, Json } from "./protocol.js";
import { SlotStates } from "./surface-slots.js";
import { SurfaceProducer } from "./surface-ring.js";

// Minimal shapes for the two native modules the Worker loads.
interface PluginAddon {
  openWireClient(fd: number): number;
  reserveInstance(clientId: number): { id: number; generation: number };
  startDevice(clientId: number): void;
  pump(clientId: number): { ready: boolean; failed: boolean };
  instanceHandle(clientId: number): bigint;
  deviceHandle(clientId: number): bigint;
  deviceWireHandle(clientId: number): { id: number; generation: number };
  // `wireSerial` (bigint) is the PLUGIN-wire ordering serial sampled INSIDE
  // this call AFTER the flush that committed the reserve. Forwarded to
  // pluginAllocSurfaceBufferW so the GPU process can gate the producer-side
  // InjectTexture on the plugin wire reader catching up past it. The single
  // chokepoint that makes "captured too early" structurally impossible.
  reserveProducerTexture(clientId: number, surfaceBufId: number, w: number, h: number):
    { texture: { id: number; generation: number }; device: { id: number; generation: number }; wireSerial: bigint };
  producerTexture(clientId: number, surfaceBufId: number): bigint;
  // Forget the slot WITHOUT recycling the wire id (deferred-reclaim policy:
  // see WorkerWireClient::forgetProducerReservation). Today gpu.ts does not
  // call this -- the ring's slots are simply left in producerReservations_
  // for the life of the worker; future use cases (e.g. surface migration)
  // that need to explicitly forget a slot would call this.
  forgetProducerReservation(clientId: number, resKey: number): void;
  // Phase 5b: consumer-side reserve for compose buffers (the plugin is the
  // consumer; the core produces). Same shape as reserveProducerTexture;
  // wireSerial is forwarded to coreAllocComposeBufferW.
  reserveConsumerTexture(clientId: number, surfaceBufId: number, w: number, h: number):
    { texture: { id: number; generation: number }; device: { id: number; generation: number }; wireSerial: bigint };
  consumerTexture(clientId: number, surfaceBufId: number): bigint;
  forgetConsumerReservation(clientId: number, resKey: number): void;
  flush(clientId: number): void;
  // In-band producer Begin/End on the plugin wire (replaces the core-mediated
  // ProducerBegin ctrl round-trip / ProducerEnd WireBarrier deferral). The
  // Worker writes Begin as it claims a slot (kind=1, FIFO-ordered before its
  // render commands) and End after its render submit (kind=2, after them).
  // Synchronous; appendFrame flushes staged wire bytes first.
  writeBeginAccess(clientId: number, surfaceBufId: number): void;
  writeEndAccess(clientId: number, surfaceBufId: number): void;
  // Phase 5b: in-band consumer Begin/End on the plugin wire (compose buffers
  // where the plugin is the consumer).
  writeConsumerBegin(clientId: number, surfaceBufId: number): void;
  writeConsumerEnd(clientId: number, surfaceBufId: number): void;
}
interface DawnModule {
  wrapDevice(instanceHandle: bigint, deviceHandle: bigint): GPUDevice;
  wrapTexture(deviceHandle: bigint, textureHandle: bigint): GPUTexture;
  // The full set of WebGPU `GPU*` constructors + flag enums (GPUBufferUsage,
  // GPUShaderStage, GPUTextureUsage, GPUMapMode, GPUColorWrite, GPUDevice, ...).
  // dawn.node does NOT install these on globalThis itself; the host does (see
  // installWebGPUGlobals) so plugin code can use them as standard globals.
  globals: Record<string, unknown>;
}

// Install dawn.node's WebGPU globals (`GPU*`) onto globalThis so plugin code uses
// the standard browser-shaped constants -- GPUBufferUsage.UNIFORM,
// GPUShaderStage.FRAGMENT, GPUTextureUsage.RENDER_ATTACHMENT, etc. -- instead of
// hardcoding spec bitflag values. dawn.node exposes them on `globals` but does not
// assign them; we do, once, in the Worker after the module loads. Existing globals
// (e.g. a future native WebGPU in Node) are NOT overwritten.
function installWebGPUGlobals(globals: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(globals)) {
    // Reflect avoids casting globalThis to an indexable type; skip names already
    // defined (do not clobber a future native WebGPU in Node).
    if (!Reflect.has(globalThis, name)) Reflect.set(globalThis, name, value);
  }
}

// Worker-local unique key for each producer-texture reservation (the wire-client
// reservation map is keyed by it). Decoupled from the core's surfaceBufId so a
// surface's ring slots never collide.
let nextResKey = 1;

// The surface.alloc response. The slot-state SAB is NOT Json (it rides the
// structured-clone transport), so the result is validated here at the trust
// boundary rather than blind-cast off the Json-typed request result.
interface AllocResult {
  overlayId: number;
  rect: { x: number; y: number; width: number; height: number };
  slotsSab: SharedArrayBuffer;
}
function parseAllocResult(res: unknown): AllocResult {
  if (typeof res !== "object" || res === null) throw new Error("surface.alloc: bad result");
  const r = res as Record<string, unknown>;
  const rect = r.rect as Record<string, unknown> | undefined;
  if (typeof r.overlayId !== "number" || !rect
      || typeof rect.x !== "number" || typeof rect.y !== "number"
      || typeof rect.width !== "number" || typeof rect.height !== "number"
      || !(r.slotsSab instanceof SharedArrayBuffer)) {
    throw new Error("surface.alloc: malformed result");
  }
  return {
    overlayId: r.overlayId,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    slotsSab: r.slotsSab,
  };
}

export type OverlayLayer = "background" | "below" | "above" | "overlay";
export type OverlayAnchor =
  | "top-left" | "top" | "top-right" | "left" | "center" | "right"
  | "bottom-left" | "bottom" | "bottom-right";

export interface CreateOverlayOpts {
  layer?: OverlayLayer;       // default "overlay"
  anchor?: OverlayAnchor;     // default "center"
  width: number;
  height: number;
  margin?: number;
}

export interface Surface {
  readonly width: number;
  readonly height: number;
  readonly rect: { x: number; y: number; width: number; height: number };
  // Acquire the GPUTexture to render into this frame (dmabuf-backed, BGRA8). ASYNC:
  // a swapchain-style acquire -- it claims a FREE ring slot, awaiting one if every
  // slot is in use (producer rendering / consumer reading / draining). The returned
  // texture is owned EXCLUSIVELY until present(); the ring guarantees it is not the
  // slot the consumer/GPU is using.
  getCurrentTexture(): Promise<GPUTexture>;
  // Hand the acquired texture to the core to composite (drives the fence dance).
  present(): Promise<void>;
  // Tear down the surface: the core stops compositing it and frees the ring's GPU
  // resources (dmabuf/STM/textures on both devices); the worker drops its wrapped
  // textures + producer reservations. After destroy() the surface is unusable.
  destroy(): Promise<void>;
}

export interface PluginGpu {
  device: GPUDevice;
  createOverlay(opts: CreateOverlayOpts): Promise<Surface>;
}

// Internal producer/consumer ring allocator (NOT plugin-facing). `allocExtra`
// carries the geometry source + any tags (anchor for overlays; an explicit rect +
// `decorates` window id for decorations). createDecoration (decorations.ts) uses
// this to place a ring at the inset outer rect; there is no public explicit-rect
// surface API yet (add one when a concrete use case defines the args).
export type RingMaker = (width: number, height: number, allocExtra: Record<string, Json>) => Promise<Surface>;

// Bring up the Worker's GPU (device over its own wire) + return the SDK gpu
// object. `endpoint` brokers side-channel control through the core. `deviceBin`
// /`dawnPath` are absolute paths to the two native modules.
//
// The returned `composeDeps` is the internal handle createWorkerCompose
// (compose-sdk.ts) needs to participate in cross-device dmabuf compose
// (phase 5b). Not plugin-facing; consumed by the loader.
export interface WorkerGpuInternals {
  clientId: number;
  plugin: PluginAddon;
  dawn: DawnModule;
  devHandle: bigint;
  allocSurfaceBufId: () => number;
}
export async function createPluginGpu(
  endpoint: Endpoint, pluginAddonPath: string, dawnPath: string,
): Promise<{ gpu: PluginGpu; pump: () => void; makeRingSurface: RingMaker;
            stop: () => void; internals: WorkerGpuInternals }> {
  const require = createRequire(import.meta.url);
  const plugin = require(pluginAddonPath) as PluginAddon;
  const dawn = require(dawnPath) as DawnModule;

  // Expose the WebGPU GPU* globals (enums + types) so plugin code uses the standard
  // names (GPUBufferUsage.UNIFORM, GPUShaderStage.FRAGMENT, ...) like browser WebGPU.
  installWebGPUGlobals(dawn.globals);

  // 1) Ask the core to create a connection; it returns the client-end fd.
  const conn = (await endpoint.request("gpu.connect")) as { connId: number; fd: number };
  const clientId = plugin.openWireClient(conn.fd);

  // 2) Reserve the instance; the core injects it over the side channel.
  const inst = plugin.reserveInstance(clientId);
  await endpoint.request("gpu.injectInstance",
    { connId: conn.connId, id: inst.id, generation: inst.generation });

  // 3) Request the device; pump until ready.
  plugin.startDevice(clientId);
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      const st = plugin.pump(clientId);
      if (st.failed) { clearInterval(t); reject(new Error("plugin device bring-up failed")); return; }
      if (st.ready) { clearInterval(t); resolve(); }
    }, 4);
  });

  // 4) Relay the device handle so the GPU process ticks it.
  const dwh = plugin.deviceWireHandle(clientId);
  await endpoint.request("gpu.setTickDevice",
    { connId: conn.connId, id: dwh.id, generation: dwh.generation });

  const device = dawn.wrapDevice(plugin.instanceHandle(clientId), plugin.deviceHandle(clientId));
  const devHandle = plugin.deviceHandle(clientId);

  // Steady-state pump: keep the wire flowing so device async ops resolve.
  const pump = (): void => { if (!stopped) plugin.pump(clientId); };

  // Quiesced on shutdown (bootstrap's onShutdown path, BEFORE the Worker is
  // terminated). Once set, surface ops (getCurrentTexture/present) bail cleanly so a
  // plugin's still-running render loop unwinds WITHOUT issuing new wire/device work
  // into a wire that teardown is tearing down -- the race that made dawn.node throw
  // fatally (ThrowAsJavaScriptException with no JS frame) when worker.terminate()
  // killed the thread mid-submit/mid-wire-callback.
  let stopped = false;

  // Shared producer/consumer ring setup. `allocExtra` carries the geometry source
  // (anchor params for overlays, an explicit rect for decorations); the core's
  // surface.alloc returns the surfaceId + the decided rect. Both surface kinds use
  // the identical slot-bind + present machinery.
  async function makeRingSurface(
    width: number, height: number,
    allocExtra: Record<string, Json>,
  ): Promise<Surface> {
    const SLOTS = 3;  // triple-buffered ring. Slot ownership is tracked in a
                      // SharedArrayBuffer (surface-slots.ts): at steady pipelined
                      // speed up to one slot is ACQUIRED (producer rendering), one
                      // PRESENTED (consumer sampling), one DRAINING (superseded,
                      // awaiting the consumer's GPU read to complete) -> a 3rd slot
                      // keeps a FREE one usually available; getCurrentTexture awaits
                      // when all are busy (correct backpressure).
    const r = parseAllocResult(await endpoint.request("surface.alloc", {
      connId: conn.connId, width, height, slots: SLOTS, ...allocExtra,
    }));
    const slotStates = new SlotStates(r.slotsSab);

    // Per slot: reserve a producer texture under a UNIQUE worker-local key, then
    // bindProducer (allocates the shared dmabuf server-side, returns surfaceBufId).
    const slotResKey: number[] = [];
    const slotBufId: number[] = [];
    const slotTex: (GPUTexture | null)[] = [];
    for (let i = 0; i < SLOTS; i++) {
      const resKey = nextResKey++;
      // Single-call reserve + flush + serial capture (native chokepoint). The
      // returned `wireSerial` is the PLUGIN-wire bytesQueued AFTER the flush;
      // forward it to surface.bindProducer so the broker passes it to
      // AllocSurfaceBuf -- the GPU process gates the producer-side
      // InjectTexture on the plugin wire reader catching up past it.
      const pr = plugin.reserveProducerTexture(clientId, resKey, width, height);
      const bound = (await endpoint.request("surface.bindProducer", {
        connId: conn.connId, overlayId: r.overlayId,
        texId: pr.texture.id, texGen: pr.texture.generation,
        devId: pr.device.id, devGen: pr.device.generation,
        reservePointSerial: pr.wireSerial,
      })) as { surfaceBufId: number };
      slotResKey.push(resKey);
      slotBufId.push(bound.surfaceBufId);
      slotTex.push(null);
    }

    let destroyed = false;
    // Build the SurfaceProducer abstraction. It owns the slot-state CAS,
    // the producer-wire Begin/End writes, and the texture-handing. The
    // Surface interface plugins use (getCurrentTexture/present/destroy)
    // is a thin facade -- the meat lives in surface-ring.ts.
    const producer = new SurfaceProducer({
      slots: {
        surfaceBufId: (slot) => slotBufId[slot],
        textureFor: wrapSlot,
      },
      slotStates,
      writeBegin: (id) => plugin.writeBeginAccess(clientId, id),
      writeEnd: (id) => plugin.writeEndAccess(clientId, id),
      onPresented: async (slot, surfaceBufId) => {
        await endpoint.request("surface.present",
          { connId: conn.connId, surfaceBufId, slot });
      },
      isStopped: () => stopped,
    });
    return {
      width, height, rect: r.rect,
      async getCurrentTexture(): Promise<GPUTexture> {
        if (destroyed) throw new Error("surface used after destroy()");
        const r = await producer.acquire();
        return r.texture;
      },
      async present(): Promise<void> { await producer.present(); },
      async destroy(): Promise<void> {
        if (destroyed) return;
        destroyed = true;
        // Ask the core to stop compositing + free the ring's GPU resources (it gates
        // the GPU-process free on its own read completing).
        await endpoint.request("surface.destroy", { connId: conn.connId, overlayId: r.overlayId });
        // Worker-side: drop the wrapped producer textures. The deferred-reclaim
        // policy for the recycled-handle hazard lives in the WorkerWireClient
        // (see WorkerWireClient::forgetProducerReservation in worker_wire.h):
        // there is no API on this side that recycles a wire id, by design.
        // Native textures/STMs/dmabuf are freed by ReleaseSurfaceBuf above; the
        // ring's producer-texture wire ids stay reserved on the wire client
        // for the worker's lifetime (small, bounded).
        for (let i = 0; i < SLOTS; i++) slotTex[i] = null;
        plugin.flush(clientId);
      },
    };

    function wrapSlot(slot: number): GPUTexture {
      let t = slotTex[slot];
      if (!t) { t = dawn.wrapTexture(devHandle, plugin.producerTexture(clientId, slotResKey[slot])); slotTex[slot] = t; }
      return t;
    }
  }

  const gpu: PluginGpu = {
    device,
    createOverlay(opts: CreateOverlayOpts): Promise<Surface> {
      return makeRingSurface(opts.width, opts.height, {
        layer: opts.layer ?? "overlay", anchor: opts.anchor ?? "center",
        margin: opts.margin ?? 0,
      });
    },
  };

  // Quiesce the GPU layer for shutdown: stop the pump + make surface ops bail, so
  // no new wire/device work is issued while the Worker is torn down.
  const stop = (): void => { stopped = true; };

  // Internals exposed to the loader so it can build sdk.compose (phase 5b)
  // without re-doing the device bring-up. Not plugin-facing.
  const internals: WorkerGpuInternals = {
    clientId, plugin, dawn, devHandle,
    allocSurfaceBufId: () => nextResKey++,
  };

  return { gpu, pump, makeRingSurface, stop, internals };
}
