// Generic plugin loader. Runs on either:
//   - The plugin Worker (called from bootstrap.ts, which is the Worker entry).
//   - The main thread (called from inthread-plugin.ts for bundled plugins).
//
// Inputs:
//   - A Channel for the SDK <-> core conversation (Endpoint wraps it).
//   - The plugin's module specifier + name + (optional) config.
//   - Optional GPU paths (Worker bundled-plugin path can have GPU; in-thread
//     bundled plugins skip it because the bundled plugins extracted so far
//     -- layout, focus -- don't need it).
//
// Responsibilities (per core-plugin-api.md, formerly inline in bootstrap.ts):
//   1. Build the capability-scoped SDK object.
//   2. Dynamically import the plugin module and call its default
//      `init(sdk, config?)`.
//   3. Report init resolve/reject as an {name:'init'} event.
//   4. Handle the 'shutdown' request: run onShutdown, then resolve.
//
// Watchdog pings are auto-ponged by the Endpoint default (no explicit handler
// is wired here); on the Worker path the kill-switch comes from missed pongs.
// On the in-thread path there is no watchdog -- liveness is co-extensive with
// the core's event loop.

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
  // Bare specifier or file URL of the plugin module. dynamic import() resolves.
  module: string;
  // Plugin's stable name (used by the SDK for log attribution).
  name: string;
  // Config object passed as the second arg to init(sdk, config). undefined
  // means no config (the plugin's init signature treats it as optional).
  // Core does NOT validate; pass-through verbatim per core-plugin-api.md.
  config?: unknown;
  // GPU bring-up paths. Present iff the plugin should have sdk.gpu (and
  // sdk.decorations). The in-thread loader passes neither (bundled plugins
  // extracted so far don't need GPU).
  pluginAddonPath?: string;
  dawnPath?: string;
}

// The plugin module's default export.
type InitFn = (sdk: PluginSdk, config?: unknown) => unknown | Promise<unknown>;

// Run the loader against a Channel + input. Returns once init either
// completes (sends {init, ok:true}) or fails (sends {init, ok:false, error}).
// The Endpoint stays attached to the channel; the caller (Worker bootstrap or
// in-thread harness) owns the lifecycle from there.
export async function runLoader(channel: Channel, input: LoaderInput): Promise<void> {
  const endpoint = new Endpoint(channel);

  // GPU bring-up (Worker bundled with GPU capability). Always absent for
  // in-thread; gpuPath/dawnPath are undefined.
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
    // Pass config as a second arg per core-plugin-api.md "Per-bundled-plugin
    // config" decision. Plugins not expecting config simply ignore the arg.
    await mod.default(control.sdk, input.config);
    endpoint.emit("init", { ok: true });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    endpoint.emit("init", { ok: false, error: err.message });
  }
}
