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

interface OverlaySurface {
  surfaceBufId: number;
  surfaceId: number;      // compositor surface id (== overlay broker id)
  width: number;
  height: number;
  consumerOpen: boolean;  // a consumer read bracket is currently open
}

export interface GpuBrokerDeps {
  addon: Addon;
  compositor: CompositorSink;
  overlays: OverlayBroker;
  dawn: DawnWire;
  coreDeviceHandle: bigint;
}

export function createGpuBroker(deps: GpuBrokerDeps) {
  const { addon, compositor, overlays, dawn, coreDeviceHandle } = deps;
  const connByPlugin = new Map<string, number>();
  // overlay surfaceId -> {pending geometry} between alloc and bindProducer.
  const pendingAlloc = new Map<number, { width: number; height: number }>();
  // overlay surfaceId -> surfaceBufId (set at bindProducer).
  const bufBySurface = new Map<number, number>();
  const surfaces = new Map<number, OverlaySurface>();

  return async function onRequest(pluginName: string, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, number | string | bigint>;
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
        // Core decides the rect + layer (overlay broker) and assigns a surfaceId.
        // The actual GBM buffer is allocated at bindProducer (it needs the
        // Worker's producer texture handles). Returns the id + rect.
        const width = p.width as number, height = p.height as number;
        const handle = overlays.create(pluginName, {
          layer: (p.layer as OverlayLayer) ?? "overlay",
          anchor: (p.anchor as OverlayAnchor) ?? "center", width, height, margin: p.margin as number,
        });
        pendingAlloc.set(handle.surfaceId, { width, height });
        return { surfaceBufId: handle.surfaceId, rect: handle.rect };
      }
      case "surface.bindProducer": {
        const surfaceId = p.surfaceBufId as number;
        const pend = pendingAlloc.get(surfaceId);
        const connId = connByPlugin.get(pluginName);
        if (!pend || connId === undefined) throw new Error("bindProducer: bad state");
        const alloc = await pAlloc(addon, connId, pend.width, pend.height,
          p.texId as number, p.texGen as number, p.devId as number, p.devGen as number);
        surfaces.set(alloc.surfaceBufId,
          { surfaceBufId: alloc.surfaceBufId, surfaceId, width: pend.width, height: pend.height, consumerOpen: false });
        bufBySurface.set(surfaceId, alloc.surfaceBufId);
        pendingAlloc.delete(surfaceId);
        // Open the producer bracket so the plugin can render into the texture.
        await pProducerBegin(addon, alloc.surfaceBufId);
        return null;
      }
      case "surface.present": {
        const connId = connByPlugin.get(pluginName);
        const surfaceBufId = bufBySurface.get(p.surfaceBufId as number);
        if (connId === undefined || surfaceBufId === undefined) throw new Error("present: unknown surface");
        const surf = surfaces.get(surfaceBufId);
        if (!surf) throw new Error("present: no surface record");
        // Producer done (deferred on the plugin-wire serial the Worker passed).
        addon.pluginSurfaceProducerEndW(surfaceBufId, (p.wireSerial as bigint) ?? 0n);
        // Consumer waits the producer fence; install the consumer texture so the
        // compositor samples it. The read bracket stays OPEN so the compositor can
        // sample within it each frame (ConsumerEnd would release dmabuf access
        // before renderFrame samples). The bracket is ended at the next present
        // (before re-rendering) or on destroy. This is a single-buffer static
        // overlay model; double-buffering for smooth animation is future work.
        if (surf.consumerOpen) { addon.pluginSurfaceConsumerEnd(surfaceBufId); surf.consumerOpen = false; }
        await pConsumerBegin(addon, surfaceBufId);
        surf.consumerOpen = true;
        const tex = dawn.wrapTexture(coreDeviceHandle, addon.pluginConsumerTexture(surfaceBufId));
        compositor.setSurfaceTexture?.(surf.surfaceId, tex, surf.width, surf.height);
        return null;
      }
      default:
        throw new Error(`gpu-broker: unknown method '${method}'`);
    }
  };
}
