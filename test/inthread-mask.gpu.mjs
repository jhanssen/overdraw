// End-to-end mask test: a real bundled in-thread plugin creates an alpha mask
// on sdk.gpu.device (core's device), calls sdk.windows.setMask(surfaceId, tex),
// and the composited frame shows the mask's alpha modulating the surface.
// Verifies the full SDK -> broker -> JsCompositor.setSurfaceMask path through
// the in-thread transport.
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

const W = 128, H = 128, SZ = 64, SURFACE_ID = 42;

function solidRed(w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255;
  }
  return { data: buf, stride };
}

test("bundled in-thread plugin installs a mask via sdk.windows.setMask",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(OD, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));
  const { createWindowsBroker, NOT_HANDLED } = await import(join(OD, "dist", "plugins", "windows-broker.js"));
  const { createWm } = await import(join(OD, "dist", "wm", "index.js"));
  const { createCompositorBus } = await import(join(OD, "dist", "events", "window-bus.js"));
  const { DynamicBus } = await import(join(OD, "dist", "events", "dynamic-bus.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  let runtime = null;
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const compositor = new JsCompositor(device, dawn.globals, addon,
      { width: W, height: H }, dawn, h.device);

    // Upload a red surface and stack it under the chosen SURFACE_ID.
    const red = solidRed(SZ, SZ);
    compositor.uploadPixels(SURFACE_ID, { width: SZ, height: SZ, stride: red.stride }, red.data);
    compositor.setSurfaceLayout(SURFACE_ID, 0, 0, SZ, SZ);
    compositor.setStack([SURFACE_ID]);

    // Build a windows broker pointed at the compositor so the plugin's
    // sdk.windows.setMask routes through to JsCompositor.setSurfaceMask.
    const bus = createCompositorBus();
    const pluginBus = new DynamicBus();
    const wm = createWm(compositor, { width: W, height: H });
    const state = { bus, wm, surfaces: new Map(), seat: null,
                    compositor, decorationResize: null };
    const windowsBroker = createWindowsBroker({
      wm, compositor, state, pluginBus, bus,
    });

    let serial = 1000;
    const ovState = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(ovState, { width: W, height: H });

    const logs = [];
    runtime = new PluginRuntime({
      inThreadGpu: { coreDevice: device, globals: dawn.globals, overlays, compositor },
      bus: pluginBus,
      onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
      onRequest: (plugin, method, params) => {
        if (method.startsWith("windows.")) {
          const r = windowsBroker(plugin, method, params);
          if (r === NOT_HANDLED) throw new Error(`no handler for '${method}'`);
          return r;
        }
        throw new Error(`unexpected request '${method}'`);
      },
    });

    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "inthread-mask.mjs")).href,
      name: "inthread-mask", restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true,
      raw: { surfaceId: SURFACE_ID, maskWidth: SZ, maskHeight: SZ },
    }]);

    // Wait for the plugin to install the mask.
    const start = Date.now();
    while (!logs.some((l) => l.includes("mask installed")) && Date.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(logs.some((l) => l.includes("mask installed")),
      `plugin did not install mask; logs=${JSON.stringify(logs)}`);

    compositor.renderFrame();
    const { data } = await compositor.readback();
    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    // Mask: alpha=0xff where (x + y) > SZ (= 64), alpha=0 else.
    // SZ=64 surface at (0,0)-(64,64).
    //   (56, 56): x+y=112 > 64 -> opaque -> red.
    //   (8, 8):   x+y=16  <= 64 -> transparent -> clear (black).
    assert.deepEqual(px(56, 56), [0, 0, 255, 255],
      "bottom-right (opaque mask) = red");
    assert.deepEqual(px(8, 8), [0, 0, 0, 255],
      "top-left (transparent mask) = black");
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
