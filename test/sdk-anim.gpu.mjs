// GPU integration test: a bundled in-thread plugin uses @overdraw/sdk-anim
// builders to construct an AnimationSpec, submits it via sdk.animations.run,
// and the composited frame shows the animated value. End-to-end proof that
// the builder package is the spec-construction half of the animation
// surface; the evaluator (test/inthread-animation.gpu.mjs) is the
// evaluation half. Together they form the full Phase 4 surface.

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

const W = 128, H = 128, SZ = 64, SURFACE_ID = 42, DURATION = 1000;

function solidRed(w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255;
  }
  return { data: buf, stride };
}

async function driveAndRender(evaluator, compositor, startMs, totalMs, stepMs = 16) {
  let t = startMs;
  evaluator.tick(t);
  while (t < startMs + totalMs) {
    t = Math.min(t + stepMs, startMs + totalMs);
    evaluator.tick(t);
  }
  compositor.renderFrame();
}

test("bundled plugin uses @overdraw/sdk-anim builders end-to-end",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(OD, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));
  const { createAnimationsBroker, NOT_HANDLED } =
    await import(join(OD, "dist", "plugins", "animations-broker.js"));
  const { createEvaluator } = await import(join(OD, "dist", "animations", "evaluator.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  let runtime = null;
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const compositor = new JsCompositor(device, dawn.globals, addon,
      { width: W, height: H }, dawn, h.device);

    const red = solidRed(SZ, SZ);
    compositor.uploadPixels(SURFACE_ID,
      { width: SZ, height: SZ, stride: red.stride }, red.data);
    compositor.setSurfaceLayout(SURFACE_ID, 0, 0, SZ, SZ);
    compositor.setStack([SURFACE_ID]);

    const evaluator = createEvaluator(compositor);
    const animationsBroker = createAnimationsBroker(evaluator);

    let serial = 1000;
    const ovState = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(ovState, { width: W, height: H });

    const logs = [];
    runtime = new PluginRuntime({
      inThreadGpu: { coreDevice: device, globals: dawn.globals, overlays, compositor },
      onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
      onRequest: (plugin, method, params) => {
        if (method.startsWith("animations.")) {
          const r = animationsBroker(plugin, method, params);
          if (r === NOT_HANDLED) throw new Error(`no handler for '${method}'`);
          return r;
        }
        throw new Error(`unexpected request '${method}'`);
      },
    });

    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "inthread-sdk-anim.mjs")).href,
      name: "inthread-sdk-anim", restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true,
      raw: { surfaceId: SURFACE_ID, durationMs: DURATION },
    }]);

    const start = Date.now();
    while (!logs.some((l) => l === "animation submitted") && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.some((l) => l === "animation submitted"),
      `plugin did not submit animation; logs=${JSON.stringify(logs)}`);
    assert.equal(evaluator.activeCount(), 1,
      "one active leaf (the builder produced a valid spec)");

    const px = (data, x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    // Midpoint: linear tween, opacity ~= 0.5, premultiplied red ~= 128.
    await driveAndRender(evaluator, compositor, 0, DURATION / 2);
    let { data } = await compositor.readback();
    const [b, g, r] = px(data, 32, 32);
    assert.equal(b, 0);
    assert.equal(g, 0);
    assert.ok(Math.abs(r - 128) <= 6,
      `midpoint red ~= 128 via @overdraw/sdk-anim builder (got ${r})`);

    // End: opacity=0; clear color shows through.
    await driveAndRender(evaluator, compositor, DURATION / 2, DURATION / 2 + 100);
    ({ data } = await compositor.readback());
    assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255],
      "final: opacity=0 -> clear");
    assert.equal(evaluator.activeCount(), 0);
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
