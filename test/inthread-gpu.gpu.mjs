// Bundled in-thread plugin renders an overlay on core's GPUDevice via the
// in-thread sdk.gpu (customization.md "Two execution paths, one SDK"). Pixel-
// verifies the composited frame and confirms sdk.gpu.device IS core's device
// (the same JS object, not a separately-wrapped one over a separate wire).
//
// Requires GPU + dawn.node; skips otherwise.

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
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const W = 128, H = 128;

test("in-thread bundled plugin uses core's GPUDevice and composites pixels",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(OD, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  let runtime = null;
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const compositor = new JsCompositor(device, dawn.globals, addon,
      { width: W, height: H }, dawn, h.device);

    let serial = 1000;
    const state = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(state, { width: W, height: H });

    const logs = [];
    runtime = new PluginRuntime({
      // No pluginAddonPath / dawnPath: this test exercises ONLY the in-thread
      // path; a bundled plugin must work without the Worker GPU brokering.
      inThreadGpu: {
        coreDevice: device, globals: dawn.globals, overlays, compositor,
      },
      onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
    });

    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "inthread-overlay.mjs")).href,
      name: "inthread-overlay", restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true, raw: {},
    }]);

    // Wait for the plugin to present.
    const start = Date.now();
    while (!logs.some((l) => l.includes("presented")) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(logs.some((l) => l.includes("presented")),
      `plugin did not present; logs=${JSON.stringify(logs)}`);

    // Same-device proof: the plugin stamped a marker on sdk.gpu.device. The
    // core's `device` (handed to JsCompositor + to the in-thread bundle)
    // should carry the same marker -- they are the same JS object.
    assert.equal(Reflect.get(device, "__overdraw_test_marker"), "inthread",
      "sdk.gpu.device is NOT core's GPUDevice (marker absent)");

    // Pixel verify: render a compositor frame and read it back.
    compositor.renderFrame();
    const { data } = await compositor.readback();
    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    // BGRA readback; plugin cleared to RGBA(0,0.8,0.2) -> bytes B=51,G=204,R=0.
    const [b, gg, r] = px(32, 32);
    assert.ok(gg > 150 && r < 60 && b < 90,
      `overlay pixel wrong: got B=${b} G=${gg} R=${r}`);
    assert.deepEqual(px(100, 100), [0, 0, 0, 255],
      "background still black outside overlay");
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
