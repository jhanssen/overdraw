// Generic plugin loader. Called from both bootstrap.ts (Worker entry) and
// inthread-plugin.ts (main-thread bundled plugins). Builds the SDK,
// imports the plugin module, calls init(sdk, config?), and reports the
// init outcome as an 'init' event. The Endpoint stays attached to the
// channel for the lifetime; the caller owns shutdown.
//
// Pings auto-pong via the Endpoint default. The Worker watchdog kills on
// missed pongs; in-thread has no watchdog (liveness == core's event loop).
//
// Two sdk.gpu construction paths (selected by which input fields are set):
//   - Worker:    pluginAddonPath + dawnPath  -> createPluginGpu (separate
//                device on a separate wire client; cross-device fences via
//                surface-slots).
//   - In-thread: inThreadGpu                 -> createInThreadGpu (shares
//                core's GPUDevice; same-device texture rotation).
// Both produce the same PluginGpu shape, so the plugin source is identical.

import { Endpoint } from "./protocol.js";
import type { Channel, Json } from "./protocol.js";
import { createSdk } from "./sdk.js";
import type { PluginSdk } from "./sdk.js";
import { createPluginGpu } from "./gpu.js";
import type { PluginGpu, RingMaker } from "./gpu.js";
import { createInThreadGpu } from "./inthread-gpu.js";
import type { InThreadGpuDeps } from "./inthread-gpu.js";
import { createPluginWindows } from "./windows-sdk.js";
import { createDecorations } from "./decorations.js";
import { createPluginEvents } from "./events.js";
import { createNamespaceHandle } from "./namespace.js";
import { createPluginActions } from "./actions.js";
import { createPluginAnimations } from "./animations-sdk.js";
import { createInThreadCompose, createWorkerCompose } from "./compose-sdk.js";
import type { PluginCompose } from "./compose-sdk.js";
import { createPluginInput } from "./input-sdk.js";
import { createTransitions } from "./transitions-sdk.js";
import type { PluginTransitions } from "./transitions-sdk.js";
import { createPluginCursor } from "./cursor-sdk.js";

export interface LoaderInput {
  module: string;
  name: string;
  // Per-plugin config slice; passed verbatim as init's second arg.
  config?: unknown;
  // Worker path: paths to the plugin Worker addon + dawn.node. Set together;
  // ignored if inThreadGpu is also set.
  pluginAddonPath?: string;
  dawnPath?: string;
  // In-thread path: the core-device dependency bundle. When set, sdk.gpu
  // shares core's device and the Worker path is not used.
  inThreadGpu?: InThreadGpuDeps;
}

type InitFn = (sdk: PluginSdk, config?: unknown) => unknown | Promise<unknown>;

export async function runLoader(channel: Channel, input: LoaderInput): Promise<void> {
  const endpoint = new Endpoint(channel);

  let gpu: PluginGpu | undefined;
  let makeRingSurface: RingMaker | undefined;
  let stopGpu: () => void = () => {};
  // sdk.compose: in-thread bundled plugins share core's device, so they get
  // GPUTexture handles by reference (createInThreadCompose). Worker plugins
  // get cross-device dmabuf compose via createWorkerCompose (phase 5b
  // snapshot today; live mode lands in phase 5b-live).
  let compose: PluginCompose | undefined;
  let transitions: PluginTransitions | undefined;
  if (input.inThreadGpu) {
    const g = createInThreadGpu(input.name, input.inThreadGpu);
    gpu = g.gpu;
    makeRingSurface = g.makeRingSurface;
    stopGpu = g.stop;
    compose = createInThreadCompose(
      input.inThreadGpu.compositor,
      input.inThreadGpu.sceneRegistry,
    ) ?? undefined;
    transitions = createTransitions(endpoint);
  } else if (input.pluginAddonPath && input.dawnPath) {
    const g = await createPluginGpu(endpoint, input.pluginAddonPath, input.dawnPath);
    gpu = g.gpu;
    makeRingSurface = g.makeRingSurface;
    const t = setInterval(g.pump, 4);
    t.unref?.();
    stopGpu = () => { clearInterval(t); g.stop(); };
    // Phase 5b: Worker plugins get sdk.compose backed by AllocComposeBuf.
    compose = createWorkerCompose({
      clientId: g.internals.clientId,
      plugin: g.internals.plugin,
      dawn: g.internals.dawn,
      pluginDeviceHandle: g.internals.devHandle,
      endpoint,
      allocSurfaceBufId: g.internals.allocSurfaceBufId,
    });
    transitions = createTransitions(endpoint);
  }

  const eventsHandle = createPluginEvents(endpoint);
  const nsHandle = createNamespaceHandle(endpoint);
  const actionsHandle = createPluginActions(endpoint);
  const windowsCtl = createPluginWindows(endpoint, eventsHandle.events);
  const animations = createPluginAnimations(endpoint);
  const decorations = makeRingSurface ? createDecorations(endpoint, makeRingSurface) : undefined;
  const inputHandle = createPluginInput(endpoint);
  const cursorCtl = createPluginCursor(endpoint);

  const control = createSdk(input.name, (line) => { endpoint.emit("log", line); },
    eventsHandle.events, nsHandle.ns, actionsHandle.actions, windowsCtl.windows,
    animations, inputHandle.input, gpu, decorations?.decorations, compose,
    transitions, cursorCtl.cursor);

  endpoint.handleRequests(async (method, params): Promise<Json> => {
    const ns = nsHandle.dispatcher.tryHandle(method, params);
    if (ns.handled) return await ns.result;

    const ac = actionsHandle.dispatcher.tryHandle(method, params);
    if (ac.handled) return await ac.result;

    const ev = eventsHandle.requests.tryHandle(method, params);
    if (ev.handled) return await ev.result;

    if (method === "shutdown") {
      stopGpu();
      cursorCtl.release();
      await control.runShutdown();
      return null;
    }
    throw new Error(`unknown request method '${method}'`);
  });

  endpoint.handleEvents((eventName, data) => {
    if (eventsHandle.dispatcher.dispatch(eventName, data)) return;
    if (inputHandle.dispatcher.dispatch(eventName, data)) return;
    decorations?.dispatch(eventName, data);
  });

  try {
    const mod = (await import(input.module)) as { default?: InitFn };
    if (typeof mod.default !== "function") {
      throw new Error("plugin module must default-export an init(sdk, config?) function");
    }
    await mod.default(control.sdk, input.config);
    endpoint.emit("init", { ok: true });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    endpoint.emit("init", { ok: false, error: err.message });
  }
}
