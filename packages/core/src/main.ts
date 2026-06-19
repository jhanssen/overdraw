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
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, isAbsolute, resolve as resolvePath } from "node:path";
import { globSync } from "node:fs";

import { installProtocols } from "./protocols/index.js";
import { makeOutputForOutput as makeWlOutputForOutput } from "./protocols/wl_output.js";
import { updateAllSurfaceResidency } from "./protocols/surface-residency.js";
import { createLayoutDriver } from "./wm/layout-driver.js";
import { createReservedZoneRegistry } from "./wm/reserved-zones.js";
import { createFocusDriver } from "./protocols/focus-driver.js";
import { parseConfigArg, loadConfig } from "./config/load.js";
import { PluginRuntime } from "./plugins/index.js";
import { createOverlayBroker } from "./overlay.js";
import { createGpuBroker } from "./plugins/gpu-broker.js";
import { createDecorationBroker } from "./plugins/decoration-broker.js";
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED } from "./plugins/windows-broker.js";
import { createAnimationsBroker, NOT_HANDLED as ANIM_NOT_HANDLED } from "./plugins/animations-broker.js";
import { createInputBroker, NOT_HANDLED as INPUT_NOT_HANDLED } from "./plugins/input-broker.js";
import { createEvaluator } from "./animations/evaluator.js";
import {
  createCursorBroker, CURSOR_NOT_HANDLED,
} from "./plugins/cursor-broker.js";
import { createCursorThemeResolver } from "./cursor/theme-resolver.js";
import { resolveScale, logicalSize } from "./output/scale.js";
import { Kinematics } from "./cursor/kinematics.js";
import { CursorRuleEngine } from "./cursor/rule-engine.js";
import { InterceptBroker } from "./intercept/broker.js";
import {
  createInterceptPluginBroker, INTERCEPT_NOT_HANDLED,
} from "./plugins/intercept-plugin-broker.js";
import {
  createTransitionsBroker, NOT_HANDLED as TRANSITIONS_NOT_HANDLED,
} from "./plugins/transitions-broker.js";
import { createSceneRegistry } from "./plugins/scene-registry.js";
import { BUNDLED_PLUGINS, bundledToResolved } from "./plugins/bundled.js";
import { JsCompositor } from "./gpu/compositor.js";
import type { DawnWire, DawnGlobals } from "./gpu/compositor.js";
import type { Addon, InputEvent } from "./types.js";
import type { CompositorSink, CompositorState } from "./protocols/ctx.js";
import { OUTPUT_DEFAULT } from "./protocols/ctx.js";
import { nextOutputPosition } from "./output/arrangement.js";
import { reemitWlOutput } from "./protocols/wl_output.js";
import { reemitXdgOutput } from "./protocols/zxdg_output_manager_v1.js";
import { reemitFractionalScale } from "./protocols/wp_fractional_scale_manager_v1.js";
import { WINDOW_EVENT } from "./events/types.js";
import { createCompositorBus } from "./events/window-bus.js";
import { DynamicBus } from "./events/dynamic-bus.js";
import { IpcServer } from "./ipc/server.js";
import { bindAddon, installConsoleShim, parseLogArgs, log } from "./log.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

const addon = require(join(__dirname, "..", "build", "overdraw_native.node")) as Addon;
const gpuBin = process.env.OVERDRAW_GPU_PROCESS
  ?? join(__dirname, "..", "build", "overdraw-gpu-process");

// Logging: configure spdlog from --log-level / --log-file BEFORE start() so
// the GPU-process log reader thread (started inside addon.start) dispatches
// records into a fully-configured registry. installConsoleShim replaces
// globalThis.console.{log,info,warn,error,debug,trace} -- everything that
// uses console.* from this point on routes through nativeLog on area "js".
bindAddon(addon);
{
  const logArgs = parseLogArgs(process.argv.slice(2));
  try {
    addon.logInit(logArgs);
  } catch (e) {
    process.stderr.write(`overdraw: ${(e as Error).message}\n`);
    process.exit(2);
  }
  installConsoleShim();
}

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
//
// After dispatch+render, if any subsystem still has continuous work (an
// animation in mid-flight, a transition still running, an intercept plugin
// that wants per-frame render callbacks), call addon.wake() so the next
// flip-complete drives the next render. Without this, an animation would
// stop after one frame because the addon's frame loop is otherwise idle
// after a render with no incoming events.
//
// `wakeIfActive` is assigned after the evaluators + intercept broker exist
// (the closure captures lexically, but the assignment happens at boot time
// before any frame fires; an extra `?.` guards the early-call window).
let wakeIfActive: (() => void) | null = null;
const onFrame = (): void => {
  state?.dispatchFrameCallbacks?.(Math.round(performance.now()));
  wakeIfActive?.();
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
bus.on(WINDOW_EVENT.closing, (ev) => { pluginBus.emit(WINDOW_EVENT.closing, ev); });

let ipcServer: IpcServer | null = null;

let stopped = false;
function shutdown(signal: string): void {
  if (stopped) return;
  stopped = true;
  log.info("core", `${signal}; shutting down`);
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

// The core-actions plugin's compositor.quit action emits this event; any
// other plugin or IPC caller can fire the same shutdown by emitting it
// directly. shutdown() is idempotent, so a SIGTERM during compositor.quit
// processing is safe.
pluginBus.subscribe("compositor.shutdown", () => shutdown("compositor.shutdown"));

const config = await loadConfig(parseConfigArg(process.argv.slice(2)));
log.info("core", `config: ${config.sourcePath ?? "(defaults; no config file)"}`);

// Backend selection. Production default: KMS (bare-metal). Override:
//   --backend=nested (e.g. running under Hyprland during dev)
//   OVERDRAW_BACKEND=nested
// KMS card override precedence: `--card=/dev/dri/cardN` > config `output.card`
// > auto-detect (the GPU process opens the first card with a connected
// connector).
function parseBackendOpts(argv: string[], configCard: string | null):
    { backend: "kms" | "nested"; card?: string } {
  let backend: "kms" | "nested" = "kms";
  let card: string | undefined = configCard ?? undefined;
  const envBackend = process.env.OVERDRAW_BACKEND;
  if (envBackend === "nested" || envBackend === "kms") backend = envBackend;
  for (const a of argv) {
    if (a === "--backend=nested") backend = "nested";
    else if (a === "--backend=kms") backend = "kms";
    else if (a.startsWith("--card=")) card = a.slice("--card=".length);
  }
  return card ? { backend, card } : { backend };
}
const backendOpts = parseBackendOpts(process.argv.slice(2), config.card);
log.info("core", `backend: ${backendOpts.backend}`
  + (backendOpts.card ? ` card=${backendOpts.card}` : ""));

const dims = addon.start(gpuBin, onFrame, onInput, backendOpts);
log.info("core", `compositor up; output ${dims.width}x${dims.height}`);

// Bring up the JS compositor. Production runs through the addon's per-output
// acquire/present API (KMS scanout slots or a nested-host swapchain texture,
// depending on the addon's backend). Headless mode (offscreen target +
// readback) is test-only and not constructed here.
const dawn = loadDawn();
if (!dawn) throw new Error("dawn.node not found (build the Dawn release with --node)");
const h = addon.gpuHandles();
if (!h) throw new Error("gpuHandles() returned null; compositor not running");
const device = dawn.wrapDevice(h.instance, h.device);
const compositor: CompositorSink = new JsCompositor(device, dawn.globals, addon,
  { width: dims.width, height: dims.height }, dawn, h.device,
  { headless: false, format: addon.outputFormat() });
log.info("core", "compositor: JS (over the Dawn wire)");

// Phase 9c: install the built-in default cursor. The XCursor theme
// resolver picks up XCURSOR_THEME / XCURSOR_SIZE from env; for
// 'default' the resolver always succeeds (built-in 16x16 fallback
// if no theme on disk). The cursor draws above every other layer
// (drawOrder appends it last when visible + textured).
{
  const cursorSize = Number(process.env.XCURSOR_SIZE) || 24;
  const r = addon.resolveCursorShape("default", cursorSize, 1);
  if (r) {
    compositor.setCursorPixels?.(r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
    compositor.setCursorVisible?.(true);
    log.info("core", `cursor: default ${r.width}x${r.height} hotspot=(${r.hotspotX},${r.hotspotY})`);
  } else {
    log.warn("core", "cursor: default shape not resolved; no cursor shown");
  }
}

const sock = addon.startServer();

// Reserved-zone registry. Layer-shell exclusive zones write into it; the
// layout driver and the protocol layer share this instance via
// installProtocols(opts.reservedZones).
const reservedZones = createReservedZoneRegistry();

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
  pluginBus,
  reservedZones,
  layoutDriverFactory: (target, snapshot) => createLayoutDriver({
    target, snapshot,
    reservedZones,
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

// OutputDescriptor from the GPU process: update state.outputs's seed record
// with real host-derived values, then propagate to every layer that needs to
// know about the output's size or geometry.
//
// Two propagation styles per the design:
//   - INTERNAL system layers are called directly here in known order:
//       compositor.setOutputSize  -> render passes know the new dims
//       addon.updateOutputLayout  -> input backend's pointer-space layout
//                                    (all outputs, with edge-sliding clamp)
//       wm.state.output           -> mutated so subsequent layout snapshots
//                                    pick up the new dims; relayout scheduled
//   - EXTERNAL protocol layers (wl_output + zxdg_output_v1 re-emit to bound
//     client resources) ride bus.emit("output.changed"). Subscribers live in
//     protocols/wl_output.ts and protocols/zxdg_output_manager_v1.ts.
//
// The first descriptor arrives during addon.start() (drained synchronously by
// setOnOutputDescriptor) and sets up state.outputs before any clients have
// bound wl_output, so the re-emit on that first call is a no-op.
addon.setOnOutputDescriptor((d) => {
  const outputs = state.outputs;
  if (!outputs) return;
  // The compositor renders every output's slice of the global logical space.
  // The primary (OUTPUT_DEFAULT) additionally drives the WM/input globals,
  // which still work against a single logical output rect.
  const isPrimary = d.outputId === OUTPUT_DEFAULT;

  // The descriptor reports device pixels (the scanout mode). Scale is core
  // policy: an explicit config value wins, else the EDID-DPI auto fallback
  // (KMS only -- a nested host window's physical dims describe the host
  // monitor, not our render target).
  const device = { width: d.width, height: d.height };
  const scale = resolveScale({
    configScale: config.scale,
    deviceWidth: device.width, deviceHeight: device.height,
    physicalWidthMm: d.physicalWidthMm, physicalHeightMm: d.physicalHeightMm,
    allowEdidAuto: backendOpts.backend === "kms",
  });
  const logical = logicalSize(device.width, device.height, scale);

  let rec = outputs.get(d.outputId);
  let sizeChanged = false;
  if (!rec) {
    // A monitor beyond the primary. Place it with the deterministic fallback
    // (right of the current rightmost output) until user-declared arrangement
    // lands (see multi-output-design §10).
    const pos = nextOutputPosition(outputs.values());
    rec = {
      id: d.outputId,
      logicalPosition: pos,
      logicalSize: logical,
      deviceSize: device,
      scale,
      name: d.name,
      description: d.model || d.name,
      refreshMhz: d.refreshMhz,
      transform: d.transform,
      physicalWidthMm: d.physicalWidthMm,
      physicalHeightMm: d.physicalHeightMm,
      make: d.make,
      model: d.model,
    };
    outputs.set(d.outputId, rec);
    // Advertise a wl_output global for this new connector so clients see it
    // via wl_registry. installProtocols created globals for the outputs
    // present at seed time (OUTPUT_DEFAULT); descriptors that introduce a
    // new outputId need their own global now. The bind handler is closed
    // over the new outputId.
    if (state.events) {
      addon.createGlobalForOutput(
        "wl_output", d.outputId,
        makeWlOutputForOutput({ events: state.events, state, addon }, d.outputId),
      );
    }
    log.info("core",
      `output ${d.outputId} added at (${pos.x},${pos.y}): ${device.width}x${device.height} `
      + `device, ${logical.width}x${logical.height} logical name=${d.name}`);
  } else {
    sizeChanged = rec.logicalSize.width !== logical.width
      || rec.logicalSize.height !== logical.height;
    rec.deviceSize = device;
    rec.logicalSize = logical;
    rec.scale = scale;
    rec.refreshMhz = d.refreshMhz;
    rec.transform = d.transform;
    rec.physicalWidthMm = d.physicalWidthMm;
    rec.physicalHeightMm = d.physicalHeightMm;
    rec.name = d.name;
    rec.make = d.make;
    rec.model = d.model;
    // description stays as set by installProtocols's seed; the descriptor
    // doesn't carry one (xdg-output's description is overdraw-owned policy).
    log.info("core",
      `output ${d.outputId}: ${device.width}x${device.height} device, `
      + `${logical.width}x${logical.height} logical @${d.refreshMhz}mHz scale=${scale} `
      + `xform=${d.transform} phys=${d.physicalWidthMm}x${d.physicalHeightMm}mm name=${d.name}`);
  }

  // Feed the full per-output geometry to the compositor so renderFrame draws
  // each monitor's slice of the global logical space into its own scanout
  // target. Covers ALL outputs (not just the primary); setOutputSize below
  // still drives the primary's render dims (harmless overlap -- setOutputs is
  // the fuller picture).
  if (compositor instanceof JsCompositor && compositor.setOutputs) {
    compositor.setOutputs([...outputs.values()].map((r) => ({
      id: r.id,
      deviceWidth: r.deviceSize.width, deviceHeight: r.deviceSize.height,
      logicalX: r.logicalPosition.x, logicalY: r.logicalPosition.y,
      scale: r.scale,
    })));
  }

  // Push the full multi-output layout to the input backend so the cursor
  // is clamped against the union of every monitor's rect (with edge-sliding
  // for gaps), not just the primary's dims. Covers every output, not just
  // primary -- the cursor must be free to cross output boundaries.
  addon.updateOutputLayout([...outputs.values()].map((r) => ({
    x: r.logicalPosition.x, y: r.logicalPosition.y,
    w: r.logicalSize.width, h: r.logicalSize.height,
  })));

  // Compositor's primary render-target dims still ride setOutputSize on the
  // primary output; setOutputs (above) drives every other output's render
  // slot. (Harmless overlap for the primary.)
  if (isPrimary && compositor instanceof JsCompositor) {
    compositor.setOutputSize(device.width, device.height, scale);
  }

  // WM: feed the full per-output set every time, so a freshly-arrived monitor
  // joins the WM's layout pass without a separate add/remove protocol.
  if (state.wm) {
    state.wm.setOutputs([...outputs.values()].map((r) => ({
      id: r.id,
      rect: {
        x: r.logicalPosition.x, y: r.logicalPosition.y,
        width: r.logicalSize.width, height: r.logicalSize.height,
      },
      scale: r.scale,
    })));
  }
  if (sizeChanged) state.relayout?.("output-resized");

  // Recompute wl_surface.enter/leave for every mapped surface: an output's
  // rect may have shifted, so previously-disjoint surfaces may now overlap
  // (or vice versa). Cheap when nothing crosses a boundary -- the diff
  // emits zero events.
  updateAllSurfaceResidency(state, addon);

  // External: tell clients (via the re-emit subscribers wired below).
  // `name` is the durable identifier the workspace plugin keys preferred-
  // outputs lists on; subscribers building output-aware policy use it.
  pluginBus.emit("output.changed", {
    outputId: d.outputId,
    name: d.name,
    width: logical.width,
    height: logical.height,
    scale,
    refreshMhz: d.refreshMhz,
  });
});

// External re-emit subscribers: protocol layers that need to resend their
// burst to bound client resources whenever the output changes. Each is a
// self-contained re-emit walking its tracked-resources set. Subscribers run
// in registration order; ordering between wl_output and xdg_output doesn't
// matter (different resources, no cross-dependency).
pluginBus.subscribe("output.changed", (_name, payload) => {
  const outputId = (payload as { outputId: number }).outputId;
  reemitWlOutput(state, outputId);
  reemitXdgOutput(state, outputId);
  reemitFractionalScale(state);
});

log.info("core", `Wayland server listening.`);
log.info("core", `run a client with:  WAYLAND_DISPLAY=${sock} <your-client>`);

// The `spawn` action (plugin-core-actions) emits this; the launcher runs the
// actual process detached, with WAYLAND_DISPLAY pointed at our socket so the
// child connects to us. stdio is discarded; the child outlives a compositor
// restart only if it reparents (detached), which is the intent for a launcher.
pluginBus.subscribe("process.spawn-requested", (_name, payload) => {
  const { command, args } = payload as { command?: unknown; args?: unknown };
  if (typeof command !== "string" || command.length === 0) return;
  const argv = Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];
  try {
    spawnProcess(command, argv, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, WAYLAND_DISPLAY: sock },
    }).unref();
  } catch (e) {
    log.warn("core", `spawn failed: ${command}: ${(e as Error).message}`);
  }
});

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

// Scene registry (phase 8): every SceneHandle minted by in-thread or
// Worker compose registers here so transitions (and any future
// cross-SDK consumer) can resolve a sceneId back to a core-side
// GPUTexture. Shared by the gpu-broker (Worker compose paths) and
// the in-thread compose-sdk (via inThreadGpu.sceneRegistry below).
const sceneRegistry = createSceneRegistry();

// GPU broker: services plugin Worker GPU/surface requests.
const gpuBroker = createGpuBroker({
  addon, compositor, overlays, dawn, coreDeviceHandle: h.device,
  sceneRegistry,
  onSurfaceAllocated: (sid, win) => decorationBroker.onSurfaceAllocated(sid, win),
  onSurfacePresented: (sid) => decorationBroker.onSurfacePresented(sid),
});

// Phase 9a closing driver: snapshots a phantom of a closing toplevel
// for the registered 'window-closing' plugin (if any). hasPluginHandler
// reads the runtime's namespace registry; runtime is created below.
// state.closingDriver is the hook unmapAndTeardownSurface calls.
const { createClosingDriver } = await import("./protocols/closing-driver.js");
const closingDriver = createClosingDriver({
  hasPluginHandler: () => runtime?.registry().active("window-closing") !== null
    && runtime?.registry().active("window-closing") !== undefined,
});
state.closingDriver = closingDriver;

// Windows broker: services sdk.windows.set / set-state / get-state / get /
// list / delete-state / set-output-stack. core-plugin-api.md §1.
if (!state.wm) throw new Error("internal: state.wm not set by installProtocols");
const windowsBroker = createWindowsBroker({
  wm: state.wm, compositor, state, pluginBus, bus,
  closingDriver,
});

// Animation evaluator + broker (core-plugin-api.md §9). The evaluator
// ticks once per compositor frame from state.beforeRender (wired below);
// the broker routes plugin animations.run / cancel requests to it.
const evaluator = createEvaluator(compositor);
const animationsBroker = createAnimationsBroker(evaluator);

// Transitions broker (core-plugin-api.md §8). Owns one TransitionEvaluator
// per output with an in-flight transition (allocated lazily); the broker
// ticks them all from beforeRender each frame and exposes anyActive() for
// wakeIfActive. Plugin transitions.run requests route through handle();
// hasOutput validates the outputId at the trust boundary.
const transitionsBroker = createTransitionsBroker({
  compositor, sceneRegistry,
  hasOutput: (outputId) => state.outputs?.has(outputId) ?? false,
});

// Cursor (Phase 9c). Theme resolver + kinematic state + rule engine
// + broker. The resolver caches XCursor file parses; the kinematic
// state machine is lazily enabled by rule registration; the broker
// is the plugin-facing route for cursor.* requests.
const cursorResolver = createCursorThemeResolver(addon);
const cursorKinematics = new Kinematics();
const cursorRuleEngine = new CursorRuleEngine();
const cursorBroker = createCursorBroker({
  addon, compositor, resolver: cursorResolver,
  kinematics: cursorKinematics, ruleEngine: cursorRuleEngine,
  cursorSizePx: Number(process.env.XCURSOR_SIZE) || 24,
});
// Publish the kinematic state so wl_seat can feed it on pointer motion.
state.cursorKinematics = cursorKinematics;

// Grab-cursor hook: the seat calls this on beginGrab/endGrab to install
// the right XCursor theme shape ('move', 'top_left_corner', etc.). On
// grab end (shape=null), we re-apply whichever default the cursor broker
// has set up (typically the boot 'default'). The resolver gracefully
// returns null for unknown shapes so a missing theme entry doesn't
// throw -- the previous cursor stays in place.
state.installGrabCursor = (shape) => {
  const sizePx = Number(process.env.XCURSOR_SIZE) || 24;
  if (shape === null) {
    // Restore the default: re-resolve the boot default. (A future
    // refinement could replay the priority chain to honor a
    // setDefault override; v1 just goes back to 'default'.)
    const r = cursorResolver.resolveShape("default", sizePx, 1);
    if (r) compositor.setCursorPixels?.(r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
    return;
  }
  const r = cursorResolver.resolveShape(shape, sizePx, 1);
  if (r) {
    compositor.setCursorPixels?.(r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
    compositor.setCursorVisible?.(true);
  }
};

// Intercept (Phase 10a). Match engine + per-surface state + broker.
// In-thread bundled plugins register through the broker directly;
// Worker plugins register via the intercept-plugin-broker route which
// drives the cross-device dmabuf machinery shared with the gpu-broker.
// eslint-disable-next-line no-restricted-syntax -- dawn.globals carries arbitrary GPU* entries
const textureUsageBag = (dawn.globals as unknown as { GPUTextureUsage: typeof GPUTextureUsage }).GPUTextureUsage;
const interceptBroker = new InterceptBroker({
  bus,
  compositor,
  inThread: {
    device,
    textureUsage: textureUsageBag,
  },
  worker: {
    addon,
    dawn,
    coreDeviceHandle: h.device,
    textureUsage: textureUsageBag,
    connIdByPlugin: (pluginName) => gpuBroker.connIdForPlugin(pluginName),
    allocCompose: (connId, w, hh, ctId, ctGen, cdId, cdGen, wireSerial) =>
      gpuBroker.allocCompose(connId, w, hh, ctId, ctGen, cdId, cdGen, wireSerial),
    allocSurface: (connId, w, hh, ptId, ptGen, pdId, pdGen, wireSerial) =>
      gpuBroker.allocSurface(connId, w, hh, ptId, ptGen, pdId, pdGen, wireSerial),
  },
  log: (line) => log.info("plugin", line),
});
const interceptPluginBroker = createInterceptPluginBroker({
  interceptBroker,
  // emitToPlugin forwards events to a specific plugin by name. Used
  // for intercept.matched / unmatched notifications.
  emitToPlugin: (pluginName, name, data) => {
    // The broker's notify event data is shape-validated upstream;
    // runtime.emit accepts Json. Forward.
    runtime?.emit(pluginName, name, data as import("./plugins/protocol.js").Json);
  },
});

state.beforeRender = (timeMs: number): void => {
  evaluator.tick(timeMs);
  transitionsBroker.tick(timeMs);
  // Cursor: tick the kinematic state (idle accumulator) and re-evaluate
  // rules. Lazy: kinematics.tick is a no-op while no rule is registered;
  // rule engine evaluate is cheap when no rule is active.
  cursorKinematics.tick(timeMs);
  cursorRuleEngine.evaluate();
  // Intercept: drive plugin render callbacks for every matched
  // surface BEFORE the compositor's renderFrame samples. Lazy: tick
  // is a no-op while no registration is active.
  interceptBroker.tick(timeMs);
};

// Wired late so the forward-declared `wakeIfActive` (used by onFrame near
// the top of this file) can consult these. After each frame's render, if
// any continuous-work subsystem still has work, schedule another frame.
// Idle is the default: no animation, no transition, no intercept = no
// re-wake => no further renders until an external event (client commit,
// input, host wl_surface.frame) wakes again.
wakeIfActive = (): void => {
  const animActive = evaluator.activeCount() > 0;
  const transActive = transitionsBroker.anyActive();
  const interceptActive = interceptBroker.hasActive();
  if (animActive || transActive || interceptActive) addon.wake();
};

// Input broker: services plugin sdk.input.* calls by routing into the
// seat's binding chain. emitToPlugin uses the runtime's per-plugin event
// emit; the runtime is assigned below before any plugin loads.
const inputBroker = createInputBroker({
  state,
  // input-broker passes structured-clone-safe payloads (numeric ids +
  // KeyStep records) but its EmitToPlugin signature is unknown for
  // generality. The runtime's emit asserts Json at its boundary.
  emitToPlugin: (plugin, name, data) => {
    runtime?.emit(plugin, name, data as import("./plugins/protocol.js").Json);
  },
});

// Deferred-reference resolver map (phase 7b). Used by the action
// registry to substitute `ref.X` sentinels in invoke params at
// dispatch time. The map is LIVE -- each function reads core state on
// every action invocation, so resolvers see the current pointer / focus
// / workspace.
//
// Per-output cache of the currently-shown workspace index. Kept in sync via
// the workspace.shown bus event so resolver hot paths don't have to await
// the workspace plugin's async API. activeOutput() picks which entry the
// `currentWorkspace` resolver returns.
const shownWorkspaceByOutput = new Map<number, number>();
pluginBus.subscribe("workspace.shown", (_n, payload) => {
  if (payload && typeof payload === "object") {
    const p = payload as { index?: unknown; outputId?: unknown };
    if (typeof p.index === "number") {
      const outputId = typeof p.outputId === "number" ? p.outputId : OUTPUT_DEFAULT;
      shownWorkspaceByOutput.set(outputId, p.index);
    }
  }
});

// The output the pointer is currently inside, in global logical coordinates.
// Falls back to OUTPUT_DEFAULT when the pointer hasn't landed on any output
// (e.g. before the first pointer event in a GPU-free harness, or in the
// non-rectangular coverage gap between two monitors).
function activeOutputId(): number {
  if (!state || !state.seat || !state.outputs) return OUTPUT_DEFAULT;
  const { x, y } = state.seat.pointerPosition();
  for (const o of state.outputs.values()) {
    const r = o.logicalPosition;
    const s = o.logicalSize;
    if (x >= r.x && x < r.x + s.width && y >= r.y && y < r.y + s.height) {
      return o.id;
    }
  }
  return OUTPUT_DEFAULT;
}

// Interactive grab plumbing: the bundled core-actions plugin's
// window.begin-move / .begin-resize / .end-grab actions emit on the bus;
// here we apply the grab to the seat. The action handlers run in plugin
// context which doesn't have direct seat access, so the bus is the seam.
// Each request transitions the window to 'floating' presentation if
// needed (the grab can only manipulate floating geometry) and then
// installs the grab on the seat.
pluginBus.subscribe("window.grab-requested", async (_n, payload) => {
  if (!state || !state.seat || !state.wm) return;
  if (!payload || typeof payload !== "object") return;
  const p = payload as {
    kind?: unknown; surfaceId?: unknown; edges?: unknown;
  };
  if (p.kind !== "move" && p.kind !== "resize") return;
  if (typeof p.surfaceId !== "number") return;
  const surfaceId = p.surfaceId;

  // Capture the window's current outer (the start rect) BEFORE
  // proposing the floating transition; the propose may schedule a
  // relayout that's a no-op for floating (the rect carries over),
  // but we want a deterministic snapshot.
  const startOuter = state.wm.outerRectOf(surfaceId);
  if (!startOuter) return;

  const ws = state.wm.getWindowState(surfaceId);
  if (ws && ws.presentation !== "floating") {
    await state.wm.propose(surfaceId, { presentation: "floating" }, "user-input");
  }

  const pos = state.seat.pointerPosition();
  if (p.kind === "move") {
    state.seat.beginGrab({
      kind: "move", surfaceId,
      anchorX: pos.x, anchorY: pos.y,
      startRect: startOuter,
    });
  } else {
    const valid: ReadonlyArray<import("./protocols/ctx.js").ResizeEdges> = [
      "top", "bottom", "left", "right",
      "top-left", "top-right", "bottom-left", "bottom-right",
    ];
    const edges = (typeof p.edges === "string"
      && (valid as readonly string[]).includes(p.edges))
      ? (p.edges as import("./protocols/ctx.js").ResizeEdges)
      : "bottom-right";
    state.seat.beginGrab({
      kind: "resize", surfaceId,
      anchorX: pos.x, anchorY: pos.y,
      startRect: startOuter,
      edges,
    });
  }
});

pluginBus.subscribe("window.grab-end-requested", () => {
  state?.seat?.endGrab();
});

// The `window.close` action (plugin-core-actions) emits this; close the
// keyboard-focused toplevel by sending xdg_toplevel.close (the client decides
// how to react). No-op if nothing is focused or the focus isn't a toplevel.
pluginBus.subscribe("window.close-requested", () => {
  const focused = state?.seat?.kbFocus?.surfaceRec?.resource;
  if (!focused || !state?.surfaces || !state.events) return;
  const top = state.surfaces.get(focused)?.xdgSurface?.toplevel;
  if (top && !top.destroyed) state.events.xdg_toplevel.send_close(top);
});

// The focus.next / focus.prev actions emit this; cycle keyboard focus
// through the WM's toplevel stack (wrapping) and apply it directly via the
// seat (an explicit user command, not a focus-plugin policy decision).
pluginBus.subscribe("focus.cycle-requested", (_n, payload) => {
  if (!state?.seat || !state.wm) return;
  const dir = (payload as { direction?: unknown }).direction;
  if (dir !== "next" && dir !== "prev") return;
  const order = state.wm.focusOrder();
  if (order.length === 0) return;
  const cur = state.seat.kbFocus?.surfaceId ?? null;
  const i = cur === null ? -1 : order.indexOf(cur);
  const n = order.length;
  let next: number;
  if (i < 0) {
    next = dir === "next" ? order[0] : order[n - 1];
  } else {
    next = dir === "next" ? order[(i + 1) % n] : order[(i - 1 + n) % n];
  }
  state.seat.applyKeyboardFocus(next);
});

// The layout.promote / swap-next / swap-prev actions emit this; reorder the
// keyboard-focused window in the WM stack (the WM schedules the relayout).
pluginBus.subscribe("layout.reorder-requested", (_n, payload) => {
  if (!state?.seat || !state.wm) return;
  const op = (payload as { op?: unknown }).op;
  if (op !== "promote" && op !== "swap-next" && op !== "swap-prev") return;
  const focused = state.seat.kbFocus?.surfaceId;
  if (typeof focused !== "number") return;
  state.wm.reorder(focused, op);
});

// The layout.grow-master / shrink-master actions emit this; route the
// relative delta to the active layout plugin's setParams and relayout.
// No-op (logged) if the active layout plugin doesn't implement setParams.
pluginBus.subscribe("layout.master-fraction-requested", (_n, payload) => {
  const delta = (payload as { delta?: unknown }).delta;
  if (typeof delta !== "number" || !runtime) return;
  void runtime.invokeNamespace("layout", "setParams", [{ masterFractionDelta: delta }])
    .then(() => { state?.relayout?.("param-changed"); })
    .catch((e: unknown) => {
      log.warn("core", `layout.setParams failed: ${(e as Error).message}`);
    });
});

const { buildResolver } = await import("./plugins/deferred-refs.js");
const deferredRefResolver = buildResolver({
  surfaceUnderPointer: () => state?.seat?.focus?.surfaceId ?? null,
  focusedWindow: () => state?.seat?.kbFocus?.surfaceId ?? null,
  pointerX: () => state?.seat?.pointerPosition().x ?? 0,
  pointerY: () => state?.seat?.pointerPosition().y ?? 0,
  activeOutput: activeOutputId,
  currentWorkspace: () => shownWorkspaceByOutput.get(activeOutputId()) ?? null,
});

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
    sceneRegistry,
    interceptBroker,
    // Same decoration-broker plumbing the GPU broker uses for Worker plugins:
    // notify on alloc (with the `decorates` window id) and on present, so the
    // broker's first-frame gate releases for in-thread decoration plugins too.
    onSurfaceAllocated: (sid, win) => decorationBroker.onSurfaceAllocated(sid, win),
    onSurfacePresented: (sid) => decorationBroker.onSurfacePresented(sid),
  },
  bus: pluginBus,
  resolveDeferredRefs: deferredRefResolver,
  // The runtime ships this to each Worker's bootstrap; in-thread bundled
  // plugins re-read it on every compose-SDK call so a freshly-added monitor
  // is immediately visible.
  liveOutputIds: () => state.outputs ? [...state.outputs.keys()] : [],
  onEvent: (plugin, name, data) => {
    if (name === "log") log.info("plugin", `${plugin}: ${String(data)}`);
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
    if (method.startsWith("input.")) {
      const r = inputBroker(plugin, method, params);
      if (r === INPUT_NOT_HANDLED) {
        throw new Error(`no handler for input method '${method}'`);
      }
      return r;
    }
    if (method.startsWith("transitions.")) {
      const r = transitionsBroker.handle(plugin, method, params);
      if (r === TRANSITIONS_NOT_HANDLED) {
        throw new Error(`no handler for transitions method '${method}'`);
      }
      return r;
    }
    if (method.startsWith("cursor.")) {
      const r = cursorBroker(plugin, method, params);
      if (r === CURSOR_NOT_HANDLED) {
        throw new Error(`no handler for cursor method '${method}'`);
      }
      return r;
    }
    // gpu.* / surface.* / compose.* are the Worker-transport GPU SDK
    // protocol (createPluginGpu in plugins/gpu.ts and createWorkerCompose
    // in plugins/compose-sdk.ts). In-thread plugins skip this entirely --
    // their sdk.gpu / sdk.compose are constructed in-process. Route by
    // prefix rather than as a catch-all so an unknown method surfaces a
    // clear error instead of being mis-dispatched.
    if (method.startsWith("gpu.") || method.startsWith("surface.")
        || method.startsWith("compose.")) {
      return gpuBroker.onRequest(plugin, method, params);
    }
    if (method.startsWith("intercept.")) {
      const r = interceptPluginBroker(plugin, method, params);
      if (r === INTERCEPT_NOT_HANDLED) {
        throw new Error(`no handler for intercept method '${method}'`);
      }
      return r;
    }
    throw new Error(`no handler for plugin request '${method}'`);
  },
});
await runtime.load(resolved);
const summary = runtime.states().map((s) => `${s.name}=${s.state}`).join(", ");
log.info("core", `plugins: ${summary.length > 0 ? summary : "(none)"}`);

// IPC server: JSON-RPC 2.0 over a Unix socket. Plugins register actions and
// emit events; overdrawctl / status bars / scripts connect here.
// core-plugin-api.md §12.
const runtimeDir = process.env.XDG_RUNTIME_DIR;
if (!runtimeDir) {
  log.warn("ipc", "XDG_RUNTIME_DIR not set; IPC server disabled");
} else {
  const socketPath = join(runtimeDir, `overdraw-${sock}.sock`);
  ipcServer = new IpcServer({ socketPath, runtime, bus: pluginBus });
  await ipcServer.start();
  log.info("ipc", `IPC: ${socketPath}`);
}

log.info("core", `ctrl-c to quit.`);

// Per-output frame-callback dispatch. The addon drains one ScanoutFlipComplete
// per call (KMS), so a 60Hz output fires this at 60Hz and a 240Hz output at
// 240Hz independently. dispatchFrameCallbacksForOutput sends wl_callback.done
// only to surfaces overlapping `outputId`, so a client window on the 60Hz
// monitor sees done events at 60Hz even when the 240Hz monitor is also
// flipping. Nested pushes outputId=0 once per host wl_surface.frame done;
// headless synthesizes one per tick of the addon's frame timer. This is the
// ONLY path that fires wl_callback.done -- the per-tick dispatchFrameCallbacks
// runs housekeeping (imports/maps/unmaps, buffer-release, animation tick) but
// no longer dispatches frame callbacks.
addon.setOnFlipComplete?.((outputId) => {
  state?.dispatchFrameCallbacksForOutput?.(Math.round(performance.now()), outputId);
});

// Bootstrap the frame loop. addon.wake() schedules the first render now
// that the JS compositor, protocol layer, and plugin runtime are all live;
// subsequent renders are driven by the wake/flip-complete state machine
// in the addon (KMS: ScanoutFlipComplete; nested: FrameComplete from the
// GPU process's host wl_surface.frame listener). Without this call, an
// idle compositor with no clients would never render its first frame.
addon.wake();
