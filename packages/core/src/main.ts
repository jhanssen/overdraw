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
import { createLayoutDriver } from "./wm/layout-driver.js";
import { createFocusDriver } from "./protocols/focus-driver.js";
import { parseConfigArg, loadConfig } from "./config/load.js";
import { PluginRuntime } from "./plugins/index.js";
import { createOverlayBroker } from "./overlay.js";
import { createGpuBroker } from "./plugins/gpu-broker.js";
import { createDecorationBroker } from "./plugins/decoration-broker.js";
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED } from "./plugins/windows-broker.js";
import { createAnimationsBroker, NOT_HANDLED as ANIM_NOT_HANDLED } from "./plugins/animations-broker.js";
import { createEvaluator } from "./animations/evaluator.js";
import { BUNDLED_PLUGINS, bundledToResolved } from "./plugins/bundled.js";
import { JsCompositor } from "./gpu/compositor.js";
import type { DawnWire, DawnGlobals } from "./gpu/compositor.js";
import type { Addon, InputEvent } from "./types.js";
import type { CompositorSink, CompositorState } from "./protocols/ctx.js";
import { WINDOW_EVENT } from "./events/types.js";
import { createCompositorBus } from "./events/window-bus.js";
import { DynamicBus } from "./events/dynamic-bus.js";
import { IpcServer } from "./ipc/server.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const addon = require(join(__dirname, "..", "build", "overdraw_native.node")) as Addon;
const gpuBin = process.env.OVERDRAW_GPU_PROCESS
  ?? join(__dirname, "..", "build", "overdraw-gpu-process");

// The compositing pass runs in core JS over the Dawn wire (dawn.node).
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

// Two buses: the core-internal typed bus (in-core subscribers like the
// clipboard layer) and the plugin-visible dynamic bus (sdk.events +
// IPC). Window.* events are republished from the typed bus onto the
// plugin bus verbatim.
const bus = createCompositorBus();
const pluginBus = new DynamicBus();
bus.on(WINDOW_EVENT.map, (ev) => { pluginBus.emit(WINDOW_EVENT.map, ev); });
bus.on(WINDOW_EVENT.unmap, (ev) => { pluginBus.emit(WINDOW_EVENT.unmap, ev); });
bus.on(WINDOW_EVENT.change, (ev) => { pluginBus.emit(WINDOW_EVENT.change, ev); });

let ipcServer: IpcServer | null = null;

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
  // Stop IPC first (synchronous-ish; awaits socket close + unlink). The IPC
  // server runs alongside the runtime, so order doesn't matter for safety;
  // doing IPC first ensures no in-flight requests during the runtime teardown.
  const stopIpc = ipcServer ? ipcServer.stop().catch(() => {}) : Promise.resolve();
  if (runtime) {
    const r = runtime;
    void stopIpc.then(() => r.stop()).then(finish, finish);
    setTimeout(finish, 3000).unref();
  } else {
    void stopIpc.then(finish, finish);
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

// The WM needs a layout driver before installProtocols creates it; the driver
// invokes the layout plugin via the runtime; the runtime is created later.
// Use a forward-reference closure: by the time the first compute() fires
// (on a Wayland commit), runtime.load(resolved) has run and the bundled
// 'layout' plugin has registered. waitForNamespace handles the boot race
// where addWindow could fire before plugins finish init.
state = await installProtocols(addon, {
  output: config.output ?? { width: dims.width, height: dims.height },
  compositor,
  bus,
  layoutDriverFactory: (target, snapshot) => createLayoutDriver({
    target, snapshot,
    compute: async (inputs) => {
      if (!runtime) throw new Error("layout: runtime not initialized");
      await runtime.waitForNamespace("layout");
      // LayoutInputs is structurally a Json (numbers/strings/objects/arrays);
      // the wire Json type machinery doesn't model the optional fields, hence
      // the cast.
      // eslint-disable-next-line no-restricted-syntax
      const args = [inputs as unknown as import("./plugins/protocol.js").Json];
      const result = await runtime.invokeNamespace("layout", "compute", args);
      // LayoutResult is by-contract returned by the plugin (LayoutAPI); cast
      // it back at the boundary. The plugin author is responsible for shape.
      // eslint-disable-next-line no-restricted-syntax
      return result as unknown as import("@overdraw/layout-types").LayoutResult;
    },
  }),
  focusDriverFactory: (target) => createFocusDriver({
    target,
    decide: async (inputs) => {
      if (!runtime) throw new Error("focus: runtime not initialized");
      // The first focus dispatch (e.g. window-mapped on the very first
      // client) can race plugin load; wait for the 'focus' namespace
      // before invoking. After the first wait, subsequent calls go
      // straight through.
      await runtime.waitForNamespace("focus");
      // eslint-disable-next-line no-restricted-syntax
      const args = [inputs as unknown as import("./plugins/protocol.js").Json];
      const result = await runtime.invokeNamespace("focus", "decide", args);
      // eslint-disable-next-line no-restricted-syntax
      return result as unknown as import("@overdraw/focus-types").FocusResult;
    },
  }),
});

console.log(`[overdraw] Wayland server listening.`);
console.log(`[overdraw] run a client with:  WAYLAND_DISPLAY=${sock} <your-client>`);

// Bundled plugins first (priority 0 floor), then user-config plugins
// (default priority 100). A `module` that looks like a path (absolute or
// ./ ../) resolves to a file:// URL; bare specifiers pass through to
// Node's resolver.
const bundledResolved = BUNDLED_PLUGINS.map((spec) => {
  const isPath = isAbsolute(spec.module)
    || spec.module.startsWith("./") || spec.module.startsWith("../");
  const module = isPath
    ? pathToFileURL(resolvePath(process.cwd(), spec.module)).href
    : spec.module;
  return bundledToResolved(spec, module, config);
});

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
// Wire the WM's decoration-resize indirection through the broker.
state.decorationResize = (windowId, outerRect, contentRect, insets) =>
  decorationBroker.onDecorationResized(windowId, outerRect, contentRect, insets);

// GPU broker: services plugin Worker GPU/surface requests.
const gpuBroker = createGpuBroker({
  addon, compositor, overlays, dawn, coreDeviceHandle: h.device,
  onSurfaceAllocated: (sid, win) => decorationBroker.onSurfaceAllocated(sid, win),
  onSurfacePresented: (sid) => decorationBroker.onSurfacePresented(sid),
});

// Windows broker: services sdk.windows.set / set-state / get-state / get /
// list / delete-state / set-output-stack. core-plugin-api.md §1.
if (!state.wm) throw new Error("internal: state.wm not set by installProtocols");
const windowsBroker = createWindowsBroker({
  wm: state.wm, compositor, state, pluginBus, bus,
});

// Animation evaluator + broker (core-plugin-api.md §9). The evaluator
// ticks once per compositor frame from state.beforeRender (wired below);
// the broker routes plugin animations.run / cancel requests to it.
const evaluator = createEvaluator(compositor);
const animationsBroker = createAnimationsBroker(evaluator);
state.beforeRender = (timeMs: number): void => { evaluator.tick(timeMs); };

// The runtime is created unconditionally so the IPC server has an action
// registry to dispatch against even before any plugin is loaded. load() is
// called with the combined bundled + user-config plugin set (possibly
// empty).
runtime = new PluginRuntime({
  pluginAddonPath,
  dawnPath: dawnNodePath,
  // In-thread bundled plugins share core's GPUDevice. main.ts already
  // brought up the device + the overlay broker + the compositor; package
  // them into the bundle the in-thread loader uses to construct sdk.gpu.
  inThreadGpu: {
    coreDevice: device,
    // DawnGlobals is the narrow shape compositor.ts cares about (3 enums);
    // the in-thread loader installs the FULL dawn.globals bag on globalThis,
    // matching what the Worker path does. Widen at the call site.
    // eslint-disable-next-line no-restricted-syntax
    globals: dawn.globals as unknown as Record<string, unknown>,
    overlays,
    compositor,
  },
  bus: pluginBus,
  onEvent: (plugin, name, data) => {
    if (name === "log") console.log(`[plugin ${plugin}] ${String(data)}`);
  },
  onRequest: (plugin, method, params) => {
    if (method.startsWith("decoration.")) {
      return decorationBroker.onRequest(plugin, method, params);
    }
    if (method.startsWith("windows.")) {
      const r = windowsBroker(plugin, method, params);
      if (r === WINDOWS_NOT_HANDLED) {
        throw new Error(`no handler for windows method '${method}'`);
      }
      return r;
    }
    if (method.startsWith("animations.")) {
      const r = animationsBroker(plugin, method, params);
      if (r === ANIM_NOT_HANDLED) {
        throw new Error(`no handler for animations method '${method}'`);
      }
      return r;
    }
    // gpu.* / surface.* are the Worker-transport GPU SDK protocol
    // (createPluginGpu in plugins/gpu.ts). In-thread plugins skip this
    // entirely -- their sdk.gpu is constructed in-process and talks to
    // the overlay broker directly; they never originate these requests.
    // Route by prefix rather than as a catch-all so an unknown method
    // surfaces a clear error instead of being mis-dispatched.
    if (method.startsWith("gpu.") || method.startsWith("surface.")) {
      return gpuBroker(plugin, method, params);
    }
    throw new Error(`no handler for plugin request '${method}'`);
  },
});
await runtime.load(resolved);
const summary = runtime.states().map((s) => `${s.name}=${s.state}`).join(", ");
console.log(`[overdraw] plugins: ${summary.length > 0 ? summary : "(none)"}`);

// IPC server: JSON-RPC 2.0 over a Unix socket. Plugins register actions and
// emit events; overdrawctl / status bars / scripts connect here.
// core-plugin-api.md §12.
const runtimeDir = process.env.XDG_RUNTIME_DIR;
if (!runtimeDir) {
  console.warn("[overdraw] XDG_RUNTIME_DIR not set; IPC server disabled");
} else {
  const socketPath = join(runtimeDir, `overdraw-${sock}.sock`);
  ipcServer = new IpcServer({ socketPath, runtime, bus: pluginBus });
  await ipcServer.start();
  console.log(`[overdraw] IPC: ${socketPath}`);
}

console.log(`[overdraw] ctrl-c to quit.`);
