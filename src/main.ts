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
import { BUNDLED_PLUGINS, bundledToResolved } from "./plugins/bundled.js";
import { JsCompositor } from "./gpu/compositor.js";
import type { DawnWire, DawnGlobals } from "./gpu/compositor.js";
import type { Addon, InputEvent } from "./types.js";
import type { CompositorSink, CompositorState } from "./protocols/ctx.js";
import { WINDOW_EVENT } from "./events/types.js";
import { createCompositorBus } from "./events/window-bus.js";
import { DynamicBus } from "./events/dynamic-bus.js";

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

// The core-internal typed bus. Producers (protocol layer, seat) emit; in-core
// subscribers (e.g. clipboard for keyboard.focus) call bus.on(...). The typed
// bus stays for static, core-internal event delivery.
const bus = createCompositorBus();

// The plugin-visible dynamic bus. Window.* events from the typed bus are
// republished here for plugin subscription; plugins also emit their own events
// to it. This is the substrate for sdk.events (core-plugin-api.md §3) and the
// later IPC subscription pipe.
const pluginBus = new DynamicBus();

// Republish core-emitted window.* events onto the plugin bus. The payloads are
// already the wire shape (events/types.ts) and forward verbatim.
bus.on(WINDOW_EVENT.map, (ev) => { pluginBus.emit(WINDOW_EVENT.map, ev); });
bus.on(WINDOW_EVENT.unmap, (ev) => { pluginBus.emit(WINDOW_EVENT.unmap, ev); });
bus.on(WINDOW_EVENT.change, (ev) => { pluginBus.emit(WINDOW_EVENT.change, ev); });

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

// Plugins. Bundled plugins ship with overdraw and load at priority 0 (the
// floor of the namespace priority chain); user-config plugins load second at
// the default priority of 100 (override-able). core-plugin-api.md §"No-plugin-
// loaded fallback".
//
// A plugin `module` that looks like a filesystem path (absolute, or starting
// with ./ or ../) is resolved relative to the config file's directory (or cwd
// when no config file); bare specifiers pass through to the resolver.
const bundledResolved = BUNDLED_PLUGINS.map((spec) => {
  // Bundled modules are bare specifiers ('@overdraw/plugin-*'); the runtime
  // resolves them via Node's normal module resolution. In dev, a path could
  // also be used; treat the same as user-config path handling below for
  // consistency.
  const isPath = isAbsolute(spec.module)
    || spec.module.startsWith("./") || spec.module.startsWith("../");
  const module = isPath
    ? pathToFileURL(resolvePath(process.cwd(), spec.module)).href
    : spec.module;
  return bundledToResolved(spec, module);
});

if (bundledResolved.length + config.plugins.length > 0) {
  const base = config.sourcePath ? dirname(config.sourcePath) : process.cwd();
  const userResolved = config.plugins.map((p) => {
    const m = p.module;
    const isPath = isAbsolute(m) || m.startsWith("./") || m.startsWith("../");
    return isPath ? { ...p, module: pathToFileURL(resolvePath(base, m)).href } : p;
  });
  const resolved = [...bundledResolved, ...userResolved];
  const overlays = createOverlayBroker(state, config.output ?? { width: dims.width, height: dims.height });
  const [dawnNodePath] = globSync(join(__dirname, "..", "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  const pluginAddonPath = join(__dirname, "..", "build", "overdraw_plugin_native.node");

  // Decoration broker: services decoration.* requests + owns the app_id-regex
  // provider registry + the content-gating state machine. emitToPlugin lazily
  // references `runtime` (assigned below; matches fire only after a client maps).
  const decorationBroker = createDecorationBroker({
    bus,
    state,
    emitToPlugin: (plugin, name, data) => { runtime?.emit(plugin, name, data); },
  });
  // Wire the WM's decoration-resize indirection through the broker, so an outer
  // tile change (relayout/insets) becomes a decoration.resized event to the
  // owning plugin. Done after broker creation; state.decorationResize is a
  // settable hook on CompositorState the WM calls.
  state.decorationResize = (windowId, outerRect, contentRect, insets) =>
    decorationBroker.onDecorationResized(windowId, outerRect, contentRect, insets);

  // GPU broker: services plugin Worker GPU/surface requests (connection, surface
  // alloc, fence dance, overlay/decoration compositing). The generic surface hooks
  // feed the decoration broker (surface<->window link + first-present release).
  const gpuBroker = createGpuBroker({
    addon, compositor, overlays, dawn, coreDeviceHandle: h.device,
    onSurfaceAllocated: (sid, win) => decorationBroker.onSurfaceAllocated(sid, win),
    onSurfacePresented: (sid) => decorationBroker.onSurfacePresented(sid),
  });

  runtime = new PluginRuntime({
    pluginAddonPath,
    dawnPath: dawnNodePath,
    bus: pluginBus,
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
