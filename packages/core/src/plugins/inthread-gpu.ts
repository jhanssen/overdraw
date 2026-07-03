// In-thread sdk.gpu construction for bundled plugins. Bundled plugins run on
// the core's main thread (customization.md "Two execution paths, one SDK")
// and share core's GPUDevice -- no separate device, no wire client, no
// dmabuf, no cross-device fences. The Surface interface is the same shape
// plugins see in Worker mode (gpu.ts); only the underlying mechanism
// differs.
//
// The WebGPU bitflag globals (GPUBufferUsage, GPUShaderStage, GPUTextureUsage,
// GPUMapMode, GPUColorWrite) are installed on globalThis on first
// construction so bundled plugin source can use them the same way Worker
// plugins do.
//
// What this module owns:
//   - sdk.gpu.device  -- the core's GPUDevice handed in by main.ts
//   - sdk.gpu.createOverlay({layer, anchor, w, h})  -- a Surface ring of
//     core-device GPUTextures + the rect on screen
//   - the RingMaker used by sdk.decorations.createDecoration (same contract
//     as the Worker path; same `allocExtra` tags drive the geometry decision
//     in the overlay broker)
//
// Why no slot-state SAB / atomics: only one thread is producing OR consuming
// (it's the same thread). Submit ordering on the core device's queue
// guarantees the compositor's sample reads see the plugin's render writes,
// provided the plugin submits BEFORE calling present(). present() does not
// itself fence -- it just tells the compositor which texture to sample on
// the next frame.

import type { CompositorSink } from "../protocols/ctx.js";
import type {
  CreateOverlayOpts, OutputInfo, PluginGpu, RingMaker, Surface,
} from "./gpu.js";
import type { OverlayBroker, OverlayLayer } from "../overlay.js";
import type { OverlayAnchor } from "../overlay-position.js";
import type { Json } from "./protocol.js";
import type { SceneRegistry } from "./scene-registry.js";

const SLOTS = 3;  // triple-buffered: producer, presented (consumer sampling), spare.

// Install dawn.node's WebGPU bitflag globals (GPU*) on globalThis so bundled
// plugin source uses GPUBufferUsage.UNIFORM / GPUShaderStage.FRAGMENT / etc.
// as standard globals, the same way Worker plugins do. Idempotent: existing
// globals (e.g. a future native WebGPU in Node) are not overwritten. Mirrors
// installWebGPUGlobals in gpu.ts (Worker path).
let globalsInstalled = false;
function installWebGPUGlobalsOnce(globals: Record<string, unknown>): void {
  if (globalsInstalled) return;
  for (const [name, value] of Object.entries(globals)) {
    if (!Reflect.has(globalThis, name)) Reflect.set(globalThis, name, value);
  }
  globalsInstalled = true;
}

// Allocator dependencies for the in-thread GPU SDK. main.ts builds these and
// hands them to the runtime; the runtime forwards them per-plugin to the
// in-thread loader path.
export interface InThreadGpuDeps {
  // The core's GPUDevice. Bundled plugins create textures + pipelines on this
  // device directly -- the WGSL compositor samples them with no import.
  coreDevice: GPUDevice;
  // dawn.node's globals bag (GPUBufferUsage / GPUShaderStage / GPUTextureUsage
  // / GPUMapMode / GPUColorWrite plus the GPU* constructors). Installed on
  // globalThis by createInThreadGpu so bundled plugin source uses the
  // standard global names. Indexed by string here because the bag carries
  // arbitrary GPU* entries; the type-narrow constants are reached through
  // globalThis after install.
  globals: Record<string, unknown>;
  // Overlay broker: decides geometry + assigns a compositor surface id, same
  // as the Worker path's surface.alloc broker call.
  overlays: OverlayBroker;
  // Compositor sink: setSurfaceTexture installs the current presented slot's
  // texture as the surface's sampled texture; the next compositor frame
  // samples it. afterCurrentFrame defers slot recycling until the GPU read
  // of the just-superseded slot completes (queue ordering on a single device
  // makes this strictly safer than the cross-device path needed, but the
  // deferral keeps the SAME texture from being reused while still being read).
  compositor: CompositorSink;
  // Scene registry: in-thread SceneHandles minted by createInThreadCompose
  // register their textures here so transitions (and any future cross-SDK
  // consumer) can resolve a sceneId back to a sampleable GPUTexture.
  // Optional: when absent, in-thread SceneHandles still work for direct
  // sampling but lack a .id, so transitions.run will reject them.
  sceneRegistry?: SceneRegistry;
  // sdk.compose flattening. The compositor has no subsurface tree, so a window
  // set must be expanded into its full on-screen draw list (decoration +
  // toplevel + subsurfaces) here, where the protocol state lives. Without
  // these, compose falls back to the un-expanded (subsurface-dropping) path.
  flattenWindows?: (surfaceIds: ReadonlyArray<number>) => number[];
  // The output's GLOBAL-logical rect + scale, for device-resolution compose.
  outputRegion?: (outputId: number) =>
    { x: number; y: number; w: number; h: number; scale: number } | null;
  // A window's GLOBAL-logical outer rect + its output scale, for per-window
  // (sdk.compose.windows) device-resolution compose.
  windowRegion?: (surfaceId: number) =>
    { x: number; y: number; w: number; h: number; scale: number } | null;
  // Phase 10a intercept: the broker the in-thread sdk.intercept SDK
  // talks to directly. Optional: when absent, sdk.intercept.register
  // will reject (the bundled-plugin path either has it or doesn't,
  // mirroring how sdk.transitions only works when sceneRegistry is
  // wired).
  interceptBroker?: import("../intercept/broker.js").InterceptBroker;
  // Generic ring-surface lifecycle hooks the decoration broker reads.
  // The Worker GPU broker calls equivalents on surface.alloc /
  // surface.present; the in-thread path mirrors them here so the broker's
  // first-frame gate releases regardless of which transport the decoration
  // plugin uses. onSurfaceAllocated fires with the `decorates` tag's window
  // id (only present for the decoration path). onSurfacePresented fires
  // on every present (the broker filters its own).
  onSurfaceAllocated?: (surfaceId: number, decoratesWindowId: number) => void;
  onSurfacePresented?: (surfaceId: number) => void;
  // Live output enumeration for gpu.listOutputs; mirrors the Worker GPU
  // broker's dep. Absent in harnesses -> no outputs reported.
  listOutputs?: () => OutputInfo[];
  // Frame-tick service for surface.onFrame. In-thread delivery invokes the
  // plugin's callback directly on the core thread (no postMessage hop).
  // Absent in harnesses -> onFrame ticks never fire.
  frameTicks?: import("./frame-ticks.js").OverlayFrameTicks;
}

// Per-plugin GPU SDK construction. The plugin's name flows in so the overlay
// broker can attribute ownership. (The broker exposes destroyForPlugin for
// plugin-termination cleanup; the runtime does not currently invoke it for
// either Worker or in-thread plugins, so surfaces a plugin allocates leak on
// stop() until the plugin's own onShutdown cleans them up.)
export function createInThreadGpu(
  pluginName: string, deps: InThreadGpuDeps,
): { gpu: PluginGpu; makeRingSurface: RingMaker; stop: () => void } {
  const { coreDevice, globals, overlays, compositor,
          onSurfaceAllocated, onSurfacePresented } = deps;
  installWebGPUGlobalsOnce(globals);
  let stopped = false;

  // Allocate `SLOTS` GPUTextures of (w, h) on core's device, usable as both a
  // render target (the plugin draws into one slot per frame) and a sampled
  // texture (the compositor reads it). GPUTextureUsage is installed on
  // globalThis by installWebGPUGlobalsOnce above.
  function allocSlots(width: number, height: number): GPUTexture[] {
    const usage = GPUTextureUsage.RENDER_ATTACHMENT
                | GPUTextureUsage.TEXTURE_BINDING
                | GPUTextureUsage.COPY_DST;
    const out: GPUTexture[] = [];
    for (let i = 0; i < SLOTS; i++) {
      out.push(coreDevice.createTexture({
        size: { width, height }, format: "bgra8unorm", usage,
      }));
    }
    return out;
  }

  // Build a Surface for a ring at the broker-decided rect. `allocExtra`
  // carries either anchor params (overlay path) or an explicit rect with a
  // `decorates` tag (decoration path); the overlay broker interprets them
  // the same way as the Worker path's surface.alloc.
  function makeRingSurface(
    width: number, height: number, allocExtra: Record<string, Json>,
  ): Promise<Surface> {
    const explicitRect = allocExtra.rect as
      { x: number; y: number; width: number; height: number } | undefined;
    const decorates = allocExtra.decorates as number | undefined;
    const handle = typeof decorates === "number" && explicitRect
      ? overlays.createWindowBound(pluginName, explicitRect)
      : explicitRect
        ? overlays.createAt(pluginName,
            (allocExtra.layer as OverlayLayer) ?? "above", explicitRect)
        : overlays.create(pluginName, {
            layer: (allocExtra.layer as OverlayLayer) ?? "overlay",
            anchor: (allocExtra.anchor as OverlayAnchor) ?? "center",
            width, height,
            margin: allocExtra.margin as number | undefined,
            output: allocExtra.output as number | undefined,
          });
    // Fire the decoration-broker alloc hook for decoration surfaces. The
    // Worker GPU broker does the equivalent for surface.alloc; we mirror it
    // here so the broker's first-frame gate releases for in-thread bundled
    // decoration plugins too.
    if (typeof decorates === "number") {
      onSurfaceAllocated?.(handle.surfaceId, decorates);
    }

    const slots = allocSlots(width, height);
    // -1 = no slot held; otherwise the index getCurrentTexture last handed
    // out. present() advances `presented` to this slot and installs its
    // texture as the surface's sampled texture; the previously presented
    // slot becomes draining until the GPU read completes.
    let acquired = -1;
    // The slot currently installed in the compositor (or -1 if none yet).
    let presented = -1;
    let nextFreeIdx = 0;
    let destroyed = false;
    // Queued surface.onFrame callbacks; flushed together on the tick.
    const frameCbs: Array<(timeMs: number) => void> = [];

    // FREE / ACQUIRED / PRESENTED / DRAINING tracked as a small array. No
    // atomics; the producer + consumer are the same thread.
    const FREE = 0, ACQUIRED = 1, PRESENTED = 2, DRAINING = 3;
    const state = new Uint8Array(SLOTS);  // all FREE initially.

    function nextFreeSlot(): number {
      for (let off = 0; off < SLOTS; off++) {
        const i = (nextFreeIdx + off) % SLOTS;
        if (state[i] === FREE) { nextFreeIdx = (i + 1) % SLOTS; return i; }
      }
      return -1;
    }

    const surface: Surface = {
      width, height, rect: handle.rect, surfaceId: handle.surfaceId,
      outputId: handle.outputId,

      async getCurrentTexture(): Promise<GPUTexture> {
        if (destroyed) throw new Error("surface used after destroy()");
        if (stopped) return new Promise<GPUTexture>(() => {});
        if (acquired >= 0) return slots[acquired];
        // SLOTS=3 with at most one each in ACQUIRED, PRESENTED, DRAINING
        // guarantees a FREE is always available: by construction. If the
        // assumption is broken (an extra acquire without present), surface
        // it loudly rather than silently spin.
        const slot = nextFreeSlot();
        if (slot < 0) {
          throw new Error("in-thread surface: no free slot (caller acquired without present?)");
        }
        state[slot] = ACQUIRED;
        acquired = slot;
        return slots[slot];
      },

      async present(): Promise<void> {
        if (stopped || destroyed) return;
        if (acquired < 0) {
          throw new Error("surface.present() without a prior getCurrentTexture()");
        }
        const justPresented = acquired;
        acquired = -1;
        state[justPresented] = PRESENTED;
        // Install the texture as the surface's sampled view; the next
        // compositor frame samples it. Same device + queue means submit
        // ordering carries the plugin's writes into the compositor's read.
        compositor.setSurfaceTexture?.(handle.surfaceId,
          slots[justPresented], width, height);
        // Mirror the Worker path's surface.present hook so the decoration
        // broker's first-present gate releases for in-thread plugins too.
        onSurfacePresented?.(handle.surfaceId);

        // Demote the previously presented slot to DRAINING + free it once
        // the compositor's last-sampling submit completes. Same-device
        // queue ordering means a frame submitted AFTER this present cannot
        // sample a previous slot, but a frame submitted BEFORE this present
        // (the one currently in flight) may still be sampling the prior
        // slot -- afterCurrentFrame is the right gate.
        const prev = presented;
        presented = justPresented;
        if (prev >= 0 && prev !== justPresented) {
          state[prev] = DRAINING;
          const recycle = (): void => {
            if (destroyed) return;
            state[prev] = FREE;
          };
          if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(recycle);
          else recycle();
        }
      },

      onFrame(cb: (timeMs: number) => void): void {
        if (destroyed) throw new Error("surface used after destroy()");
        const arm = frameCbs.length === 0;
        frameCbs.push(cb);
        // One arm per delivery cycle; the tick flushes the whole queue.
        // Delivery runs on the core thread (in-thread plugins always do).
        if (arm) {
          deps.frameTicks?.arm(handle.surfaceId, handle.outputId, (timeMs) => {
            if (destroyed) return;
            for (const fn of frameCbs.splice(0)) fn(timeMs);
          });
        }
      },

      async destroy(): Promise<void> {
        if (destroyed) return;
        destroyed = true;
        deps.frameTicks?.drop(handle.surfaceId);
        frameCbs.length = 0;
        // Stop compositing it immediately. The compositor removes the
        // surface from its draw list; subsequent setSurfaceTexture for
        // this id is a no-op.
        overlays.destroy(handle.surfaceId);
        // Free the slot textures once any in-flight compositor read of
        // them completes. Without this, the compositor's currently-bound
        // sampled view could be a texture we're about to destroy.
        const toFree = slots.slice();
        const teardown = (): void => {
          for (const t of toFree) {
            try { t.destroy(); } catch { /* destroy is idempotent on dawn.node */ }
          }
        };
        if (compositor.afterCurrentFrame) compositor.afterCurrentFrame(teardown);
        else teardown();
      },
    };
    return Promise.resolve(surface);
  }

  const gpu: PluginGpu = {
    device: coreDevice,
    createOverlay(opts: CreateOverlayOpts): Promise<Surface> {
      return makeRingSurface(opts.width, opts.height, {
        layer: opts.layer ?? "overlay",
        anchor: opts.anchor ?? "center",
        margin: opts.margin ?? 0,
        ...(opts.output !== undefined ? { output: opts.output } : {}),
      });
    },
    listOutputs(): Promise<OutputInfo[]> {
      return Promise.resolve(deps.listOutputs?.() ?? []);
    },
  };

  return {
    gpu,
    makeRingSurface,
    stop(): void {
      stopped = true;
      // Outstanding Surfaces are owned by the plugin; their destroy() runs
      // on plugin shutdown (sdk.onShutdown). The runtime does not force-
      // destroy them here (see destroyForPlugin note in the file header).
    },
  };
}
