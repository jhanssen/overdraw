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
}

async function main(): Promise<void> {
  if (!parentPort) throw new Error("bootstrap must run as a Worker (no parentPort)");
  const data = workerData as BootstrapData;
  await runLoader(channelFor(parentPort), {
    module: data.module,
    name: data.name,
    config: data.config,
    pluginAddonPath: data.pluginAddonPath,
    dawnPath: data.dawnPath,
  });
}

void main();
