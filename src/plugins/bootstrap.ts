// Plugin Worker bootstrap (runs INSIDE the worker_threads Worker, NOT on the
// core thread). Responsibilities (architecture.md "Plugin module shape" /
// "Lifecycle"):
//   1. Build the capability-scoped SDK object.
//   2. Dynamically import the plugin module and call its default init(sdk).
//   3. Report init resolve/reject to the core as an {name:'init'} event.
//   4. Auto-reply to watchdog pings (Endpoint default ping->pong) so a LIVE
//      plugin proves liveness; a hot loop here never drains the queue -> the
//      core's watchdog sees missed pongs and terminates this Worker.
//   5. Handle the 'shutdown' request: run onShutdown, then resolve (the core
//      terminates the Worker after the reply or its timeout).
//
// The plugin module's default export is an async init function:
//   export default async function init(sdk) { ... }

import { parentPort, workerData } from "node:worker_threads";

import { Endpoint, channelFor } from "./protocol.js";
import type { Json } from "./protocol.js";
import { createSdk } from "./sdk.js";
import type { PluginSdk } from "./sdk.js";
import { createPluginGpu } from "./gpu.js";
import type { PluginGpu, RingMaker } from "./gpu.js";
import { createPluginWindows } from "./windows-sdk.js";
import { createDecorations } from "./decorations.js";
import { createPluginEvents } from "./events.js";
import { createNamespaceHandle } from "./namespace.js";
import { createPluginActions } from "./actions.js";

interface BootstrapData {
  module: string;
  name: string;
  // Absolute paths to the plugin Worker addon + dawn.node. Present iff the plugin
  // has the `gpu` capability (the runtime brings up the device before init).
  pluginAddonPath?: string;
  dawnPath?: string;
}

type InitFn = (sdk: PluginSdk) => unknown | Promise<unknown>;

async function main(): Promise<void> {
  if (!parentPort) throw new Error("bootstrap must run as a Worker (no parentPort)");
  const port = parentPort;
  const { module: moduleSpec, name } = workerData as BootstrapData;

  const { pluginAddonPath, dawnPath } = workerData as BootstrapData;
  const endpoint = new Endpoint(channelFor(port));

  // Bring up the plugin's GPU device (over its own wire client) BEFORE init, so
  // sdk.gpu is ready. Only when the runtime provided the native module paths
  // (i.e. the plugin has the `gpu` capability). Keeps a steady-state pump going.
  let gpu: PluginGpu | undefined;
  let makeRingSurface: RingMaker | undefined;
  // Quiesce the GPU layer + stop the pump on shutdown, BEFORE the core terminates
  // the Worker. Without this, a plugin's still-running render loop (and the pump)
  // keep issuing wire/device work into a wire being torn down, and worker.terminate()
  // kills the thread mid-submit -> dawn.node throws fatally (ThrowAsJavaScriptException
  // with no JS frame). No-op when the plugin has no GPU.
  let stopGpu: () => void = () => {};
  if (pluginAddonPath && dawnPath) {
    const g = await createPluginGpu(endpoint, pluginAddonPath, dawnPath);
    gpu = g.gpu;
    makeRingSurface = g.makeRingSurface;
    const t = setInterval(g.pump, 4);  // keep the plugin wire flowing
    t.unref?.();
    stopGpu = () => { clearInterval(t); g.stop(); };
  }

  // Event bus (sdk.events.subscribe / emit). core-plugin-api.md §3. Always
  // available; the dispatcher consumes core-pushed `events.dispatch` events.
  const eventsHandle = createPluginEvents(endpoint);

  // Plugin namespace registry surface (sdk.registerPlugin / sdk.plugin).
  // core-plugin-api.md §11. The dispatcher handles inbound `plugin.handle`
  // requests from core (other plugins calling this plugin's methods).
  const nsHandle = createNamespaceHandle(endpoint);

  // Action registry surface (sdk.actions). core-plugin-api.md §10. The
  // dispatcher handles inbound `actions.handle` requests from core.
  const actionsHandle = createPluginActions(endpoint);

  // Window observation + mutation (sdk.windows). core-plugin-api.md §1.
  // Observation uses sdk.events.subscribe('window.*') under the hood;
  // mutations (setFloating/setState/etc.) become windows.* requests to core.
  const windowsCtl = createPluginWindows(endpoint, eventsHandle.events);

  // Decoration provider (sdk.decorations). Needs the GPU ring allocator to draw, so
  // it is only available when the GPU is up (createDecoration draws a surface).
  const decorations = makeRingSurface ? createDecorations(endpoint, makeRingSurface) : undefined;

  // SDK logs are forwarded to the core as one-way events (the core prints them).
  const control = createSdk(name, (line) => { endpoint.emit("log", line); },
    eventsHandle.events, nsHandle.ns, actionsHandle.actions, windowsCtl.windows,
    gpu, decorations?.decorations);

  // Inbound request chain: try the namespace and actions dispatchers first
  // (plugin.handle, actions.handle), then fall through to the lifecycle
  // methods (shutdown). Unknown methods throw, which becomes a JSON-RPC-like
  // error response on the core side.
  endpoint.handleRequests(async (method, params): Promise<Json> => {
    const ns = nsHandle.dispatcher.tryHandle(method, params);
    if (ns.handled) return await ns.result;

    const ac = actionsHandle.dispatcher.tryHandle(method, params);
    if (ac.handled) return await ac.result;

    if (method === "shutdown") {
      // Quiesce GPU FIRST (stop the pump + park surface ops), then run the plugin's
      // onShutdown, so by the time the core terminates the Worker no GPU/wire work is
      // in flight. Order matters: stopping GPU before onShutdown means a plugin loop
      // awaiting getCurrentTexture parks instead of racing teardown.
      stopGpu();
      await control.runShutdown();
      return null;
    }
    throw new Error(`unknown request method '${method}'`);
  });

  // Core -> plugin one-way events: offer each to the events bus dispatcher
  // first (so plugin subscriptions catch everything they asked for), then to
  // the decoration observer (which still uses direct event dispatch; it will
  // migrate to the bus in a later phase). Unknown names are ignored
  // (forward-compatible with future core-originated events).
  endpoint.handleEvents((eventName, data) => {
    if (eventsHandle.dispatcher.dispatch(eventName, data)) return;
    decorations?.dispatch(eventName, data);
  });

  // Pings are auto-ponged by the Endpoint default (no explicit ping handler), so
  // a responsive event loop answers them; nothing more to wire here.

  try {
    const mod = (await import(moduleSpec)) as { default?: InitFn };
    if (typeof mod.default !== "function") {
      throw new Error("plugin module must default-export an init(sdk) function");
    }
    await mod.default(control.sdk);
    endpoint.emit("init", { ok: true });
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    // Report the failure and let the core terminate this Worker (it does so in
    // the init-failure branch). Exiting here ourselves would race the event
    // delivery, so we don't -- the core drives termination + restart policy.
    endpoint.emit("init", { ok: false, error: err.message });
  }
}

void main();
