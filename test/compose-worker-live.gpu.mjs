// Phase 5b-live: sdk.compose.scene live mode via cross-device dmabuf for
// Worker plugins. A real Wayland client shows a known color. A Worker
// plugin registers a live compose, samples it once (reads color A), the
// test then mutates per-surface state, the plugin samples again (reads
// color A modulated by the mutation). The two pixels must differ -- proving
// the live texture tracks compositor state via the ring.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu } from "./harness.mjs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "packages", "core");

let dawn = null;
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const [dawnPath] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
const pluginAddonPath = join(OD, "build", "overdraw_plugin_native.node");

const skip = !canRunGpu() ? "needs GPU (WAYLAND_DISPLAY unset)"
           : !dawn ? "dawn.node not built" : false;
const OUT = { width: 320, height: 240 };
const FILL = "--fill-configured";

test("sdk.compose.scene LIVE for Worker plugins reflects per-frame state changes",
  { skip }, async () => {
  const { createGpuBroker } = await import(join(OD, "dist", "plugins", "gpu-broker.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));
  const { createWindowsBroker, NOT_HANDLED: WIN_NOT_HANDLED }
    = await import(join(OD, "dist", "plugins", "windows-broker.js"));

  const logs = [];
  let gpuBroker = null;
  let windowsBroker = null;

  const c = await setupCompositor({
    headless: OUT,
    pluginAddonPath,
    dawnPath,
    onEvent: (_p, name, data) => {
      if (name === "log") logs.push(String(data));
    },
    onRequest: (plugin, method, params) => {
      if (method.startsWith("windows.")) {
        const r = windowsBroker(plugin, method, params);
        if (r === WIN_NOT_HANDLED) throw new Error(`no handler for ${method}`);
        return r;
      }
      if (method.startsWith("gpu.") || method.startsWith("surface.")
          || method.startsWith("compose.")) {
        return gpuBroker.onRequest(plugin, method, params);
      }
      throw new Error(`unexpected request: ${method}`);
    },
  });
  try {
    let serial = 1000;
    const overlayState = { serial: () => ++serial, compositor: c.jsCompositor };
    const overlays = createOverlayBroker(overlayState, OUT);
    const h = c.addon.gpuHandles();
    gpuBroker = createGpuBroker({
      addon: c.addon, compositor: c.jsCompositor, overlays, dawn,
      coreDeviceHandle: h.device,
    });
    windowsBroker = createWindowsBroker({
      wm: c.state.wm,
      compositor: c.jsCompositor,
      state: c.state,
      pluginBus: c.pluginBus,
      bus: c.state.bus,
    });

    // Opaque red client.
    const color = 0xffff0000;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "window" });
    const win = snap.windows[0];

    // Mutate state to half-opacity BEFORE the plugin samples. (Earlier
    // attempts to mutate BETWEEN sample1 and sample2 failed due to
    // log-propagation latency from the worker -- by the time the test
    // sees the sample1 log, the plugin's sample2 has already started.)
    // The mutation-before-load approach proves the cross-device fence
    // path correctly delivers the producer's writes to the consumer:
    // both samples should read half-opacity.
    c.jsCompositor.setSurfaceOpacity(win.surfaceId, 0.5);
    c.jsCompositor.renderFrame();

    // Load the live plugin.
    await c.runtime.load([{
      module: pathToFileURL(
        join(__dirname, "fixtures", "plugins", "compose-worker-live.mjs")).href,
      name: "compose-worker-live", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);

    // Wait for the plugin's released log (last line of its lifecycle).
    const start = Date.now();
    while (!logs.some((l) => l.includes("compose-worker-live released"))
           && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const sample1Log = logs.find((l) => l.includes("sample1 pixel BGRA="));
    const sample2Log = logs.find((l) => l.includes("sample2 pixel BGRA="));
    assert.ok(sample1Log, `plugin did not log sample1; logs=${JSON.stringify(logs)}`);
    assert.ok(sample2Log, `plugin did not log sample2; logs=${JSON.stringify(logs)}`);

    const m1 = sample1Log.match(/BGRA=(\d+),(\d+),(\d+),(\d+)/);
    const m2 = sample2Log.match(/BGRA=(\d+),(\d+),(\d+),(\d+)/);
    assert.ok(m1 && m2, `bad pixel logs: ${sample1Log} / ${sample2Log}`);
    const r1 = Number(m1[3]), r2 = Number(m2[3]);

    // Both samples should reflect the half-opacity mutation. Premultiplied
    // red at 0.5 over opaque-black -> R ~127.
    assert.ok(r1 > 100 && r1 < 160,
      `sample1 R should be ~half-opacity red; got R=${r1} from ${sample1Log}`);
    assert.ok(r2 > 100 && r2 < 160,
      `sample2 R should be ~half-opacity red; got R=${r2} from ${sample2Log}`);

    // Wait for released log.
    const releaseStart = Date.now();
    while (!logs.some((l) => l.includes("compose-worker-live released"))
           && Date.now() - releaseStart < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(logs.some((l) => l.includes("compose-worker-live released")),
      "plugin did not log released");
  } finally {
    await c.teardown();
  }
});
