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

// Minimal shapes for the two native modules the Worker loads.
interface PluginAddon {
  openWireClient(fd: number): number;
  reserveInstance(clientId: number): { id: number; generation: number };
  startDevice(clientId: number): void;
  pump(clientId: number): { ready: boolean; failed: boolean };
  instanceHandle(clientId: number): bigint;
  deviceHandle(clientId: number): bigint;
  deviceWireHandle(clientId: number): { id: number; generation: number };
  reserveProducerTexture(clientId: number, surfaceBufId: number, w: number, h: number):
    { texture: { id: number; generation: number }; device: { id: number; generation: number } };
  producerTexture(clientId: number, surfaceBufId: number): bigint;
  flush(clientId: number): void;
  wireBytesQueued(clientId: number): bigint;
}
interface DawnModule {
  wrapDevice(instanceHandle: bigint, deviceHandle: bigint): GPUDevice;
  wrapTexture(deviceHandle: bigint, textureHandle: bigint): GPUTexture;
  globals: { GPUTextureUsage: typeof GPUTextureUsage; GPUBufferUsage: typeof GPUBufferUsage; GPUMapMode: typeof GPUMapMode };
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
export async function createPluginGpu(
  endpoint: Endpoint, pluginAddonPath: string, dawnPath: string,
): Promise<{ gpu: PluginGpu; pump: () => void; makeRingSurface: RingMaker }> {
  const require = createRequire(import.meta.url);
  const plugin = require(pluginAddonPath) as PluginAddon;
  const dawn = require(dawnPath) as DawnModule;

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
  const pump = (): void => { plugin.pump(clientId); };

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
      const pr = plugin.reserveProducerTexture(clientId, resKey, width, height);
      plugin.flush(clientId);
      const bound = (await endpoint.request("surface.bindProducer", {
        connId: conn.connId, overlayId: r.overlayId,
        texId: pr.texture.id, texGen: pr.texture.generation,
        devId: pr.device.id, devGen: pr.device.generation,
      })) as { surfaceBufId: number };
      slotResKey.push(resKey);
      slotBufId.push(bound.surfaceBufId);
      slotTex.push(null);
    }

    let acquired = -1;   // the slot getCurrentTexture handed out, until present()
    return {
      width, height, rect: r.rect,
      async getCurrentTexture(): Promise<GPUTexture> {
        if (acquired >= 0) {
          // Re-acquire within the same frame returns the same texture (idempotent
          // until present()). A real second producer would CAS its own slot.
          return wrapSlot(acquired);
        }
        // Claim a FREE slot; if none, await a state change (a DRAINING slot freeing)
        // and retry. waitAsync (not wait) so the Worker event loop keeps turning
        // (watchdog pongs) while backpressured.
        for (;;) {
          const slot = slotStates.tryAcquire();
          if (slot >= 0) { acquired = slot; return wrapSlot(slot); }
          // No free slot: wait until ANY slot's state changes, then retry. Wait on
          // slot 0; the core notifies the freed slot's index, but state changes are
          // infrequent enough that polling all on wake is fine -- re-loop tryAcquire.
          const w = Atomics.waitAsync(slotStates.states, 0, slotStates.state(0));
          if (w.async) await w.value; else await Promise.resolve();
        }
      },
      async present(): Promise<void> {
        if (acquired < 0) throw new Error("surface.present() without a prior getCurrentTexture()");
        const slot = acquired;
        acquired = -1;
        plugin.flush(clientId);
        const wireSerial = plugin.wireBytesQueued(clientId);
        // Ownership: ACQUIRED -> PRESENTED (atomic; the core demotes the prior
        // PRESENTED to DRAINING and frees it once its read completes).
        slotStates.present(slot);
        await endpoint.request("surface.present",
          { connId: conn.connId, surfaceBufId: slotBufId[slot], slot, wireSerial });
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

  return { gpu, pump, makeRingSurface };
}
