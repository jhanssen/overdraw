// Plugin Worker entry. Runs INSIDE a worker_threads Worker.
//
// All loader logic is in loader.ts (shared with the in-thread path used by
// bundled plugins). This file's job is:
//   1. Grab parentPort + workerData (the Worker-specific bits).
//   2. Adapt parentPort to a Channel via channelFor.
//   3. Delegate to runLoader.

import { parentPort, workerData } from "node:worker_threads";

import { channelFor } from "./protocol.js";
import { runLoader } from "./loader.js";

interface BootstrapData {
  module: string;
  name: string;
  // Per-plugin config (verbatim from ResolvedPlugin.raw for user plugins or
  // BundledPluginSpec.config for bundled plugins). May be undefined.
  config?: unknown;
  // Native paths for plugins with the gpu capability.
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
