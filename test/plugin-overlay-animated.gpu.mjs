// C-M4 (completing the milestone honestly): an ANIMATED plugin overlay. The
// plugin renders a sequence of distinct colors and presents each on its own clock
// (it knows nothing about the ring/fences). The double-buffered producer/consumer
// ring must let the composited output actually CHANGE across frames -- proving
// it's not a static single-buffer hold. The test OBSERVES: it composites + reads
// back repeatedly and asserts it sees multiple distinct expected colors at the
// overlay rect.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Classify an overlay pixel (BGRA bytes) to one of the expected colors, or null.
function classify(b, g, r) {
  if (g > 150 && r < 70 && b < 90) return "green";   // RGBA(0,0.8,0.2)
  if (r > 150 && g < 70 && b < 50) return "red";     // RGBA(0.8,0.2,0)
  if (b > 150 && r < 70 && g < 70) return "blue";    // RGBA(0.2,0.2,0.8)
  return null;
}

test("animated plugin overlay: composited output changes across frames", { skip: !dawn ? "dawn.node not built" : false }, async () => {
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
    let serial = 2000;
    const state = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(state, { width: W, height: H });
    const gpuBroker = createGpuBroker({ addon, compositor, overlays, dawn, coreDeviceHandle: h.device });

    runtime = new PluginRuntime({
      pluginAddonPath: join(OD, "build", "overdraw_plugin_native.node"),
      dawnPath: globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"))[0],
      onEvent: () => {},
      onRequest: (p, m, params) => gpuBroker(p, m, params),
    });
    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "overlay-animated.mjs")).href,
      name: "anim", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);

    // Observe: composite + read back the overlay pixel repeatedly while the plugin
    // animates. Collect the distinct expected colors seen at the overlay rect.
    const seen = new Set();
    const start = Date.now();
    while (Date.now() - start < 4000 && seen.size < 3) {
      compositor.renderFrame();
      const { data } = await compositor.readback();
      const i = (32 * W + 32) * 4;  // inside the top-left 64x64 overlay
      const c = classify(data[i], data[i + 1], data[i + 2]);
      if (c) seen.add(c);
      await sleep(40);
    }

    // Animation proven if the composited output showed MULTIPLE distinct colors
    // over time (a static single-buffer hold would only ever show one).
    assert.ok(seen.size >= 2,
      `expected the overlay to change across frames; saw colors: ${[...seen].join(",") || "(none)"}`);
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
