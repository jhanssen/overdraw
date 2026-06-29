// sdk.compose -- scene-compose primitive (core-plugin-api.md §6).
//
// Two methods: scene() returns one composed texture; windows() returns one
// texture per window. Each takes a mode -- 'snapshot' (one-shot at call
// time, frozen thereafter) or 'live' (texture kept in sync with what the
// compositor would draw for that window list, re-rendered on every
// on-screen frame).
//
// In-thread bundled plugins only (Phase 5a): GPUTexture handles cross the
// boundary by reference because the plugin shares core's device. Worker
// plugins lack this path; sdk.compose is absent on their SDK by shape.
// Phase 5b adds the Worker transport (dmabuf import onto the plugin's
// device).

import type {
  LiveSceneHandle, LiveWindowCompHandle,
} from "../gpu/compositor.js";
import type { CompositorSink } from "../protocols/ctx.js";
import type { Endpoint } from "./protocol.js";
import type { SceneRegistry } from "./scene-registry.js";
import { createSceneRegistry } from "./scene-registry.js";
import { SlotStates } from "./surface-slots.js";
import { SurfaceConsumer, awaitPresentedSlot } from "./surface-ring.js";

export type ComposeMode = "snapshot" | "live";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneHandle {
  // The composed texture. Owned by core; the caller must NOT .destroy() it.
  // Validity ends at release().
  //
  // For snapshot (in-thread or Worker) and live-in-thread, `texture` can
  // be sampled at any time between scene() and release(). For live-Worker,
  // each frame lives in a different ring slot's dmabuf; sample(cb) is the
  // ONLY valid way to read it (the cb runs with whichever slot the latest
  // present landed in, under an open consumer Begin/End bracket on the
  // plugin wire). For all other variants, sample(cb) just runs cb with
  // `texture` immediately -- plugins use sample() unconditionally so the
  // same code works in either mode.
  texture: GPUTexture;
  outW: number;
  outH: number;
  // Opaque scene id, valid across the SDK boundary (Worker postMessage
  // safe; in-thread by reference). Plugins pass this to other SDK
  // surfaces that consume scenes -- e.g. sdk.transitions.run(outputId,
  // {fromSceneId: from.id, toSceneId: to.id, ...}). Plugins do NOT
  // construct ids themselves.
  readonly id: number;
  sample<T>(cb: (texture: GPUTexture) => T | Promise<T>): Promise<T>;
  release(): Promise<void>;
}

export interface WindowComposition {
  windows: ReadonlyArray<{
    id: number;
    texture: GPUTexture;
    rect: Rect;
  }>;
  release(): Promise<void>;
}

export interface PluginCompose {
  scene(args: {
    outputId: number;
    windows: ReadonlyArray<number>;
    mode: ComposeMode;
    outW?: number;
    outH?: number;
  }): Promise<SceneHandle>;

  windows(args: {
    outputId: number;
    windows: ReadonlyArray<{ id: number; rect?: Rect }>;
    mode: ComposeMode;
  }): Promise<WindowComposition>;
}

// The scene-flattening + region-resolution step, shared by the in-thread SDK
// (composeRegion / registerLiveScene) and the Worker broker (composeIntoView)
// so subsurface expansion and device-scale mapping have ONE source of truth
// across transports. `flatten` re-expands the window set every call -- callers
// invoke it once for snapshots, or hand it to registerLiveScene/onFrame for a
// per-frame re-flatten. Returns null when the output has no live region.
export interface SceneFlattenDeps {
  flattenWindows: (surfaceIds: ReadonlyArray<number>) => number[];
  outputRegion: (outputId: number) =>
    { x: number; y: number; w: number; h: number; scale: number } | null;
}

export function sceneDrawParams(
  deps: SceneFlattenDeps, outputId: number, windows: ReadonlyArray<number>,
): { region: { x: number; y: number; w: number; h: number };
     scale: number; flatten: () => number[] } | null {
  const reg = deps.outputRegion(outputId);
  if (!reg) return null;
  return {
    region: { x: reg.x, y: reg.y, w: reg.w, h: reg.h },
    scale: reg.scale,
    flatten: () => deps.flattenWindows(windows),
  };
}

// Construct sdk.compose backed by an in-thread CompositorSink that
// implements the compose methods (JsCompositor today). The plugin shares
// core's GPUDevice, so returned GPUTextures are usable directly -- no
// cross-device import, no fence. Returns null if the sink does not
// implement the compose methods (in which case sdk.compose is absent
// from the SDK -- capability-by-shape).
//
// sceneRegistry: every SceneHandle this builds is registered so the
// scene's core-side texture is reachable by id from other SDK consumers
// (transitions, future intercept). Optional today; when absent, the
// SceneHandles still expose .texture / .sample / .release but their .id
// is 0 and transitions.run will reject them with a clear error.
export function createInThreadCompose(
  compositor: CompositorSink,
  hasOutput: (outputId: number) => boolean,
  sceneRegistry?: SceneRegistry,
  // Expand a window set into its full on-screen draw list (decoration +
  // toplevel + subsurfaces). Without it, scene compose drops subsurfaces.
  flattenWindows?: (surfaceIds: ReadonlyArray<number>) => number[],
  // The output's global-logical rect + scale, for device-resolution compose.
  outputRegion?: (outputId: number) =>
    { x: number; y: number; w: number; h: number; scale: number } | null,
  // A window's global-logical outer rect + scale, for per-window compose.
  windowRegion?: (surfaceId: number) =>
    { x: number; y: number; w: number; h: number; scale: number } | null,
): PluginCompose | null {
  // The subsurface-correct path needs composeRegion + the state-backed
  // flatteners. Without them (a host that didn't wire flattening), in-thread
  // compose is unavailable rather than silently subsurface-dropping.
  if (!compositor.composeRegion || !flattenWindows || !outputRegion || !windowRegion
      || !compositor.registerLiveScene || !compositor.registerLiveWindows) {
    return null;
  }
  // Locals to satisfy the type checker that these are defined after the
  // guard above (the methods are optional on the interface).
  const composeRegion = compositor.composeRegion.bind(compositor);
  const registerLiveScene = compositor.registerLiveScene.bind(compositor);
  const registerLiveWindows = compositor.registerLiveWindows.bind(compositor);
  // When the caller hasn't passed a shared registry, fall back to a
  // local one. SceneHandles still get a unique .id within this SDK
  // instance, but transitions.run on the same plugin won't find them
  // (the broker's registry is separate). For tests that don't exercise
  // transitions this is invisible.
  const registry = sceneRegistry ?? createSceneRegistry();
  // outputId validation: reject ids that don't resolve to a live output
  // (state.outputs is the source of truth; the virtual fallback is never a
  // legal SDK target).
  function checkOutput(outputId: number): void {
    if (!hasOutput(outputId)) {
      throw new Error(`sdk.compose: outputId=${outputId} is not a live output`);
    }
  }

  return {
    async scene(args): Promise<SceneHandle> {
      checkOutput(args.outputId);
      const sp = sceneDrawParams({ flattenWindows, outputRegion }, args.outputId, args.windows);
      if (!sp) throw new Error(`sdk.compose.scene: no region for output ${args.outputId}`);
      // outW/outH override the logical region size (device dims follow scale).
      const region = {
        x: sp.region.x, y: sp.region.y,
        w: args.outW ?? sp.region.w, h: args.outH ?? sp.region.h,
      };
      if (args.mode === "snapshot") {
        // One-shot: flatten now (subsurfaces included), compose at device scale.
        const r = composeRegion({ drawList: sp.flatten(), region, scale: sp.scale });
        let released = false;
        const tex = r.texture;
        // Register in the scene registry. onTeardown destroys the
        // texture only after the last pin drops (a transition holding
        // the scene defers the destroy).
        const sceneId = registry.register(
          { texture: tex, outW: r.outW, outH: r.outH },
          () => { tex.destroy(); },
        );
        return {
          texture: tex, outW: r.outW, outH: r.outH, id: sceneId,
          async sample<T>(cb: (t: GPUTexture) => T | Promise<T>): Promise<T> {
            return await cb(tex);
          },
          async release(): Promise<void> {
            if (released) return;
            released = true;
            registry.unregister(sceneId);
          },
        };
      }
      // mode === 'live': the compositor re-evaluates getDrawList each frame
      // (subsurfaces committed mid-life are picked up) and composes at the
      // output's region + scale (device resolution).
      const h: LiveSceneHandle = registerLiveScene({
        outputId: args.outputId,
        getDrawList: sp.flatten,
        region,
        scale: sp.scale,
      });
      const tex = h.texture;
      const sceneId = registry.register(
        { texture: tex, outW: h.outW, outH: h.outH },
        () => { h.release(); },
      );
      return {
        texture: tex, outW: h.outW, outH: h.outH, id: sceneId,
        async sample<T>(cb: (t: GPUTexture) => T | Promise<T>): Promise<T> {
          return await cb(tex);
        },
        async release(): Promise<void> { registry.unregister(sceneId); },
      };
    },

    async windows(args): Promise<WindowComposition> {
      checkOutput(args.outputId);
      if (args.mode === "snapshot") {
        // Compose each window's full subtree (subsurfaces included) over its
        // outer rect at device scale. The crop rect (unused by bundled plugins)
        // is not honored on this path.
        const results: Array<{ id: number; texture: GPUTexture;
                               rect: { x: number; y: number; w: number; h: number } }> = [];
        for (const w of args.windows) {
          const reg = windowRegion(w.id);
          if (!reg) continue;
          const rect = { x: reg.x, y: reg.y, w: reg.w, h: reg.h };
          const cr = composeRegion({ drawList: flattenWindows([w.id]), region: rect, scale: reg.scale });
          results.push({ id: w.id, texture: cr.texture, rect });
        }
        let releasedR = false;
        return {
          windows: results,
          async release(): Promise<void> {
            if (releasedR) return;
            releasedR = true;
            for (const w of results) w.texture.destroy();
          },
        };
      }
      // mode === 'live'
      const h: LiveWindowCompHandle = registerLiveWindows({
        outputId: args.outputId,
        windows: args.windows,
      });
      return {
        windows: h.windows,
        async release(): Promise<void> {
          h.release();
        },
      };
    },
  };
}

// Phase 5b: Worker plugin compose deps. The Worker has its own wgpu::Device
// (over its own wire client); the core produces a dmabuf, the plugin samples
// it. createWorkerCompose returns a PluginCompose backed by AllocComposeBuf
// + cross-device fence brackets (mediated through the core's gpu-broker via
// the standard compose.snapshot endpoint request).
export interface WorkerComposeDeps {
  // Plugin worker's wire client id (the value openWireClient returned).
  clientId: number;
  // Plugin-side native addon shape -- the same `PluginAddon` gpu.ts uses,
  // narrowed to the consumer-side functions we need. Imported as `unknown` to
  // avoid a hard dep on gpu.ts's internal interface; the consumers we use
  // are the only ones invoked here.
  plugin: {
    reserveConsumerTexture(clientId: number, surfaceBufId: number, w: number, h: number):
      { texture: { id: number; generation: number };
        device: { id: number; generation: number };
        wireSerial: bigint };
    consumerTexture(clientId: number, surfaceBufId: number): bigint;
    writeConsumerBegin(clientId: number, surfaceBufId: number): void;
    writeConsumerEnd(clientId: number, surfaceBufId: number): void;
  };
  // dawn.node's wrapTexture (binds a wire texture handle to a GPUTexture on
  // the plugin's device).
  dawn: { wrapTexture(deviceHandle: bigint, textureHandle: bigint): GPUTexture };
  // The plugin device handle to wrap textures against.
  pluginDeviceHandle: bigint;
  // Endpoint for round-trips to the core broker (compose.snapshot, compose.release).
  endpoint: Endpoint;
  // The plugin-side surfaceBufId counter. compose buffers share the
  // surfaceBufId space with overlay slots so the core can apply uniform
  // ReleaseSurfaceBuf semantics; this is the worker's side allocator. Since
  // the worker only reserves consumer textures (the producer side is in the
  // core), the worker just needs unique ids.
  allocSurfaceBufId: () => number;
  // Liveness check for outputIds. Reads state.outputs in the host process;
  // returns true for ids the compositor would actually render onto. The
  // virtual fallback is never live.
  hasOutput: (outputId: number) => boolean;
}

// Construct sdk.compose for a Worker plugin. Snapshot mode (phase 5b);
// live mode raises if requested (phase 5b-live adds it).
export function createWorkerCompose(deps: WorkerComposeDeps): PluginCompose {
  const { clientId, plugin, dawn, pluginDeviceHandle, endpoint, allocSurfaceBufId, hasOutput } = deps;

  function checkOutput(outputId: number): void {
    if (!hasOutput(outputId)) {
      throw new Error(`sdk.compose: outputId=${outputId} is not a live output`);
    }
  }

  return {
    async scene(args): Promise<SceneHandle> {
      checkOutput(args.outputId);
      const outW = args.outW;
      const outH = args.outH;
      if (!outW || !outH) {
        throw new Error("sdk.compose.scene: outW/outH required for Worker plugins");
      }
      if (args.mode === "snapshot") {
        return makeWorkerSnapshot(deps, [...args.windows], outW, outH);
      }
      return makeWorkerLive(deps, [...args.windows], outW, outH);
    },

    async windows(_args): Promise<WindowComposition> {
      throw new Error("sdk.compose.windows: not yet implemented for Worker plugins (phase 5b)");
    },
  };
}

// Snapshot: one-shot compose. Plugin reserves ONE consumer texture, broker
// runs ONE produce pass into it, plugin opens a single consumer Begin that
// covers reads until release(). No ring needed (the texture's contents are
// frozen after the one produce).
async function makeWorkerSnapshot(
  deps: WorkerComposeDeps,
  windows: ReadonlyArray<number>, outW: number, outH: number,
): Promise<SceneHandle> {
  const { clientId, plugin, dawn, pluginDeviceHandle, endpoint, allocSurfaceBufId } = deps;
  // Reserve one consumer texture on our plugin wire under a WORKER-local key
  // (resKey). The reservation's wireSerial is captured AFTER the flush; the
  // GPU process defers its plugin-side InjectTexture on that.
  const resKey = allocSurfaceBufId();
  const con = plugin.reserveConsumerTexture(clientId, resKey, outW, outH);
  // Round-trip to the broker -> AllocComposeBuf -> one composeIntoView pass.
  // The broker's reply gives the GPU-process surfaceBufId (a different
  // namespace from the worker's resKey).
  const r = (await endpoint.request("compose.snapshot", {
    width: outW, height: outH,
    consumerTexId: con.texture.id, consumerTexGen: con.texture.generation,
    consumerDevId: con.device.id, consumerDevGen: con.device.generation,
    pluginReservePointSerial: con.wireSerial,
    windows: [...windows],
  })) as { surfaceBufId: number; width: number; height: number; sceneId?: number };
  const surfaceBufId = r.surfaceBufId;
  // sceneId is undefined when the broker was constructed without a
  // shared sceneRegistry (e.g. an older test); the handle still works
  // for direct sample(cb), but transitions.run on it would fail.
  const sceneId = r.sceneId ?? 0;
  const texHandle = plugin.consumerTexture(clientId, resKey);
  if (texHandle === 0n) {
    throw new Error("compose.snapshot: consumer texture not yet injected on plugin wire");
  }
  const texture = dawn.wrapTexture(pluginDeviceHandle, texHandle);
  // Open the consumer bracket once; close it at release(). Snapshot's
  // contents don't change after the broker's one produce, so a single
  // Begin/End pair covers all reads.
  plugin.writeConsumerBegin(clientId, surfaceBufId);
  let released = false;
  return {
    texture, outW, outH, id: sceneId,
    async sample<T>(cb: (t: GPUTexture) => T | Promise<T>): Promise<T> {
      return await cb(texture);
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      plugin.writeConsumerEnd(clientId, surfaceBufId);
      await endpoint.request("compose.release", { surfaceBufId });
    },
  };
}

// Live: per-frame compose into a 3-slot ring. The core (producer) writes to
// FREE slots; the plugin (consumer) reads PRESENTED slots via sample(cb).
// The SAB-CAS slot-state machine + per-slot SharedFence brackets keep them
// non-racing. The plugin sees ONE GPUTexture handle from sample(cb) that
// happens to be whichever ring slot was most recently presented.
async function makeWorkerLive(
  deps: WorkerComposeDeps,
  windows: ReadonlyArray<number>, outW: number, outH: number,
): Promise<SceneHandle> {
  const { clientId, plugin, dawn, pluginDeviceHandle, endpoint, allocSurfaceBufId } = deps;
  const SLOTS = 3;  // ring depth, same as the overlay path

  // Reserve SLOTS consumer textures (one per ring slot) on our plugin wire.
  // Each gets its own worker-local resKey; we keep both keys per slot.
  const slotResKeys: number[] = [];
  type ConRes = ReturnType<typeof plugin.reserveConsumerTexture>;
  const cons: ConRes[] = [];
  for (let i = 0; i < SLOTS; i++) {
    const resKey = allocSurfaceBufId();
    slotResKeys.push(resKey);
    cons.push(plugin.reserveConsumerTexture(clientId, resKey, outW, outH));
  }

  // Round-trip to the broker: it allocates SLOTS dmabufs (one per slot via
  // AllocComposeBuf), registers them for per-frame produce, builds the
  // shared SlotStates SAB, and replies with {slotsSab, slots:[{surfaceBufId}]}.
  // Each per-slot consumer handle is on the worker; the broker sees the
  // wire reserved {texId, texGen, devId, devGen, wireSerial} per slot.
  // The broker's reply shape is known by contract (gpu-broker.ts compose.live).
  const reply = await endpoint.request("compose.live", {
    width: outW, height: outH, slots: SLOTS,
    consumers: cons.map((c) => ({
      texId: c.texture.id, texGen: c.texture.generation,
      devId: c.device.id, devGen: c.device.generation,
      wireSerial: c.wireSerial,
    })),
    windows: [...windows],
  });
  // eslint-disable-next-line no-restricted-syntax
  const r = reply as unknown as {
    slotsSab: SharedArrayBuffer;
    slots: Array<{ surfaceBufId: number }>;
    sceneId?: number;
  };
  const sceneId = r.sceneId ?? 0;

  const slotBufIds: number[] = r.slots.map((s) => s.surfaceBufId);
  const slotTextures: (GPUTexture | null)[] = new Array(SLOTS).fill(null);
  const slotStates = new SlotStates(r.slotsSab);

  // Build the consumer half of the ring. The plugin's GPU device tracks
  // afterReadDone via onSubmittedWorkDone -- consumer End must wait until
  // the plugin's most recent sample submit completed.
  const dev = deps.plugin === undefined ? null : null; void dev;
  // (sdk.gpu.device is on the worker side -- consumers run cb() that
  // encodes + submits. The DRAINING -> FREE / writeEnd must come AFTER
  // that submit's GPU work completes. We rely on the cb itself awaiting
  // its mapAsync/work-completion before returning; the writeEnd fires
  // synchronously in endConsume so it's after the cb resolves, which the
  // FIFO wire ordering then sequences correctly.)
  let openSlot = -1;
  const consumer = new SurfaceConsumer({
    slots: {
      surfaceBufId: (slot) => slotBufIds[slot],
      textureFor: (slot) => {
        if (slotTextures[slot]) return slotTextures[slot];
        const handle = plugin.consumerTexture(clientId, slotResKeys[slot]);
        if (handle === 0n) return null;
        const t = dawn.wrapTexture(pluginDeviceHandle, handle);
        slotTextures[slot] = t;
        return t;
      },
    },
    slotStates,
    writeBegin: (id) => plugin.writeConsumerBegin(clientId, id),
    writeEnd: (id) => plugin.writeConsumerEnd(clientId, id),
    // For the plugin-side consumer, afterReadDone fires synchronously --
    // the sample()'s cb is expected to await its own mapAsync /
    // onSubmittedWorkDone before returning, so when endConsume is called
    // the plugin's GPU work for THIS sample is already done. writeEnd
    // immediately is correct.
    afterReadDone: (cb) => cb(),
  });

  // Pull-based sample(): await a PRESENTED slot, open consumer Begin on
  // it, run cb, close End. ONE sample at a time (single-buffer-like guard
  // against the caller invoking sample() before a prior one settles).
  let sampling = false;
  let released = false;
  // Texture-of-record for SceneHandle.texture: this is a representative
  // texture; the plugin should sample inside sample(cb) which gives the
  // ACTUAL slot's texture for that sample. We expose slot-0's texture as
  // a placeholder so .texture isn't null; documenting the contract.
  // Pre-wrap so the SceneHandle has a non-null texture.
  await new Promise<void>((res) => setTimeout(res, 0));  // yield once
  const slot0Tex = (() => {
    const h = plugin.consumerTexture(clientId, slotResKeys[0]);
    if (h === 0n) return null;
    const t = dawn.wrapTexture(pluginDeviceHandle, h);
    slotTextures[0] = t;
    return t;
  })();

  return {
    texture: slot0Tex as GPUTexture,  // representative; sample(cb) hands the real one
    outW, outH, id: sceneId,
    async sample<T>(cb: (t: GPUTexture) => T | Promise<T>): Promise<T> {
      if (released) throw new Error("compose.live: sample after release");
      if (sampling) throw new Error("compose.live: sample called while another sample is in flight");
      sampling = true;
      try {
        const slot = await awaitPresentedSlot(slotStates);
        openSlot = slot;
        const tex = consumer.beginConsume(slot);
        // The cb encodes + submits its reads against `tex`. The cb is
        // expected to await any mapAsync / onSubmittedWorkDone BEFORE
        // returning, so by the time await cb() resolves the plugin's
        // GPU work against this slot is complete.
        const result = await cb(tex);
        // End the bracket + demote PRESENTED -> DRAINING -> FREE so the
        // producer can re-claim this slot.
        consumer.endConsume();
        openSlot = -1;
        return result;
      } finally {
        sampling = false;
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      while (sampling) await new Promise((r) => setTimeout(r, 1));
      if (openSlot >= 0) {
        consumer.endConsume();
        openSlot = -1;
      }
      // Tell the broker to unregister + release every slot's surfaceBuf.
      await endpoint.request("compose.release", { surfaceBufIds: slotBufIds });
    },
  };
}
