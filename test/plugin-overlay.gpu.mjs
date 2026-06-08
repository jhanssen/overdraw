// C-M4 step 4d/5 (the milestone): a real plugin Worker creates an overlay,
// renders into it on its own device, and the core composites it on top of the
// scene at the core-decided rect -- pixel-verified end to end. Exercises the
// whole plugin GPU stack: Worker-owned wire client + device, cross-process shared
// surface, per-frame fence, overlay broker geometry/layer, JS compositor.
//
// Requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "packages", "core");
const addon = require(join(OD, "build", "overdraw_native.node"));
let dawn = null;
try { const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node")); if (p) dawn = require(p); } catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const W = 128, H = 128;

test("plugin overlay composites on top, pixel-verified", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(OD, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));
  const { createGpuBroker } = await import(join(OD, "dist", "plugins", "gpu-broker.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  let runtime = null;
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const compositor = new JsCompositor(device, dawn.globals, addon, { width: W, height: H }, dawn, h.device);

    // Minimal compositor state for the overlay broker (it needs serial() + the sink).
    let serial = 1000;
    const state = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(state, { width: W, height: H });
    const [dawnNodePath] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
    const gpuBroker = createGpuBroker({ addon, compositor, overlays, dawn, coreDeviceHandle: h.device });

    const logs = [];
    runtime = new PluginRuntime({
      pluginAddonPath: join(OD, "build", "overdraw_plugin_native.node"),
      dawnPath: dawnNodePath,
      onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
      onRequest: (p, m, params) => gpuBroker(p, m, params),
    });

    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "overlay.mjs")).href,
      name: "overlay", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);

    // The plugin presents during init; wait for its "presented" log.
    const start = Date.now();
    while (!logs.some((l) => l.includes("presented")) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(logs.some((l) => l.includes("presented")), `plugin did not present; logs=${JSON.stringify(logs)}`);

    // Render a compositor frame and read it back. The overlay (green) is at the
    // top-left 64x64; the rest is the black clear.
    compositor.renderFrame();
    const { data } = await compositor.readback();
    const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
    // BGRA readback; plugin cleared RGBA(0,0.8,0.2) -> bytes B=51,G=204,R=0.
    const [b, gg, r] = px(32, 32);
    assert.ok(gg > 150 && r < 60 && b < 90, `overlay pixel wrong: got B=${b} G=${gg} R=${r}`);
    assert.deepEqual(px(100, 100), [0, 0, 0, 255], "background still black outside overlay");
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
