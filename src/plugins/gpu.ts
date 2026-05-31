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

// Bring up the Worker's GPU (device over its own wire) + return the SDK gpu
// object. `endpoint` brokers side-channel control through the core. `deviceBin`
// /`dawnPath` are absolute paths to the two native modules.
export async function createPluginGpu(
  endpoint: Endpoint, pluginAddonPath: string, dawnPath: string,
): Promise<{ gpu: PluginGpu; pump: () => void }> {
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

  const gpu: PluginGpu = {
    device,
    async createOverlay(opts: CreateOverlayOpts): Promise<Surface> {
      const { width, height } = opts;
      // Ask the core to decide the rect + allocate the shared surface buffer. The
      // Worker reserves the producer texture first (on its wire client) and passes
      // the handles; the core reserves the consumer + sends AllocSurfaceBuf.
      // surfaceBufId is assigned by the core, but reserveProducerTexture needs it
      // up front -> the core returns it in two phases. To keep one round-trip, the
      // core assigns the surfaceBufId; we reserve against it after. So: request
      // alloc with a provisional reserve done AFTER we learn the id is not
      // possible -> instead the core returns the id, we reserve, then confirm.
      // Simpler protocol: core allocates id + consumer; replies id; we reserve
      // producer + send the producer handles in a second 'surface.bindProducer'.
      const r = (await endpoint.request("surface.alloc", {
        connId: conn.connId, width, height,
        layer: opts.layer ?? "overlay", anchor: opts.anchor ?? "center",
        margin: opts.margin ?? 0,
      })) as {
        surfaceBufId: number; rect: { x: number; y: number; width: number; height: number };
      };
      const surfaceBufId = r.surfaceBufId;
      // Reserve the producer texture on our wire client against the core's id, and
      // give the core the handles so it can finish AllocSurfaceBuf.
      const pr = plugin.reserveProducerTexture(clientId, surfaceBufId, width, height);
      plugin.flush(clientId);
      await endpoint.request("surface.bindProducer", {
        connId: conn.connId, surfaceBufId,
        texId: pr.texture.id, texGen: pr.texture.generation,
        devId: pr.device.id, devGen: pr.device.generation,
      });

      let texture: GPUTexture | null = null;
      const surface: Surface = {
        width, height, rect: r.rect,
        getCurrentTexture(): GPUTexture {
          if (!texture) {
            texture = dawn.wrapTexture(devHandle, plugin.producerTexture(clientId, surfaceBufId));
          }
          return texture;
        },
        async present(): Promise<void> {
          // Flush the plugin's render, then ask the core to run the fence dance:
          // ProducerEnd (waits the render) -> ConsumerBegin (waits the producer
          // fence) -> core samples into the compositor -> ConsumerEnd.
          plugin.flush(clientId);
          // The Worker owns the wire client, so it samples its own wire serial
          // (bytesQueued after flush) and passes it; the core's ProducerEnd defers
          // on it (render-before-EndAccess across the wire vs side channel).
          const wireSerial = plugin.wireBytesQueued(clientId);
          await endpoint.request("surface.present",
            { connId: conn.connId, surfaceBufId, wireSerial });
        },
      };
      return surface;
    },
  };

  return { gpu, pump };
}
