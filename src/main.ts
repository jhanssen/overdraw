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
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, isAbsolute, resolve as resolvePath } from "node:path";
import { globSync } from "node:fs";

import { installProtocols } from "./protocols/index.js";
import { parseConfigArg, loadConfig } from "./config/load.js";
import { PluginRuntime } from "./plugins/index.js";
import { createOverlayBroker } from "./overlay.js";
import { createGpuBroker } from "./plugins/gpu-broker.js";
import { createDecorationBroker } from "./plugins/decoration-broker.js";
import { JsCompositor } from "./gpu/compositor.js";
import type { DawnWire, DawnGlobals } from "./gpu/compositor.js";
import type { Addon, InputEvent } from "./types.js";
import type { CompositorSink, CompositorState } from "./protocols/ctx.js";
import { WINDOW_EVENT } from "./events/types.js";
import { createCompositorBus } from "./events/window-bus.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const addon = require(join(__dirname, "..", "build", "overdraw_native.node")) as Addon;
const gpuBin = process.env.OVERDRAW_GPU_PROCESS
  ?? join(__dirname, "..", "build", "overdraw-gpu-process");

// The compositing pass runs in core JS over the Dawn wire (dawn.node); the C++
// compositing pass no longer exists.
interface DawnModule extends DawnWire {
  wrapDevice(instanceHandle: bigint, deviceHandle: bigint): GPUDevice;
  globals: DawnGlobals;
}
function loadDawn(): DawnModule | null {
  const [p] = globSync(join(__dirname, "..", "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  return p ? (require(p) as DawnModule) : null;
}

let state: CompositorState | null = null;
const onInput = (ev: InputEvent): void => { state?.seat?.handleInput(ev); };

// Per-frame: fire client frame callbacks so their render loops advance. The
// argument is the presented-frame count; clients want a ms timestamp, so use a
// monotonic clock here.
const onFrame = (): void => {
  state?.dispatchFrameCallbacks?.(Math.round(performance.now()));
};

let runtime: PluginRuntime | null = null;

// The core-internal event bus. Producers (protocol layer, seat) emit; the
// plugin-forwarding subscribers below relay window.* events to plugin Workers.
// The clipboard layer subscribes to keyboard.focus inside installProtocols.
const bus = createCompositorBus();

// Forward window.* events to the plugin runtime (structured-clone over postMessage).
// The runtime may not exist yet (no plugins) or a window may map before it loads;
// broadcast is a no-op when there are no live plugins. The payloads are already the
// wire shape (events/types.ts), so they forward verbatim.
bus.on(WINDOW_EVENT.map, (ev) => { runtime?.broadcast(WINDOW_EVENT.map, ev); });
bus.on(WINDOW_EVENT.unmap, (ev) => { runtime?.broadcast(WINDOW_EVENT.unmap, ev); });
bus.on(WINDOW_EVENT.change, (ev) => { runtime?.broadcast(WINDOW_EVENT.change, ev); });

let stopped = false;
function shutdown(signal: string): void {
  if (stopped) return;
  stopped = true;
  console.log(`[overdraw] ${signal}; shutting down`);
  // Graceful plugin shutdown is async (onShutdown callbacks). Give it a brief
  // chance, then tear down the compositor and exit regardless.
  const finish = (): void => {
    try { addon.stopServer(); } catch { /* ignore */ }
    try { addon.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  if (runtime) {
    void runtime.stop().then(finish, finish);
    setTimeout(finish, 3000).unref();
  } else {
    finish();
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const config = await loadConfig(parseConfigArg(process.argv.slice(2)));
console.log(`[overdraw] config: ${config.sourcePath ?? "(defaults; no config file)"}`);

const dims = addon.start(gpuBin, onFrame, onInput);
console.log(`[overdraw] compositor up; output ${dims.width}x${dims.height}`);

// Bring up the JS compositor (nested present to the host swapchain over the wire).
const dawn = loadDawn();
if (!dawn) throw new Error("dawn.node not found (build the Dawn release with --node)");
const h = addon.gpuHandles();
if (!h) throw new Error("gpuHandles() returned null; compositor not running");
const device = dawn.wrapDevice(h.instance, h.device);
const compositor: CompositorSink = new JsCompositor(device, dawn.globals, addon,
  { width: dims.width, height: dims.height }, dawn, h.device,
  { nested: true, format: addon.outputFormat() });
console.log("[overdraw] compositor: JS (over the Dawn wire)");

const sock = addon.startServer();
state = await installProtocols(addon, {
  output: config.output ?? { width: dims.width, height: dims.height },
  focus: config.focus,
  compositor,
  bus,
});

console.log(`[overdraw] Wayland server listening.`);
console.log(`[overdraw] run a client with:  WAYLAND_DISPLAY=${sock} <your-client>`);

// Plugins (scope B: isolation + lifecycle + watchdog + restart; no GPU/window
// SDK yet). A plugin `module` that looks like a filesystem path (absolute, or
// starting with ./ or ../) is resolved relative to the config file's directory
// (or cwd when no config file); bare specifiers pass through to the resolver.
if (config.plugins.length > 0) {
  const base = config.sourcePath ? dirname(config.sourcePath) : process.cwd();
  const resolved = config.plugins.map((p) => {
    const m = p.module;
    const isPath = isAbsolute(m) || m.startsWith("./") || m.startsWith("../");
    return isPath ? { ...p, module: pathToFileURL(resolvePath(base, m)).href } : p;
  });
  // GPU broker: services plugin Worker GPU/surface requests (connection, surface
  // alloc, fence dance, overlay compositing). Needs the overlay broker + the
  // core device handle for wrapping consumer textures.
  const overlays = createOverlayBroker(state, config.output ?? { width: dims.width, height: dims.height });
  const gpuBroker = createGpuBroker({ addon, compositor, overlays, dawn, coreDeviceHandle: h.device });
  const [dawnNodePath] = globSync(join(__dirname, "..", "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  const pluginAddonPath = join(__dirname, "..", "build", "overdraw_plugin_native.node");

  // Decoration broker: services decoration.* requests + owns the app_id-regex
  // provider registry, which subscribes to the bus and notifies matched plugins.
  // emitToPlugin lazily references `runtime` (assigned below; matches fire only
  // after a client maps, well after load).
  const decorationBroker = createDecorationBroker({
    bus,
    emitToPlugin: (plugin, name, data) => { runtime?.emit(plugin, name, data); },
  });

  runtime = new PluginRuntime({
    pluginAddonPath,
    dawnPath: dawnNodePath,
    onEvent: (plugin, name, data) => {
      if (name === "log") console.log(`[plugin ${plugin}] ${String(data)}`);
    },
    onRequest: (plugin, method, params) =>
      method.startsWith("decoration.")
        ? decorationBroker.onRequest(plugin, method, params)
        : gpuBroker(plugin, method, params),
  });
  await runtime.load(resolved);
  const summary = runtime.states().map((s) => `${s.name}=${s.state}`).join(", ");
  console.log(`[overdraw] plugins: ${summary}`);
}

console.log(`[overdraw] ctrl-c to quit.`);
