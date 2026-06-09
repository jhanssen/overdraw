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
