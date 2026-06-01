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
  // The GPUTexture the plugin renders into this frame (dmabuf-backed, BGRA8).
  getCurrentTexture(): GPUTexture;
  // Hand the rendered texture to the core to composite (drives the fence dance).
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
    const SLOTS = 2;  // double-buffered: producer writes one slot while the
                      // consumer (compositor) holds the other -> smooth animation.
    const r = (await endpoint.request("surface.alloc", {
      connId: conn.connId, width, height, slots: SLOTS, ...allocExtra,
    })) as { overlayId: number; rect: { x: number; y: number; width: number; height: number } };

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

    let write = 0;  // slot the plugin currently renders into
    return {
      width, height, rect: r.rect,
      getCurrentTexture(): GPUTexture {
        let t = slotTex[write];
        if (!t) { t = dawn.wrapTexture(devHandle, plugin.producerTexture(clientId, slotResKey[write])); slotTex[write] = t; }
        return t;
      },
      async present(): Promise<void> {
        plugin.flush(clientId);
        const wireSerial = plugin.wireBytesQueued(clientId);
        const presented = slotBufId[write];
        write = (write + 1) % SLOTS;  // next frame renders into the other slot
        await endpoint.request("surface.present",
          { connId: conn.connId, surfaceBufId: presented, wireSerial });
      },
    };
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
