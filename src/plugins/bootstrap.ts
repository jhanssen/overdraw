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
import type { PluginGpu } from "./gpu.js";
import { createWindowObserver } from "./window-observer.js";

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
  if (pluginAddonPath && dawnPath) {
    const g = await createPluginGpu(endpoint, pluginAddonPath, dawnPath);
    gpu = g.gpu;
    const t = setInterval(g.pump, 4);  // keep the plugin wire flowing
    t.unref?.();
  }

  // Window-state observation (sdk.window.onMap/onUnmap). The core pushes window.*
  // events; this observer dispatches them to the plugin's registered handlers.
  const windows = createWindowObserver();

  // SDK logs are forwarded to the core as one-way events (the core prints them).
  const control = createSdk(name, (line) => { endpoint.emit("log", line); }, gpu, windows.observer);

  // The only request the core sends in scope B is 'shutdown'. Run the registered
  // onShutdown callback; resolving lets the core proceed to terminate.
  endpoint.handleRequests(async (method): Promise<Json> => {
    if (method === "shutdown") { await control.runShutdown(); return null; }
    throw new Error(`unknown request method '${method}'`);
  });

  // Core -> plugin one-way events: route window.* to the observer. Unknown event
  // names are ignored (forward-compatible with future core-originated events).
  endpoint.handleEvents((eventName, data) => { windows.dispatch(eventName, data); });

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
