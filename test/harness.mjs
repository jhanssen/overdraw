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

// Bring up the full compositor. Returns a context with a query() bound to the
// installed protocol state, plus client-spawn + teardown helpers. Spins up the
// PluginRuntime with the bundled plugins (layout + focus); opts.focus and
// opts.layoutParams flow through the bundled-plugin config channel.
//
// opts:
//   focus:         user-config-style { policy, focusOnMap }; flows to the
//                  bundled focus plugin. Defaults to follow-pointer + on-map.
//   layoutParams:  master-stack params (currently the bundled layout plugin
//                  ignores config). Passed through symmetrically for future use.
//   bus:           pre-built DynamicBus (events tests use this to subscribe
//                  before any plugin loads). Defaults to a fresh one.
//   headless:      { width, height } | null. Default { 1280, 720 }; pass null
//                  for nested-host-window mode.
//   jsCompositor:  default true (the JS compositor is the only path now).
export async function setupCompositor(opts = {}) {
  const addon = require(addonPath);

  let state = null;
  const onInput = (ev) => { state?.seat?.handleInput(ev); };
  const onFrame = () => { state?.dispatchFrameCallbacks?.(Math.round(performance.now())); };

  // Headless by default for tests: no host window/surface; the compositing pass
  // renders into an offscreen texture read back via frameReadback. Pass
  // opts.headless = null (or { headless: false }) to use the nested host window.
  const headless = opts.headless === undefined
    ? { width: 1280, height: 720 }
    : opts.headless;
  const dims = addon.start(gpuBin, onFrame, onInput, headless || null);
  const sock = addon.startServer();

  // The JS compositor is the compositor now (the C++ pass is gone). Default to
  // it; opts.jsCompositor === false is no longer supported.
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

  // The plugin bus (shared between runtime + tests that want to observe).
  const pluginBus = opts.bus ?? new DynamicBus();

  // Build the runtime BEFORE installProtocols so the layout/focus driver
  // factories can close over it. The runtime's load() will be called after
  // the protocol layer is up.
  let runtime = null;

  state = await installProtocols(addon, {
    output: { width: dims.width, height: dims.height },
    compositor: jsCompositor ?? undefined,
    bus: opts.bus,
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
    plugins: [],
    sourcePath: null,
  };
  runtime = new PluginRuntime({
    bus: pluginBus,
    log: opts.log ?? (() => {}),
  });
  const resolved = BUNDLED_PLUGINS.map((spec) => bundledToResolved(spec, spec.module, resolvedConfig));
  await runtime.load(resolved);

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
