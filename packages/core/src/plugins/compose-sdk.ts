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
import { OUTPUT_DEFAULT } from "../protocols/ctx.js";
import type { Endpoint } from "./protocol.js";

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
  texture: GPUTexture;
  outW: number;
  outH: number;
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

// Construct sdk.compose backed by an in-thread CompositorSink that
// implements the compose methods (JsCompositor today). The plugin shares
// core's GPUDevice, so returned GPUTextures are usable directly -- no
// cross-device import, no fence. Returns null if the sink does not
// implement the compose methods (in which case sdk.compose is absent
// from the SDK -- capability-by-shape).
export function createInThreadCompose(compositor: CompositorSink): PluginCompose | null {
  if (!compositor.composeScene || !compositor.composeWindows
      || !compositor.registerLiveScene || !compositor.registerLiveWindows) {
    return null;
  }
  // Locals to satisfy the type checker that these are defined after the
  // guard above (the methods are optional on the interface).
  const composeScene = compositor.composeScene.bind(compositor);
  const composeWindows = compositor.composeWindows.bind(compositor);
  const registerLiveScene = compositor.registerLiveScene.bind(compositor);
  const registerLiveWindows = compositor.registerLiveWindows.bind(compositor);
  // outputId validation: today only OUTPUT_DEFAULT exists. Reject anything
  // else explicitly rather than silently treat it as 0.
  function checkOutput(outputId: number): void {
    if (outputId !== OUTPUT_DEFAULT) {
      throw new Error(
        `sdk.compose: outputId=${outputId} not recognized ` +
        `(only OUTPUT_DEFAULT=${OUTPUT_DEFAULT} exists today)`,
      );
    }
  }

  return {
    async scene(args): Promise<SceneHandle> {
      checkOutput(args.outputId);
      if (args.mode === "snapshot") {
        const r = composeScene({
          outputId: args.outputId,
          windows: args.windows,
          outW: args.outW, outH: args.outH,
        });
        let released = false;
        return {
          texture: r.texture, outW: r.outW, outH: r.outH,
          async release(): Promise<void> {
            if (released) return;
            released = true;
            r.texture.destroy();
          },
        };
      }
      // mode === 'live'
      const h: LiveSceneHandle = registerLiveScene({
        outputId: args.outputId,
        windows: args.windows,
        outW: args.outW, outH: args.outH,
      });
      return {
        texture: h.texture, outW: h.outW, outH: h.outH,
        async release(): Promise<void> {
          h.release();
        },
      };
    },

    async windows(args): Promise<WindowComposition> {
      checkOutput(args.outputId);
      if (args.mode === "snapshot") {
        const r = composeWindows({
          outputId: args.outputId,
          windows: args.windows,
        });
        let released = false;
        return {
          windows: r.map((w) => ({ id: w.id, texture: w.texture, rect: w.rect })),
          async release(): Promise<void> {
            if (released) return;
            released = true;
            for (const w of r) w.texture.destroy();
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
}

// Construct sdk.compose for a Worker plugin. Snapshot mode (phase 5b);
// live mode raises if requested (phase 5b-live adds it).
export function createWorkerCompose(deps: WorkerComposeDeps): PluginCompose {
  const { clientId, plugin, dawn, pluginDeviceHandle, endpoint, allocSurfaceBufId } = deps;

  function checkOutput(outputId: number): void {
    if (outputId !== OUTPUT_DEFAULT) {
      throw new Error(
        `sdk.compose: outputId=${outputId} not recognized ` +
        `(only OUTPUT_DEFAULT=${OUTPUT_DEFAULT} exists today)`,
      );
    }
  }

  return {
    async scene(args): Promise<SceneHandle> {
      checkOutput(args.outputId);
      if (args.mode !== "snapshot") {
        throw new Error(
          "sdk.compose: live mode is not yet supported for Worker plugins (phase 5b-live)",
        );
      }
      // For Worker plugins, the host output dims aren't directly accessible
      // here; default to whatever the caller provides (no implicit
      // this.width/this.height). The compose-sdk in-thread variant defaults
      // to the compositor's dims; for Worker we require explicit dims.
      const outW = args.outW;
      const outH = args.outH;
      if (!outW || !outH) {
        throw new Error("sdk.compose.scene: outW/outH required for Worker plugins");
      }
      // 1. Reserve consumer texture on our plugin wire. flush is internal;
      //    wireSerial is captured AFTER the flush.
      const surfaceBufId = allocSurfaceBufId();
      const con = plugin.reserveConsumerTexture(clientId, surfaceBufId, outW, outH);
      // 2. Round-trip to the core broker. It allocates the producer side,
      //    sends AllocComposeBuf, awaits both injects, then renders the
      //    requested windows into the producer texture (writeProducerBegin/
      //    composeIntoView/writeProducerEnd on the core wire). The reply
      //    confirms the surfaceBufId is in surfaceBufs[].
      const r = (await endpoint.request("compose.snapshot", {
        width: outW, height: outH,
        consumerTexId: con.texture.id, consumerTexGen: con.texture.generation,
        consumerDevId: con.device.id, consumerDevGen: con.device.generation,
        pluginReservePointSerial: con.wireSerial,
        windows: [...args.windows],
      })) as { surfaceBufId: number; width: number; height: number };
      // The core's reply uses ITS own surfaceBufId allocator, not ours, so
      // overwrite. (This is a minor wart -- the allocations are parallel and
      // both maps key off this id. Could be unified, but they're per-side
      // pools today.)
      const actualBufId = r.surfaceBufId;
      // 3. Wrap the consumer texture handle on our device.
      const texHandle = plugin.consumerTexture(clientId, surfaceBufId);
      if (texHandle === 0n) {
        throw new Error("compose.snapshot: consumer texture not yet injected on plugin wire");
      }
      const texture = dawn.wrapTexture(pluginDeviceHandle, texHandle);
      // 4. Open the consumer read bracket on the plugin wire. The kind=1
      //    frame is FIFO-ordered before any subsequent sample commands we
      //    encode on this wire, so the GPU process opens the bracket (which
      //    waits on the producer's EndAccess fence) before our reads decode.
      plugin.writeConsumerBegin(clientId, surfaceBufId);
      let released = false;
      return {
        texture, outW, outH,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          // Close the consumer bracket on our wire.
          plugin.writeConsumerEnd(clientId, surfaceBufId);
          // Ask the core to release the surfaceBuf (GPU process frees the
          // dmabuf + STMs + textures; core's afterCurrentFrame gates this
          // on the producer submit completing).
          await endpoint.request("compose.release", { surfaceBufId: actualBufId });
        },
      };
    },

    async windows(_args): Promise<WindowComposition> {
      throw new Error("sdk.compose.windows: not yet implemented for Worker plugins (phase 5b)");
    },
  };
}
