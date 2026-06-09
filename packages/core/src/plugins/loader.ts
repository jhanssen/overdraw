// Generic plugin loader. Called from both bootstrap.ts (Worker entry) and
// inthread-plugin.ts (main-thread bundled plugins). Builds the SDK,
// imports the plugin module, calls init(sdk, config?), and reports the
// init outcome as an 'init' event. The Endpoint stays attached to the
// channel for the lifetime; the caller owns shutdown.
//
// Pings auto-pong via the Endpoint default. The Worker watchdog kills on
// missed pongs; in-thread has no watchdog (liveness == core's event loop).

import { Endpoint } from "./protocol.js";
import type { Channel, Json } from "./protocol.js";
import { createSdk } from "./sdk.js";
import type { PluginSdk } from "./sdk.js";
import { createPluginGpu } from "./gpu.js";
import type { PluginGpu, RingMaker } from "./gpu.js";
import { createPluginWindows } from "./windows-sdk.js";
import { createDecorations } from "./decorations.js";
import { createPluginEvents } from "./events.js";
import { createNamespaceHandle } from "./namespace.js";
import { createPluginActions } from "./actions.js";

export interface LoaderInput {
  module: string;
  name: string;
  // Per-plugin config slice; passed verbatim as init's second arg.
  config?: unknown;
  // Set these to enable sdk.gpu + sdk.decorations. Bundled in-thread
  // plugins omit them (no GPU need).
  pluginAddonPath?: string;
  dawnPath?: string;
}

type InitFn = (sdk: PluginSdk, config?: unknown) => unknown | Promise<unknown>;

export async function runLoader(channel: Channel, input: LoaderInput): Promise<void> {
  const endpoint = new Endpoint(channel);

  let gpu: PluginGpu | undefined;
  let makeRingSurface: RingMaker | undefined;
  let stopGpu: () => void = () => {};
  if (input.pluginAddonPath && input.dawnPath) {
    const g = await createPluginGpu(endpoint, input.pluginAddonPath, input.dawnPath);
    gpu = g.gpu;
    makeRingSurface = g.makeRingSurface;
    const t = setInterval(g.pump, 4);
    t.unref?.();
    stopGpu = () => { clearInterval(t); g.stop(); };
  }

  const eventsHandle = createPluginEvents(endpoint);
  const nsHandle = createNamespaceHandle(endpoint);
  const actionsHandle = createPluginActions(endpoint);
  const windowsCtl = createPluginWindows(endpoint, eventsHandle.events);
  const decorations = makeRingSurface ? createDecorations(endpoint, makeRingSurface) : undefined;

  const control = createSdk(input.name, (line) => { endpoint.emit("log", line); },
    eventsHandle.events, nsHandle.ns, actionsHandle.actions, windowsCtl.windows,
    gpu, decorations?.decorations);

  endpoint.handleRequests(async (method, params): Promise<Json> => {
    const ns = nsHandle.dispatcher.tryHandle(method, params);
    if (ns.handled) return await ns.result;

    const ac = actionsHandle.dispatcher.tryHandle(method, params);
    if (ac.handled) return await ac.result;

    if (method === "shutdown") {
      stopGpu();
      await control.runShutdown();
      return null;
    }
    throw new Error(`unknown request method '${method}'`);
  });

  endpoint.handleEvents((eventName, data) => {
    if (eventsHandle.dispatcher.dispatch(eventName, data)) return;
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
