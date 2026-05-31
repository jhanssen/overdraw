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
import { globSync } from "node:fs";

import { installProtocols } from "./protocols/index.js";
import { parseConfigArg, loadConfig } from "./config/load.js";
import { JsCompositor } from "./gpu/compositor.js";
import type { Addon, InputEvent } from "./types.js";
import type { CompositorSink, CompositorState } from "./protocols/ctx.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const addon = require(join(__dirname, "..", "build", "overdraw_native.node")) as Addon;
const gpuBin = process.env.OVERDRAW_GPU_PROCESS
  ?? join(__dirname, "..", "build", "overdraw-gpu-process");

// The JS compositor (compositing pass in core JS over the Dawn wire) is the
// default; set OVERDRAW_NATIVE_COMPOSITOR=1 to fall back to the C++ pass.
const useJsCompositor = process.env.OVERDRAW_NATIVE_COMPOSITOR !== "1";
function loadDawn(): { wrapDevice: (i: bigint, d: bigint) => unknown; globals: unknown; wrapTexture: unknown } | null {
  const [p] = globSync(join(__dirname, "..", "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  return p ? (require(p)) : null;
}

let state: CompositorState | null = null;
const onInput = (ev: InputEvent): void => { state?.seat?.handleInput(ev); };

// Per-frame: fire client frame callbacks so their render loops advance. The
// argument is the presented-frame count; clients want a ms timestamp, so use a
// monotonic clock here.
const onFrame = (): void => {
  state?.dispatchFrameCallbacks?.(Math.round(performance.now()));
};

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

const config = await loadConfig(parseConfigArg(process.argv.slice(2)));
console.log(`[overdraw] config: ${config.sourcePath ?? "(defaults; no config file)"}`);
if (config.plugins.length > 0) {
  // DEFERRED: the plugin runtime is not built yet (docs/status.md). The config
  // is validated and reported, but nothing loads these — they are inert.
  console.log(`[overdraw] ${config.plugins.length} plugin(s) configured; plugin runtime not implemented yet (ignored)`);
}

const dims = addon.start(gpuBin, onFrame, onInput);
console.log(`[overdraw] compositor up; output ${dims.width}x${dims.height}`);

// Bring up the JS compositor (nested present to the host swapchain over the
// wire). Falls back to the native C++ pass if dawn.node is missing or disabled.
let compositor: CompositorSink | undefined;
if (useJsCompositor) {
  const dawn = loadDawn();
  if (dawn) {
    const h = addon.gpuHandles();
    if (h) {
      const device = dawn.wrapDevice(h.instance, h.device);
      compositor = new JsCompositor(device, dawn.globals, addon as never,
        { width: dims.width, height: dims.height }, dawn as never, h.device,
        { nested: true, format: addon.outputFormat() });
      addon.setExternalCompositor(true);
      console.log("[overdraw] compositor: JS (over the Dawn wire)");
    }
  }
  if (!compositor) console.log("[overdraw] compositor: native C++ (dawn.node unavailable)");
} else {
  console.log("[overdraw] compositor: native C++ (OVERDRAW_NATIVE_COMPOSITOR=1)");
}

const sock = addon.startServer();
state = await installProtocols(addon, {
  output: config.output ?? { width: dims.width, height: dims.height },
  focus: config.focus,
  compositor,
});

console.log(`[overdraw] Wayland server listening.`);
console.log(`[overdraw] run a client with:  WAYLAND_DISPLAY=${sock} <your-client>`);
console.log(`[overdraw] ctrl-c to quit.`);
