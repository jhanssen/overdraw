// Integration-test harness for overdraw.
//
// Brings up the full stack (GPU process + present loop, Wayland server, protocol
// layer, plugin runtime with bundled plugins, input routing), spawns real
// libwayland clients against it, and asserts on compositor STATE via the
// in-process state-query channel (state.query()) -- geometry / stacking /
// focus -- not pixels. This mirrors how the reference compositors structure
// integration tests (drive + query state).
//
// The default backend is HEADLESS (offscreen render target read back via
// frameReadback()), which needs only a DRM render node + dawn.node -- no host
// Wayland session. Use canRunGpu() to skip gracefully when those are absent.
// Tests that present into a real host window (nested backend) additionally need
// a live host session; they gate on canRunNested().

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, globSync, accessSync, constants as fsConstants } from "node:fs";

import { installProtocols } from "../packages/core/dist/protocols/index.js";
import { createLayoutDriver } from "../packages/core/dist/wm/layout-driver.js";
import { createFocusDriver } from "../packages/core/dist/protocols/focus-driver.js";
import { PluginRuntime } from "../packages/core/dist/plugins/index.js";
import { BUNDLED_PLUGINS, bundledToResolved } from "../packages/core/dist/plugins/bundled.js";
import { DynamicBus } from "../packages/core/dist/events/dynamic-bus.js";
import { createCompositorBus } from "../packages/core/dist/events/window-bus.js";
import { WINDOW_EVENT } from "../packages/core/dist/events/types.js";
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from "../packages/core/dist/plugins/windows-broker.js";
import { createInputBroker, NOT_HANDLED as INPUT_NOT_HANDLED }
  from "../packages/core/dist/plugins/input-broker.js";
import { buildResolver } from "../packages/core/dist/plugins/deferred-refs.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
// Native build outputs live under packages/core/build/ post-monorepo restructure.
const coreRoot = join(__dirname, "..", "packages", "core");

const addonPath = join(coreRoot, "build", "overdraw_native.node");
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(coreRoot, "build", "overdraw-gpu-process");
const clientBin = join(coreRoot, "build", "harness-client");

// Absolute path to a built binary in build/ (for spawnClient({ bin })).
export const buildBin = (name) => join(coreRoot, "build", name);

// True if at least one DRM render node is present and accessible. The headless
// GPU backend (Dawn/Vulkan) renders through a render node; this is the hardware
// half of the headless gate.
function hasRenderNode() {
  let nodes;
  try { nodes = readdirSync("/dev/dri"); } catch { return false; }
  for (const n of nodes) {
    if (!n.startsWith("render")) continue;
    try { accessSync(`/dev/dri/${n}`, fsConstants.R_OK); return true; }
    catch { /* node not accessible */ }
  }
  return false;
}

// True if the environment can run HEADLESS GPU tests: a usable DRM render node
// plus the wire-retargeted dawn.node. No host Wayland session is required --
// setupCompositor defaults to the headless backend. Tests that present into a
// real host window (nested backend) gate on canRunNested() instead.
export function canRunGpu() {
  return hasRenderNode() && loadDawn() !== null;
}

// True if the environment can run NESTED GPU tests: the headless prerequisites
// plus a live host Wayland session to host the nested window.
export function canRunNested() {
  return canRunGpu() && !!process.env.WAYLAND_DISPLAY;
}

// True if at least one DRM connector reports "connected" -- a real panel to
// scan out to. Read-only (/sys); does not open the card or take DRM-master.
function hasConnectedConnector() {
  let cards;
  try { cards = readdirSync("/sys/class/drm"); } catch { return false; }
  for (const c of cards) {
    if (!/^card\d+-/.test(c)) continue;  // connector dirs are cardN-<name>
    try {
      if (readFileSync(`/sys/class/drm/${c}/status`, "utf8").trim() === "connected") return true;
    } catch { /* no status */ }
  }
  return false;
}

// True if the environment can run KMS tests: the headless prerequisites plus a
// connected DRM connector to modeset, and NO active graphical session (a
// running compositor would already hold DRM-master, so the test would fail to
// acquire it rather than skip). Mirrors canRunNested()'s "is the backend
// usable" gate.
//
// CAUTION: a KMS test that passes this gate takes DRM-master and modesets the
// connected panel for real -- it drives the physical display with test frames
// and (since the backend does not restore the prior CRTC on teardown) leaves
// the last frame on screen until a VT switch repaints the console.
export function canRunKms() {
  return canRunGpu()
    && hasConnectedConnector()
    && !process.env.WAYLAND_DISPLAY
    && !process.env.DISPLAY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load the wire-retargeted dawn.node bundled in the extracted Dawn release.
// Returns null if not present (so JS-compositor tests can skip).
export function loadDawn() {
  try {
    const [p] = globSync(join(coreRoot, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
    return p ? require(p) : null;
  } catch { return null; }
}

// Poll `query()` until `pred(snapshot)` is truthy, yielding to the libuv loop so
// the server processes client traffic / frames. Rejects on timeout. Returns the
// snapshot that satisfied the predicate.
export async function waitFor(query, pred, { timeoutMs = 5000, intervalMs = 10, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const snap = query();
    if (pred(snap)) return snap;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitFor timed out (${what}); last snapshot: ${JSON.stringify(snap)}`);
    }
    await sleep(intervalMs);
  }
}

// Poll an arbitrary (possibly async) `producer()` -> value until `pred(value)`
// is truthy. Same shape as waitFor but doesn't assume the value comes from
// state.query(); use this for plugin-side state (action invocations, etc.)
// that race the bus dispatch -> plugin handler -> broker reply chain.
//
// Returns the value that satisfied the predicate. Times out with a
// diagnostic message that includes the last observed value.
export async function settled(producer, pred, { timeoutMs = 5000, intervalMs = 25, what = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    last = await producer();
    if (pred(last)) return last;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`settled timed out (${what}); last value: ${safeStringify(last)}`);
    }
    await sleep(intervalMs);
  }
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Count live GPU processes by EXACT comm (truncated to "overdraw-gpu-pr"), per
// the project's process-management rules -- never pgrep by name.
function countGpuProcs() {
  let n = 0;
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const comm = readFileSync(`/proc/${ent}/comm`, "utf8").trim();
      if (comm === "overdraw-gpu-pr") n++;
    } catch { /* pid vanished */ }
  }
  return n;
}

// PIDs of live GPU processes (exact comm "overdraw-gpu-pr"). Normally one.
export function gpuPids() {
  const pids = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      if (readFileSync(`/proc/${ent}/comm`, "utf8").trim() === "overdraw-gpu-pr") pids.push(Number(ent));
    } catch { /* pid vanished */ }
  }
  return pids;
}

// Open-fd count of a process (for leak detection).
export function fdCount(pid) {
  try { return readdirSync(`/proc/${pid}/fd`).length; } catch { return -1; }
}

// Bring up the full compositor: GPU process, JS compositor, Wayland
// server, protocol layer, plugin runtime with the bundled plugins
// loaded. Returns a context with query(), spawnClient(), teardown(), and
// the runtime + pluginBus handles for tests that want to observe.
//
// opts:
//   focus     user-config-style { policy, focusOnMap }; flows verbatim
//             to the bundled focus plugin's config.
//   bus       The TYPED CORE bus (createCompositorBus); window.* event
//             source the protocol layer + seat emit on. Default: fresh one.
//             The harness republishes window.* from this onto the plugin
//             bus (mirroring main.ts).
//   pluginBus Pre-built DynamicBus the plugin runtime subscribes through.
//             Default: fresh one. Tests that need to observe subscribe to
//             this. (Backwards compat: tests sometimes constructed one
//             locally and passed it in.)
//   headless  { width, height } | null. Default { 1280, 720 }; pass null
//             for nested-host-window mode.
export async function setupCompositor(opts = {}) {
  const addon = require(addonPath);

  let state = null;
  const onInput = (ev) => { state?.seat?.handleInput(ev); };
  const onFrame = () => { state?.dispatchFrameCallbacks?.(Math.round(performance.now())); };
  // Per-output wl_callback.done dispatch (paces clients at their resident
  // output's vblank, not the union of all outputs'). Headless synthesizes
  // this from the ~60Hz frame timer; nested gets one per host FrameComplete.
  const onFlipComplete = (outputId) => {
    state?.dispatchFrameCallbacksForOutput?.(Math.round(performance.now()), outputId);
  };

  // Headless by default: the JS compositor renders into an offscreen target
  // read back via frameReadback(). Pass `headless: null` or `headless: false`
  // to use an output backend (nested by default in tests; `backend: "kms"`
  // opt-in for KMS tests that need to drive real hardware).
  //
  // PRODUCTION defaults to KMS (see packages/core/src/main.ts). TESTS
  // default to nested when an output backend is needed -- KMS tests must
  // opt in explicitly so they don't try to grab the dev/CI machine's
  // display.
  let headless;
  if (opts.headless === undefined) headless = { width: 1280, height: 720 };
  else if (opts.headless && typeof opts.headless === "object") headless = opts.headless;
  else headless = null;  // null or false -> use an output backend
  const startOpts = headless ?? { backend: opts.backend ?? "nested" };
  const dims = addon.start(gpuBin, onFrame, onInput, startOpts);
  addon.setOnFlipComplete?.(onFlipComplete);
  const sock = addon.startServer();

  // The DRM render node the GPU process renders on. Spawned dmabuf clients must
  // allocate on the SAME GPU, else on a multi-GPU box the compositor imports a
  // buffer from the wrong card (cross-GPU import -> ENOMEM). Export it so EVERY
  // spawned client inherits it -- both spawnClient() below and tests that spawn
  // a client binary directly. The GPU process ignores it (it picks its node from
  // its own adapter); only the GBM test clients read it.
  const gpuRenderNode = typeof addon.gpuRenderNode === "function"
    ? addon.gpuRenderNode() : "/dev/dri/renderD128";
  process.env.OVERDRAW_RENDER_NODE = gpuRenderNode;

  let jsCompositor = null;
  let coreDevice = null;
  let dawn = null;
  if (opts.jsCompositor !== false) {
    dawn = loadDawn();
    if (!dawn) throw new Error("jsCompositor requested but dawn.node not found");
    const h = addon.gpuHandles();
    coreDevice = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import("../packages/core/dist/gpu/compositor.js");
    jsCompositor = new JsCompositor(coreDevice, dawn.globals, addon,
      { width: dims.width, height: dims.height }, dawn, h.device,
      { headless: !!headless, format: addon.outputFormat() });
  }

  const pluginBus = opts.pluginBus ?? new DynamicBus();
  // Typed core bus -- producers (the protocol layer + the seat) emit
  // window.* / keyboard.* events. main.ts republishes them onto the plugin
  // (dynamic) bus so sdk.windows.onMap / onUnmap subscriptions see them. The
  // harness mirrors that so plugins running under setupCompositor observe
  // the same lifecycle as in production.
  // (opts.coreBus is an older alias for the same purpose; both accepted.)
  const coreBus = opts.bus ?? opts.coreBus ?? createCompositorBus();
  coreBus.on(WINDOW_EVENT.map, (ev) => { pluginBus.emit(WINDOW_EVENT.map, ev); });
  coreBus.on(WINDOW_EVENT.unmap, (ev) => { pluginBus.emit(WINDOW_EVENT.unmap, ev); });
  coreBus.on(WINDOW_EVENT.change, (ev) => { pluginBus.emit(WINDOW_EVENT.change, ev); });
  coreBus.on(WINDOW_EVENT.closing, (ev) => { pluginBus.emit(WINDOW_EVENT.closing, ev); });

  // The driver factories close over `runtime`, which is built after
  // installProtocols below. waitForNamespace inside compute()/decide()
  // absorbs the boot race.
  let runtime = null;

  // Reserved-zone registry shared with the layout driver. Always
  // constructed in the harness; layer-shell tests rely on it to register
  // exclusive zones and on the WM to honor them via tileRegion.
  const { createReservedZoneRegistry } = await import(
    "../packages/core/dist/wm/reserved-zones.js");
  const reservedZones = createReservedZoneRegistry();

  state = await installProtocols(addon, {
    output: { width: dims.width, height: dims.height },
    compositor: jsCompositor ?? undefined,
    bus: coreBus,
    pluginBus,
    reservedZones,
    layoutDriverFactory: (target, snapshot) => createLayoutDriver({
      target, snapshot,
      reservedZones,
      compute: async (inputs) => {
        if (!runtime) throw new Error("layout: runtime not initialized");
        await runtime.waitForNamespace("layout");
        return await runtime.invokeNamespace("layout", "compute", [inputs]);
      },
    }),
    focusDriverFactory: (target) => createFocusDriver({
      target,
      decide: async (inputs) => {
        if (!runtime) throw new Error("focus: runtime not initialized");
        await runtime.waitForNamespace("focus");
        return await runtime.invokeNamespace("focus", "decide", [inputs]);
      },
    }),
  });

  // Spin up the runtime + load the bundled plugins. The user-config-style
  // focus and layoutParams flow through bundledToResolved's third arg, which
  // each plugin spec extracts via its configFrom.
  const resolvedConfig = {
    output: null,
    focus: opts.focus,
    hotkeys: opts.hotkeys,
    actions: opts.actions,
    plugins: [],
    sourcePath: null,
  };
  // Phase 9a closing driver: snapshots a phantom of a closing toplevel
  // when a 'window-closing' plugin is registered. hasPluginHandler reads
  // the runtime's namespace registry (assigned below). state.closingDriver
  // is the hook unmapAndTeardownSurface calls.
  let closingDriver = null;
  if (opts.closingAnimations) {
    const { createClosingDriver } = await import(
      "../packages/core/dist/protocols/closing-driver.js");
    closingDriver = createClosingDriver({
      hasPluginHandler: () => runtime?.registry?.()?.active("window-closing") != null,
      backstopMs: opts.closingBackstopMs,  // tests can override default 10s
    });
    state.closingDriver = closingDriver;
  }

  // Wire a windows broker so bundled / fixture plugins can call
  // sdk.windows.*. The test's onRequest is consulted for any method the
  // broker doesn't handle.
  let windowsBroker = null;
  if (state.wm) {
    windowsBroker = createWindowsBroker({
      wm: state.wm,
      compositor: jsCompositor ?? noopSinkForBroker(),
      state, pluginBus, bus: coreBus,
      closingDriver: closingDriver ?? undefined,
    });
  }
  // The input broker emits 'input.binding-fired' to the originating plugin
  // when a binding matches; runtime.emit is the indirection. `runtime` is
  // assigned below (let-bound in scope at the top of this function).
  const inputBroker = createInputBroker({
    state,
    emitToPlugin: (plugin, name, data) => { runtime?.emit(plugin, name, data); },
  });
  // Optional transitions broker. Tests that exercise sdk.transitions set
  // opts.transitions = true; the harness brings up the scene registry +
  // broker (the broker owns its per-output evaluators internally) and
  // wires broker.tick into beforeRender so the renderFrame loop drives
  // every in-flight transition.
  let sceneRegistry = null;
  let transitionsBroker = null;
  let TRANSITIONS_NOT_HANDLED = null;
  if (opts.transitions && jsCompositor) {
    const { createSceneRegistry } = await import(
      "../packages/core/dist/plugins/scene-registry.js");
    const tx = await import(
      "../packages/core/dist/plugins/transitions-broker.js");
    sceneRegistry = createSceneRegistry();
    transitionsBroker = tx.createTransitionsBroker({
      compositor: jsCompositor,
      sceneRegistry,
      hasOutput: (outputId) => state.outputs?.has(outputId) ?? false,
    });
    TRANSITIONS_NOT_HANDLED = tx.NOT_HANDLED;
    const priorBefore = state.beforeRender;
    state.beforeRender = (timeMs) => {
      priorBefore?.(timeMs);
      transitionsBroker.tick(timeMs);
    };
  }

  // Optional animations broker (sdk.animations.run / cancel). Same shape
  // as the transitions wiring: opts.animations = true brings it up.
  // Closing-animation tests need this because the bundled closing plugin
  // animates the phantom's opacity via sdk.animations.run.
  let animationsBroker = null;
  let ANIM_NOT_HANDLED = null;
  if (opts.animations && jsCompositor) {
    const { createEvaluator } = await import(
      "../packages/core/dist/animations/evaluator.js");
    const ab = await import(
      "../packages/core/dist/plugins/animations-broker.js");
    const animEvaluator = createEvaluator(jsCompositor);
    animationsBroker = ab.createAnimationsBroker(animEvaluator);
    ANIM_NOT_HANDLED = ab.NOT_HANDLED;
    const priorBefore = state.beforeRender;
    state.beforeRender = (timeMs) => {
      priorBefore?.(timeMs);
      animEvaluator.tick(timeMs);
    };
  }

  // Optional cursor broker (sdk.cursor + the rule engine). opts.cursor =
  // true brings it up. Mirrors main.ts: kinematic state machine + rule
  // engine + broker; the kinematic state is published on state so the
  // seat feeds it on pointer motion.
  let cursorBroker = null;
  let CURSOR_NOT_HANDLED = null;
  if (opts.cursor && jsCompositor) {
    const { createCursorThemeResolver } = await import(
      "../packages/core/dist/cursor/theme-resolver.js");
    const { Kinematics } = await import(
      "../packages/core/dist/cursor/kinematics.js");
    const { CursorRuleEngine } = await import(
      "../packages/core/dist/cursor/rule-engine.js");
    const cb = await import("../packages/core/dist/plugins/cursor-broker.js");
    const resolver = createCursorThemeResolver(addon);
    const kine = new Kinematics();
    const eng = new CursorRuleEngine();
    cursorBroker = cb.createCursorBroker({
      addon, compositor: jsCompositor, resolver,
      kinematics: kine, ruleEngine: eng,
      cursorSizePx: Number(process.env.XCURSOR_SIZE) || 24,
    });
    CURSOR_NOT_HANDLED = cb.CURSOR_NOT_HANDLED;
    state.cursorKinematics = kine;
    const priorBefore = state.beforeRender;
    state.beforeRender = (timeMs) => {
      priorBefore?.(timeMs);
      kine.tick(timeMs);
      eng.evaluate();
    };
    // Install the boot default so the cursor slot is non-empty when
    // tests don't explicitly setShape. Tests that want NO default cursor
    // should opt out before any motion is injected.
    const r = resolver.resolveShape("default", Number(process.env.XCURSOR_SIZE) || 24, 1);
    if (r) {
      jsCompositor.setCursorPixels(r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
      jsCompositor.setCursorVisible(true);
    }
  }

  const onRequest = (plugin, method, params) => {
    if (windowsBroker && method.startsWith("windows.")) {
      const r = windowsBroker(plugin, method, params);
      if (r !== WINDOWS_NOT_HANDLED) return r;
    }
    if (method.startsWith("input.")) {
      const r = inputBroker(plugin, method, params);
      if (r !== INPUT_NOT_HANDLED) return r;
    }
    if (transitionsBroker && method.startsWith("transitions.")) {
      const r = transitionsBroker.handle(plugin, method, params);
      if (r !== TRANSITIONS_NOT_HANDLED) return r;
    }
    if (animationsBroker && method.startsWith("animations.")) {
      const r = animationsBroker(plugin, method, params);
      if (r !== ANIM_NOT_HANDLED) return r;
    }
    if (cursorBroker && method.startsWith("cursor.")) {
      const r = cursorBroker(plugin, method, params);
      if (r !== CURSOR_NOT_HANDLED) return r;
    }
    if (state.__interceptPluginBroker && method.startsWith("intercept.")) {
      const r = state.__interceptPluginBroker(plugin, method, params);
      if (r !== state.__interceptNotHandled) return r;
    }
    if (state.__workerGpuBroker && (method.startsWith("gpu.")
        || method.startsWith("surface.") || method.startsWith("compose."))) {
      return state.__workerGpuBroker.onRequest(plugin, method, params);
    }
    if (opts.onRequest) return opts.onRequest(plugin, method, params);
    throw new Error(`harness: no handler for plugin request '${method}'`);
  };

  // Deferred-reference resolver: same wiring main.ts does, populated from
  // the test's state.seat (pointer + focus). currentWorkspace is cached via
  // workspace.shown emits (workspace plugin loads as part of bundled set).
  let currentWorkspaceIndex = null;
  pluginBus.subscribe("workspace.shown", (_n, payload) => {
    if (payload && typeof payload === "object" && typeof payload.index === "number"
        && (payload.outputId === undefined || payload.outputId === 0)) {
      currentWorkspaceIndex = payload.index;
    }
  });
  const deferredRefResolver = buildResolver({
    surfaceUnderPointer: () => state?.seat?.focus?.surfaceId ?? null,
    focusedWindow: () => state?.seat?.kbFocus?.surfaceId ?? null,
    pointerX: () => state?.seat?.pointerPosition?.().x ?? 0,
    pointerY: () => state?.seat?.pointerPosition?.().y ?? 0,
    activeOutput: () => 0,
    currentWorkspace: () => currentWorkspaceIndex,
  });

  // When transitions / intercept / etc. ask for it, bring up the
  // InThreadGpuDeps bundle: bundled plugins get sdk.compose + sdk.gpu
  // wired in-thread, sharing the harness's core device. Otherwise the
  // runtime falls back to Worker GPU iff opts.pluginAddonPath /
  // opts.dawnPath were provided.
  let inThreadGpuDeps;
  let interceptBroker = null;
  const needInThreadGpu = (opts.transitions || opts.intercept) && jsCompositor && coreDevice && dawn;
  if (needInThreadGpu) {
    const { createOverlayBroker } = await import(
      "../packages/core/dist/overlay.js");
    let _serial = 5000;
    const overlayState = { serial: () => ++_serial, compositor: jsCompositor };
    const overlays = createOverlayBroker(overlayState, dims);
    inThreadGpuDeps = {
      coreDevice,
      globals: dawn.globals,
      overlays,
      compositor: jsCompositor,
      sceneRegistry,
    };
    if (opts.intercept) {
      const { InterceptBroker } = await import(
        "../packages/core/dist/intercept/broker.js");
      // Worker-transport wiring requires a gpu-broker (for connId
      // lookup + alloc helpers). Build one lazily if the test passes
      // pluginAddonPath / dawnPath; otherwise leave the worker leg
      // unwired (in-thread tests only).
      const interceptBrokerOpts = {
        bus: coreBus,
        compositor: jsCompositor,
        inThread: {
          device: coreDevice,
          textureUsage: dawn.globals.GPUTextureUsage,
        },
        log: opts.log ?? (() => {}),
      };
      let workerGpuBroker = null;
      if (opts.pluginAddonPath && opts.dawnPath) {
        const { createGpuBroker } = await import(
          "../packages/core/dist/plugins/gpu-broker.js");
        const { createOverlayBroker } = await import(
          "../packages/core/dist/overlay.js");
        let _s = 6000;
        const overlayState = { serial: () => ++_s, compositor: jsCompositor };
        const overlays2 = createOverlayBroker(overlayState, dims);
        const h2 = addon.gpuHandles();
        workerGpuBroker = createGpuBroker({
          addon, compositor: jsCompositor, overlays: overlays2, dawn,
          coreDeviceHandle: h2.device,
          sceneRegistry,
        });
        interceptBrokerOpts.worker = {
          addon, dawn,
          coreDeviceHandle: h2.device,
          textureUsage: dawn.globals.GPUTextureUsage,
          connIdByPlugin: (pluginName) => workerGpuBroker.connIdForPlugin(pluginName),
          allocCompose: (...args) => workerGpuBroker.allocCompose(...args),
          allocSurface: (...args) => workerGpuBroker.allocSurface(...args),
        };
      }
      interceptBroker = new InterceptBroker(interceptBrokerOpts);
      inThreadGpuDeps.interceptBroker = interceptBroker;
      // Tick the broker from beforeRender so the per-frame render
      // dispatch happens BEFORE renderFrame samples.
      const prior = state.beforeRender;
      state.beforeRender = (timeMs) => {
        prior?.(timeMs);
        interceptBroker.tick(timeMs);
      };
      // Expose the worker gpu-broker + plugin-broker for the test's
      // onRequest chain.
      if (workerGpuBroker) {
        const { createInterceptPluginBroker, INTERCEPT_NOT_HANDLED }
          = await import(
            "../packages/core/dist/plugins/intercept-plugin-broker.js");
        const interceptPluginBroker = createInterceptPluginBroker({
          interceptBroker,
          emitToPlugin: (pluginName, name, data) => {
            runtime?.emit(pluginName, name, data);
          },
        });
        // Stash on the returned context so the test's onRequest
        // routing layer can reach them.
        state.__interceptPluginBroker = interceptPluginBroker;
        state.__interceptNotHandled = INTERCEPT_NOT_HANDLED;
        state.__workerGpuBroker = workerGpuBroker;
      }
    }
  }

  runtime = new PluginRuntime({
    bus: pluginBus,
    log: opts.log ?? (() => {}),
    onEvent: opts.onEvent,
    onRequest,
    resolveDeferredRefs: deferredRefResolver,
    pluginAddonPath: opts.pluginAddonPath,
    dawnPath: opts.dawnPath,
    inThreadGpu: inThreadGpuDeps,
  });
  const resolved = BUNDLED_PLUGINS.map((spec) => bundledToResolved(spec, spec.module, resolvedConfig));
  // Optional extra plugins (ResolvedPlugin shape) from the test. Loaded
  // alongside the bundled set so interception tests can drop in a fixture.
  const extra = opts.plugins ?? [];
  await runtime.load([...resolved, ...extra]);

  const clients = [];

  // Spawn a client binary. Resolves once it prints its "mapped" line (so the
  // surface exists on the wire); the caller then waitFor()s the window to appear
  // in query(). The returned handle accumulates stdout + offers waitForLine().
  // Defaults to the standard harness-client; pass { bin, readyMarker } to run
  // another client (e.g. subsurface-test-client).
  function spawnClient(args = [], { bin = clientBin, readyMarker = "] mapped", stdin = false } = {}) {
    const child = spawn(bin, ["--socket", sock, ...args],
      { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        env: { ...process.env, OVERDRAW_RENDER_NODE: gpuRenderNode } });
    clients.push(child);
    const handle = {
      child, stdout: "", ready: null,
      // Write a line to the client's stdin (for --step clients).
      send: (line) => { child.stdin?.write(line.endsWith("\n") ? line : line + "\n"); },
    };
    handle.ready = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("client did not map in time")), 5000);
      child.stdout.on("data", (d) => {
        handle.stdout += d.toString();
        if (handle.stdout.includes(readyMarker)) { clearTimeout(to); resolve(child); }
      });
      child.on("exit", (code) => { clearTimeout(to); if (code) reject(new Error(`client exited ${code}`)); });
    });
    // Wait until the client's stdout matches `re` (RegExp) or substring. Yields
    // to libuv so the server keeps processing while we wait.
    handle.waitForLine = async (re, { timeoutMs = 4000, what = "client line" } = {}) => {
      const test = (s) => (re instanceof RegExp ? re.test(s) : s.includes(re));
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (test(handle.stdout)) return handle.stdout;
        await sleep(10);
      }
      throw new Error(`waitForLine timed out (${what}); stdout:\n${handle.stdout}`);
    };
    return handle;
  }

  async function teardown() {
    for (const c of clients) { try { c.kill("SIGTERM"); } catch { /* already gone */ } }
    // Give clients a beat to disconnect cleanly, servicing the loop.
    await sleep(50);
    // Shutdown intercept broker BEFORE runtime.stop: destroys per-
    // surface state synchronously (releases dmabuf rings + clears
    // compositor bindings) so no Worker wire ops are pending when
    // addon.stop tears down the Dawn wire link. After shutdown
    // there will be afterCurrentFrame callbacks queued (the
    // SurfaceConsumer's End-then-free path schedules them); drive
    // one more renderFrame + await its GPU completion so they fire
    // and clear the wire's pending tracked-event queue before the
    // wire link teardown happens.
    try { interceptBroker?.shutdown(); } catch { /* ignore */ }
    if (jsCompositor && coreDevice) {
      try {
        jsCompositor.renderFrame();
        // Race onSubmittedWorkDone against a 200ms timeout: the
        // worker's wire is still alive at this point but is being
        // torn down imminently; if onSubmittedWorkDone hangs (no
        // submit was pending), the timeout lets us continue.
        await Promise.race([
          coreDevice.queue.onSubmittedWorkDone(),
          sleep(200),
        ]);
      } catch { /* ignore */ }
    }
    // Stop the runtime before the addon so plugins quiesce before the server.
    try { await runtime.stop(); } catch { /* ignore */ }
    // After runtime.stop the Worker is terminated; pending Worker-
    // side callbacks against the core's wire may still be in flight.
    // Give the libuv loop a few cycles to dispatch them before the
    // wire teardown.
    try {
      await sleep(20);
      if (jsCompositor && coreDevice) {
        jsCompositor.renderFrame();
        await Promise.race([
          coreDevice.queue.onSubmittedWorkDone(),
          sleep(100),
        ]);
      }
    } catch { /* ignore */ }
    try { addon.stopServer(); } catch { /* ignore */ }
    try { addon.stop(); } catch { /* ignore */ }
    // addon.stop() reaps the GPU process and closes the addon's libuv handles
    // (server + client poll handles, GPU pipe). Those close callbacks run on a
    // later loop iteration, so the loop MUST be yielded to at least once before
    // this returns -- a subsequent setupCompositor()/addon.start() in the same
    // process otherwise races the pending closes and libuv aborts on a half-
    // closed handle. The do/while guarantees that first yield. Past it, keep
    // polling: the GPU reap is asynchronous and can exceed 50ms on some drivers
    // (NVIDIA teardown is slow), so wait until the child is gone rather than
    // guessing a fixed delay.
    const reapDeadline = Date.now() + 3000;
    let leaked;
    do {
      await sleep(20);
      leaked = countGpuProcs();
    } while (leaked > 0 && Date.now() < reapDeadline);
    if (leaked > 0) throw new Error(`leaked ${leaked} GPU process(es) after teardown`);
  }

  // Async composited-frame readback as a Promise<Uint8Array|null> (BGRA, dims).
  // Reads the JS compositor's offscreen target (headless only).
  function frameReadback() {
    return jsCompositor.readback().then((r) => r.data);
  }

  return {
    addon, state, sock, dims, query: () => state.query(),
    spawnClient, waitFor, frameReadback, teardown, jsCompositor,
    coreDevice, dawn,
    runtime, pluginBus,
  };
}

// Fallback compositor sink the windows broker uses when jsCompositor wasn't
// brought up (e.g. tests passing jsCompositor: false). The broker's compositor
// arg is only invoked for setOutputStack / setSurface* etc. -- methods this
// stub provides as no-ops so the broker can route without crashing.
function noopSinkForBroker() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
    setSurfaceOpacity() {}, setSurfaceTransform() {}, setSurfaceOutputMargin() {},
    setSurfaceMask() {}, setSurfaceTint() {}, setSurfaceColorMatrix() {},
  };
}

// Sample one BGRA pixel from a readback buffer (width W). Returns [b,g,r,a].
export function pixelAt(px, W, x, y) {
  const o = (y * W + x) * 4;
  return [px[o], px[o + 1], px[o + 2], px[o + 3]];
}

// True if two BGRA pixels match within an absolute per-channel tolerance.
export function pixelMatches(a, b, tol = 2) {
  for (let i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
  return true;
}

// Convenience input injectors (output-space coords). These use injectInput,
// which enters at the normalized InputEvent sink (skips backend normalization).
export function pointerMotion(addon, x, y, time = 0) {
  addon.injectInput({ type: "pointerMotion", x, y, time });
  addon.injectInput({ type: "pointerFrame", time });
}
export function pointerButton(addon, button, pressed, { serial = 1, time = 0 } = {}) {
  addon.injectInput({ type: "pointerButton", button, pressed, serial, time });
  addon.injectInput({ type: "pointerFrame", time });
}

// Host-path injectors: route through the REAL WaylandInputBackend normalization
// (fixed-point <-> logical, evdev codes) -- the layer the injectInput variants
// skip. Used to cover the path the manual input-smoke test exercised.
export function pointerMotionHost(addon, x, y, time = 0) {
  addon.injectHostInput({ type: "pointerMotion", x, y, time });
  addon.injectHostInput({ type: "pointerFrame", time });
}
export function pointerButtonHost(addon, button, pressed, { serial = 1, time = 0 } = {}) {
  addon.injectHostInput({ type: "pointerButton", button, pressed, serial, time });
  addon.injectHostInput({ type: "pointerFrame", time });
}
export function keyHost(addon, key, pressed, { serial = 1, time = 0 } = {}) {
  addon.injectHostInput({ type: "keyboardKey", key, pressed, serial, time });
}
