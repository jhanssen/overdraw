// overdraw launcher: run as a usable nested compositor.
//
// Brings up the GPU process + present loop, starts the Wayland server, installs
// the protocol layer, wires host input to the seat, prints the WAYLAND_DISPLAY
// to point clients at, and runs until SIGINT/SIGTERM. Unlike index.ts (a bounded
// present-loop demo) this is the entry you launch real clients against:
//
//   node dist/main.js
//   # then, in another terminal:
//   WAYLAND_DISPLAY=<printed name> your-client

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { installProtocols } from "./protocols/index.js";
import type { Addon, InputEvent } from "./types.js";
import type { CompositorState } from "./protocols/ctx.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const addon = require(join(__dirname, "..", "build", "overdraw_native.node")) as Addon;
const gpuBin = process.env.OVERDRAW_GPU_PROCESS
  ?? join(__dirname, "..", "build", "overdraw-gpu-process");

let state: CompositorState | null = null;
const onInput = (ev: InputEvent): void => { state?.seat?.handleInput(ev); };

let stopped = false;
function shutdown(signal: string): void {
  if (stopped) return;
  stopped = true;
  console.log(`[overdraw] ${signal}; shutting down`);
  try { addon.stopServer(); } catch { /* ignore */ }
  try { addon.stop(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const dims = addon.start(gpuBin, null, onInput);
console.log(`[overdraw] compositor up; output ${dims.width}x${dims.height}`);

const sock = addon.startServer();
state = await installProtocols(addon, { width: dims.width, height: dims.height });

console.log(`[overdraw] Wayland server listening.`);
console.log(`[overdraw] run a client with:  WAYLAND_DISPLAY=${sock} <your-client>`);
console.log(`[overdraw] ctrl-c to quit.`);
