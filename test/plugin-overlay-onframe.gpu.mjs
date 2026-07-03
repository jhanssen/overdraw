// surface.onFrame end-to-end: a Worker plugin overlay animated PURELY by
// frame ticks (no plugin-side timers). The rig owns the tick source: each
// observer iteration runs idleTick (the idle force-present gate), composites,
// then dispatches a flip-complete for output 0 -- exactly main.ts's wiring
// shape. The composited output must advance through multiple distinct colors,
// proving the full loop: requestFrame -> arm -> flip dispatch -> postMessage
// tick -> plugin render + present -> next frame.
//
// Requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";
import { loadAddon, loadDawn, gpuBin, coreRoot, buildBin } from "./harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Classify an overlay pixel (BGRA bytes) to one of the expected colors, or null.
function classify(b, g, r) {
  if (g > 150 && r < 70 && b < 90) return "green";   // RGBA(0,0.8,0.2)
  if (r > 150 && g < 70 && b < 50) return "red";     // RGBA(0.8,0.2,0)
  if (b > 150 && r < 70 && g < 70) return "blue";    // RGBA(0.2,0.2,0.8)
  return null;
}

test("surface.onFrame paces a worker overlay through flip-complete ticks", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(coreRoot, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(coreRoot, "dist", "overlay.js"));
  const { createGpuBroker } = await import(join(coreRoot, "dist", "plugins", "gpu-broker.js"));
  const { createOverlayFrameTicks } = await import(join(coreRoot, "dist", "plugins", "frame-ticks.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  let runtime = null;
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const compositor = new JsCompositor(device, dawn.globals, addon, { width: W, height: H }, dawn, h.device);
    let serial = 2000;
    const state = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(state, { width: W, height: H });
    const awaitingFlip = new Set();
    const frameTicks = createOverlayFrameTicks({
      compositor,
      awaitingFlip: () => awaitingFlip,
      outputIds: () => [0],
    });
    const gpuBroker = createGpuBroker({
      addon, compositor, overlays, dawn, coreDeviceHandle: h.device,
      frameTicks,
      emitToPlugin: (plugin, name, data) => { runtime?.emit(plugin, name, data); },
    });

    runtime = new PluginRuntime({
      pluginAddonPath: buildBin("overdraw_plugin_native.node"),
      dawnPath: globSync(join(coreRoot, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"))[0],
      onEvent: () => {},
      onRequest: (p, m, params) => gpuBroker.onRequest(p, m, params),
    });
    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "overlay-onframe.mjs")).href,
      name: "onframe", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);

    // Drive the frame loop the way main.ts does: idle force-present gate,
    // composite, then flip-complete dispatch for output 0. The plugin gets one
    // tick per iteration; a plugin free-running on its own clock is not being
    // tested here -- the fixture has NO timers, so every color advance below
    // is tick-caused.
    const seen = new Set();
    const start = Date.now();
    while (Date.now() - start < 8000 && seen.size < 3) {
      frameTicks.idleTick();
      compositor.renderFrame();
      frameTicks.dispatchForOutput(0, Math.round(performance.now()));
      // Let the tick's postMessage round-trip and the plugin's present land.
      await sleep(40);
      compositor.renderFrame();
      const { data } = await compositor.readback();
      const i = (32 * W + 32) * 4;  // inside the top-left 64x64 overlay
      const c = classify(data[i], data[i + 1], data[i + 2]);
      if (c) seen.add(c);
    }

    // Tick-driven animation proven if the composited output showed MULTIPLE
    // distinct colors (a stranded onFrame would freeze the first color).
    assert.ok(seen.size >= 2,
      `expected tick-driven color advance; saw colors: ${[...seen].join(",") || "(none)"}`);
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
