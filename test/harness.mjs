// Integration-test harness for overdraw.
//
// Brings up the full stack (GPU process + present loop, Wayland server, protocol
// layer, plugin runtime with bundled plugins, input routing), spawns real
// libwayland clients against it, and asserts on compositor STATE via the
// in-process state-query channel (state.query()) -- geometry / stacking /
// focus -- not pixels. This mirrors how the reference compositors structure
// integration tests (drive + query state).
//
// Requires a live host Wayland session (WAYLAND_DISPLAY) and the GPU, same as the
// *-upload-smoke tests. Use canRunGpu() to skip gracefully when absent.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, globSync } from "node:fs";

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

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
// Native build outputs live under packages/core/build/ post-monorepo restructure.
const coreRoot = join(__dirname, "..", "packages", "core");

const addonPath = join(coreRoot, "build", "overdraw_native.node");
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(coreRoot, "build", "overdraw-gpu-process");
const clientBin = join(coreRoot, "build", "harness-client");

// Absolute path to a built binary in build/ (for spawnClient({ bin })).
export const buildBin = (name) => join(coreRoot, "build", name);

// True if the environment can run GPU + host-Wayland integration tests.
export function canRunGpu() {
  return !!process.env.WAYLAND_DISPLAY;
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
//   bus       pre-built DynamicBus (for tests that subscribe before plugins
//             load). Defaults to a fresh one.
//   headless  { width, height } | null. Default { 1280, 720 }; pass null
//             for nested-host-window mode.
export async function setupCompositor(opts = {}) {
  const addon = require(addonPath);

  let state = null;
  const onInput = (ev) => { state?.seat?.handleInput(ev); };
  const onFrame = () => { state?.dispatchFrameCallbacks?.(Math.round(performance.now())); };

  // Headless by default: the JS compositor renders into an offscreen target
  // read back via frameReadback(). Pass headless: null to nest to the host.
  const headless = opts.headless === undefined
    ? { width: 1280, height: 720 }
    : opts.headless;
  const dims = addon.start(gpuBin, onFrame, onInput, headless || null);
  const sock = addon.startServer();

  let jsCompositor = null;
  if (opts.jsCompositor !== false) {
    const dawn = loadDawn();
    if (!dawn) throw new Error("jsCompositor requested but dawn.node not found");
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import("../packages/core/dist/gpu/compositor.js");
    const nested = !headless;
    jsCompositor = new JsCompositor(device, dawn.globals, addon,
      { width: dims.width, height: dims.height }, dawn, h.device,
      { nested, format: addon.outputFormat() });
  }

  const pluginBus = opts.bus ?? new DynamicBus();
  // Typed core bus -- producers (the protocol layer + the seat) emit
  // window.* / keyboard.* events. main.ts republishes them onto the plugin
  // (dynamic) bus so sdk.windows.onMap / onUnmap subscriptions see them. The
  // harness mirrors that so plugins running under setupCompositor observe
  // the same lifecycle as in production.
  const coreBus = opts.coreBus ?? createCompositorBus();
  coreBus.on(WINDOW_EVENT.map, (ev) => { pluginBus.emit(WINDOW_EVENT.map, ev); });
  coreBus.on(WINDOW_EVENT.unmap, (ev) => { pluginBus.emit(WINDOW_EVENT.unmap, ev); });
  coreBus.on(WINDOW_EVENT.change, (ev) => { pluginBus.emit(WINDOW_EVENT.change, ev); });

  // The driver factories close over `runtime`, which is built after
  // installProtocols below. waitForNamespace inside compute()/decide()
  // absorbs the boot race.
  let runtime = null;

  state = await installProtocols(addon, {
    output: { width: dims.width, height: dims.height },
    compositor: jsCompositor ?? undefined,
    bus: coreBus,
    pluginBus,
    layoutDriverFactory: (target, snapshot) => createLayoutDriver({
      target, snapshot,
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
    plugins: [],
    sourcePath: null,
  };
  // Wire a windows broker so bundled / fixture plugins can call
  // sdk.windows.*. The test's onRequest is consulted for any method the
  // broker doesn't handle.
  let windowsBroker = null;
  if (state.wm) {
    windowsBroker = createWindowsBroker({
      wm: state.wm,
      compositor: jsCompositor ?? noopSinkForBroker(),
      state, pluginBus, bus: coreBus,
    });
  }
  // The input broker emits 'input.binding-fired' to the originating plugin
  // when a binding matches; runtime.emit is the indirection. `runtime` is
  // assigned below (let-bound in scope at the top of this function).
  const inputBroker = createInputBroker({
    state,
    emitToPlugin: (plugin, name, data) => { runtime?.emit(plugin, name, data); },
  });
  const onRequest = (plugin, method, params) => {
    if (windowsBroker && method.startsWith("windows.")) {
      const r = windowsBroker(plugin, method, params);
      if (r !== WINDOWS_NOT_HANDLED) return r;
    }
    if (method.startsWith("input.")) {
      const r = inputBroker(plugin, method, params);
      if (r !== INPUT_NOT_HANDLED) return r;
    }
    if (opts.onRequest) return opts.onRequest(plugin, method, params);
    throw new Error(`harness: no handler for plugin request '${method}'`);
  };

  runtime = new PluginRuntime({
    bus: pluginBus,
    log: opts.log ?? (() => {}),
    onEvent: opts.onEvent,
    onRequest,
    pluginAddonPath: opts.pluginAddonPath,
    dawnPath: opts.dawnPath,
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
      { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
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
    // Stop the runtime before the addon so plugins quiesce before the server.
    try { await runtime.stop(); } catch { /* ignore */ }
    try { addon.stopServer(); } catch { /* ignore */ }
    try { addon.stop(); } catch { /* ignore */ }
    // addon.stop() reaps the GPU process; confirm none leaked (by exact comm).
    await sleep(50);
    const leaked = countGpuProcs();
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
