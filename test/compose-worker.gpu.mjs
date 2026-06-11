// Phase 5b: sdk.compose.scene snapshot via cross-device dmabuf for Worker
// plugins. Spawns a real Wayland client showing a known color and a Worker
// plugin that calls sdk.compose.scene({mode:'snapshot'}), reads back the
// center pixel on its own device, and logs it. The test verifies the logged
// pixel matches what the client commits.
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

test("sdk.compose.scene snapshot for Worker plugins (cross-device dmabuf)",
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
      // All brokers built lazily once setupCompositor finishes.
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
    // Build the brokers now that c.jsCompositor + c.state exist.
    let serial = 1000;
    const overlayState = { serial: () => ++serial, compositor: c.jsCompositor };
    const overlays = createOverlayBroker(overlayState, OUT);
    const h = c.addon.gpuHandles();
    gpuBroker = createGpuBroker({
      addon: c.addon, compositor: c.jsCompositor, overlays, dawn,
      coreDeviceHandle: h.device,
    });
    // The windows broker connects sdk.windows.* (list/get/setOpacity/etc) to
    // the WM + compositor state in c.state.
    windowsBroker = createWindowsBroker({
      wm: c.state.wm,
      compositor: c.jsCompositor,
      state: c.state,
      pluginBus: c.pluginBus,
      bus: c.state.bus,
    });

    // Spawn a real client with a known color (opaque red).
    const color = 0xffff0000;  // ARGB
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "window" });

    // Load the compose-worker plugin AFTER the client maps so the plugin's
    // window.observe sees the existing window.
    const composeFixture = pathToFileURL(
      join(__dirname, "fixtures", "plugins", "compose-worker.mjs")).href;
    await c.runtime.load([{
      module: composeFixture,
      name: "compose-worker", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);

    // Wait for the plugin to log its center-pixel reading.
    const start = Date.now();
    while (!logs.some((l) => l.includes("center pixel BGRA="))
           && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const pixLog = logs.find((l) => l.includes("center pixel BGRA="));
    assert.ok(pixLog, `plugin did not log a center pixel; logs=${JSON.stringify(logs)}`);

    // Parse the logged BGRA values.
    const m = pixLog.match(/BGRA=(\d+),(\d+),(\d+),(\d+)/);
    assert.ok(m, `could not parse pixel log: ${pixLog}`);
    const [b, g, r, a] = m.slice(1, 5).map(Number);

    // Expected: opaque red (0xffff0000) -> BGRA bytes [0, 0, 255, 255].
    // Some tolerance for any alpha pre-multiplication / blend differences.
    assert.ok(r > 200, `R channel should be high (red); got R=${r} from ${pixLog}`);
    assert.ok(g < 50, `G channel should be low; got G=${g}`);
    assert.ok(b < 50, `B channel should be low; got B=${b}`);
    assert.ok(a > 200, `A channel should be high; got A=${a}`);

    // And verify the released log appears (proves snap.release() resolved).
    const releaseStart = Date.now();
    while (!logs.some((l) => l.includes("compose-worker released"))
           && Date.now() - releaseStart < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(logs.some((l) => l.includes("compose-worker released")),
      "plugin did not log released");
  } finally {
    await c.teardown();
  }
});
