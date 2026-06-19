// Plugin Worker entry. Runs INSIDE a worker_threads Worker. Adapts
// parentPort to a Channel and delegates to runLoader (the loader is
// shared with the main-thread path in inthread-plugin.ts).

import { parentPort, workerData } from "node:worker_threads";

import { channelFor } from "./protocol.js";
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

async function main(): Promise<void> {
  if (!parentPort) throw new Error("bootstrap must run as a Worker (no parentPort)");
  const data = workerData as BootstrapData;
  const liveOutputs = new Set<number>(data.liveOutputIds);
  await runLoader(channelFor(parentPort), {
    module: data.module,
    name: data.name,
    config: data.config,
    pluginAddonPath: data.pluginAddonPath,
    dawnPath: data.dawnPath,
    hasOutput: (id) => liveOutputs.has(id),
  });
}

void main();
