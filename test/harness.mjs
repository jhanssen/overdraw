// Integration-test harness for overdraw.
//
// Brings up the full stack (GPU process + present loop, Wayland server, protocol
// layer, input routing), spawns real libwayland clients against it, and asserts
// on compositor STATE via the in-process state-query channel (state.query()) --
// geometry / stacking / focus -- not pixels. This mirrors how the reference
// compositors structure integration tests (drive + query state).
//
// Requires a live host Wayland session (WAYLAND_DISPLAY) and the GPU, same as the
// *-upload-smoke tests. Use canRunGpu() to skip gracefully when absent.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, globSync } from "node:fs";

import { installProtocols } from "../dist/protocols/index.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const addonPath = join(repoRoot, "build", "overdraw_native.node");
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(repoRoot, "build", "overdraw-gpu-process");
const clientBin = join(repoRoot, "build", "harness-client");

// Absolute path to a built binary in build/ (for spawnClient({ bin })).
export const buildBin = (name) => join(repoRoot, "build", name);

// True if the environment can run GPU + host-Wayland integration tests.
export function canRunGpu() {
  return !!process.env.WAYLAND_DISPLAY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load the wire-retargeted dawn.node bundled in the extracted Dawn release.
// Returns null if not present (so JS-compositor tests can skip).
export function loadDawn() {
  try {
    const [p] = globSync(join(repoRoot, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
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

// Bring up the full compositor. Returns a context with a query() bound to the
// installed protocol state, plus client-spawn + teardown helpers.
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

  // Optional: run the compositing pass in JS over the wire (dawn.node) instead
  // of the native C++ Compositor. Creates a JsCompositor wrapping the core's wire
  // device and passes it as the compositor backend.
  let jsCompositor = null;
  if (opts.jsCompositor) {
    const dawn = loadDawn();
    if (!dawn) throw new Error("jsCompositor requested but dawn.node not found");
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import("../dist/gpu/compositor.js");
    const nested = !headless;  // nested -> present to the host swapchain (slice 3)
    jsCompositor = new JsCompositor(device, dawn.globals, addon,
      { width: dims.width, height: dims.height }, dawn, h.device,
      { nested, format: addon.outputFormat() });
    // The JS compositor now drives the frame; stop the C++ Compositor rendering.
    addon.setExternalCompositor(true);
  }

  state = await installProtocols(addon, {
    output: { width: dims.width, height: dims.height },
    focus: opts.focus,
    compositor: jsCompositor ?? undefined,
  });

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
    try { addon.stopServer(); } catch { /* ignore */ }
    try { addon.stop(); } catch { /* ignore */ }
    // addon.stop() reaps the GPU process; confirm none leaked (by exact comm).
    await sleep(50);
    const leaked = countGpuProcs();
    if (leaked > 0) throw new Error(`leaked ${leaked} GPU process(es) after teardown`);
  }

  // Async composited-frame readback as a Promise<Uint8Array|null> (BGRA, dims).
  // With the JS compositor, read its offscreen target; else the native one.
  function frameReadback() {
    if (jsCompositor) return jsCompositor.readback().then((r) => r.data);
    return new Promise((resolve) => {
      const started = addon.frameReadback((px) => resolve(px));
      if (!started) resolve(null);
    });
  }

  return {
    addon, state, sock, dims, query: () => state.query(),
    spawnClient, waitFor, frameReadback, teardown, jsCompositor,
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
