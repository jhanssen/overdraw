// Plugin Worker entry. Runs INSIDE a worker_threads Worker. Adapts
// parentPort to a Channel and delegates to runLoader (the loader is
// shared with the main-thread path in inthread-plugin.ts).

import { parentPort, workerData } from "node:worker_threads";
import { format } from "node:util";

import { channelFor, type Channel } from "./protocol.js";
import { runLoader } from "./loader.js";

interface BootstrapData {
  module: string;
  name: string;
  config?: unknown;
  pluginAddonPath?: string;
  dawnPath?: string;
  // Snapshot of live outputIds at worker spawn time. Read by sdk.compose's
  // outputId validation. Worker-thread plugins cannot observe later
  // output.added/removed events directly; this stays a worker-spawn-time
  // snapshot until the bus signals reach in here.
  liveOutputIds: number[];
}

// A Worker gets its own console, so the host's console shim does not reach
// plugin code -- unshimmed, plugin console.* writes raw to the shared stdout,
// bypassing spdlog (areas, the file sink, the crash ring). Replace the six
// routine methods with shims that ship the formatted line to the host as the
// same "log" event sdk.log uses, tagged with the spdlog level of the console
// method. Installed before runLoader so console calls during plugin module
// load are captured too.
function installWorkerConsoleShim(ch: Channel): void {
  const to = (level: number) =>
    (...args: unknown[]): void => {
      let text: string;
      try { text = format(...args); } catch { text = args.map(String).join(" "); }
      // The port can close during teardown; a lost line beats a throw from
      // inside console.log.
      try { ch.postMessage({ kind: "event", name: "log", data: { level, text } }); }
      catch { /* dropped */ }
    };
  console.log   = to(2) as typeof console.log;    // info
  console.info  = to(2) as typeof console.info;   // info
  console.debug = to(1) as typeof console.debug;  // debug
  console.trace = to(0) as typeof console.trace;  // trace
  console.warn  = to(3) as typeof console.warn;   // warn
  console.error = to(4) as typeof console.error;  // err
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error("bootstrap must run as a Worker (no parentPort)");
  const data = workerData as BootstrapData;
  const liveOutputs = new Set<number>(data.liveOutputIds);
  const channel = channelFor(parentPort);
  installWorkerConsoleShim(channel);
  await runLoader(channel, {
    module: data.module,
    name: data.name,
    config: data.config,
    pluginAddonPath: data.pluginAddonPath,
    dawnPath: data.dawnPath,
    hasOutput: (id) => liveOutputs.has(id),
  });
}

void main();
