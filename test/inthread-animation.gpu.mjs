// GPU pixel test for the animation evaluator wired end to end. A bundled
// in-thread plugin submits sdk.animations.run({tween opacity 1->0}); the
// test drives the evaluator via state.beforeRender at controlled
// timestamps and reads back the framebuffer at midpoint + completion.
//
// Requires GPU + dawn.node; skips otherwise.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128, SZ = 64, SURFACE_ID = 42;
const DURATION = 1000;  // ms; the evaluator caps dt at 100ms, so the test
                        // drives in 16ms steps to cover this exactly.

function solidRed(w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255;
  }
  return { data: buf, stride };
}

// Drive the evaluator by stepping a timeMs forward in `stepMs`-sized
// chunks (smaller than the evaluator's per-tick dt clamp, default 100ms).
// `apply` is called once per step so the test can run the compositor
// frame and observe pixels.
async function driveAndRender(evaluator, compositor, startMs, totalMs, stepMs = 16, onStep) {
  let t = startMs;
  evaluator.tick(t);
  while (t < startMs + totalMs) {
    t = Math.min(t + stepMs, startMs + totalMs);
    evaluator.tick(t);
    if (onStep) await onStep(t);
  }
  // Final render after the last tick (so the surface is composited with
  // the final values from this drive call).
  compositor.renderFrame();
}

test("bundled in-thread plugin tweens window-opacity via sdk.animations.run",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(coreRoot, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(coreRoot, "dist", "overlay.js"));
  const { createAnimationsBroker, NOT_HANDLED } =
    await import(join(coreRoot, "dist", "plugins", "animations-broker.js"));
  const { createEvaluator } = await import(join(coreRoot, "dist", "animations", "evaluator.js"));

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

    // Evaluator + broker; tests drive evaluator.tick() directly (no
    // state.beforeRender wiring needed for this harness).
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
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "inthread-animation.mjs")).href,
      name: "inthread-animation", restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true,
      raw: { surfaceId: SURFACE_ID, durationMs: DURATION },
    }]);

    // Wait for the plugin to submit the animation.
    const start = Date.now();
    while (!logs.some((l) => l === "animation submitted") && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.some((l) => l === "animation submitted"),
      `plugin did not submit animation; logs=${JSON.stringify(logs)}`);
    assert.equal(evaluator.activeCount(), 1, "one active leaf");

    const px = (data, x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    // Drive the evaluator to the midpoint (500ms elapsed); opacity ~= 0.5.
    await driveAndRender(evaluator, compositor, 0, DURATION / 2);
    let { data } = await compositor.readback();
    const [b, g, r] = px(data, 32, 32);
    assert.equal(b, 0);
    assert.equal(g, 0);
    // Linear tween, opacity at midpoint ~= 0.5. Premultiplied red ~= 128.
    // Allow ~6-unit tolerance to cover the rounding + the fact that the
    // last tick lands just before exactly t=500 due to 16ms stepping.
    assert.ok(Math.abs(r - 128) <= 6,
      `midpoint red ~= 128 (got ${r}, opacity ~= 0.5)`);

    // Drive to the end (another 600ms past midpoint). Animation completes;
    // opacity 0; red surface fully attenuated; clear color shows through.
    await driveAndRender(evaluator, compositor, DURATION / 2, DURATION / 2 + 100);
    ({ data } = await compositor.readback());
    assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255],
      "final: opacity=0 -> clear color");
    assert.equal(evaluator.activeCount(), 0, "no active leaves at end");

    // Wait for the plugin's `animation done` log.
    const dStart = Date.now();
    while (!logs.some((l) => l === "animation done") && Date.now() - dStart < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.some((l) => l === "animation done"),
      `plugin did not see animation done; logs=${JSON.stringify(logs)}`);
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
