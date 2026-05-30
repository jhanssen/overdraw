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
import { readdirSync, readFileSync } from "node:fs";

import { installProtocols } from "../dist/protocols/index.js";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const addonPath = join(repoRoot, "build", "overdraw_native.node");
const gpuBin = process.env.OVERDRAW_GPU_PROCESS ?? join(repoRoot, "build", "overdraw-gpu-process");
const clientBin = join(repoRoot, "build", "harness-client");

// True if the environment can run GPU + host-Wayland integration tests.
export function canRunGpu() {
  return !!process.env.WAYLAND_DISPLAY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const dims = addon.start(gpuBin, onFrame, onInput);
  const sock = addon.startServer();
  state = await installProtocols(addon, {
    output: { width: dims.width, height: dims.height },
    focus: opts.focus,
  });

  const clients = [];

  // Spawn a harness-client. Resolves once the client prints its "mapped" line
  // (so the surface exists on the wire); the caller then waitFor()s the window
  // to appear in query() (map happens on the server's next commit processing).
  function spawnClient(args = []) {
    const child = spawn(clientBin, ["--socket", sock, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    clients.push(child);
    const ready = new Promise((resolve, reject) => {
      let buf = "";
      const to = setTimeout(() => reject(new Error("client did not map in time")), 5000);
      child.stdout.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("[harness-client] mapped")) { clearTimeout(to); resolve(child); }
      });
      child.on("exit", (code) => { clearTimeout(to); if (code) reject(new Error(`client exited ${code}`)); });
    });
    return { child, ready };
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

  return { addon, state, sock, dims, query: () => state.query(), spawnClient, waitFor, teardown };
}

// Convenience input injectors (output-space coords).
export function pointerMotion(addon, x, y, time = 0) {
  addon.injectInput({ type: "pointerMotion", x, y, time });
  addon.injectInput({ type: "pointerFrame", time });
}
export function pointerButton(addon, button, pressed, { serial = 1, time = 0 } = {}) {
  addon.injectInput({ type: "pointerButton", button, pressed, serial, time });
  addon.injectInput({ type: "pointerFrame", time });
}
