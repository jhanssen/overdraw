// Phase 8 step 3: GPU integration via the in-thread plugin SDK path.
// A bundled in-thread plugin calls sdk.compose.scene twice to capture
// two snapshots, then sdk.transitions.run to blend them. The test
// drives the transition evaluator's clock manually and reads back the
// framebuffer at install / midpoint / completion to verify the
// transition pipeline is being driven through the SDK + broker chain
// (not just the compositor-direct path covered in step 2).
//
// This is the end-to-end smoke for sdk.transitions on in-thread.
// Worker support lands in step 4.

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
const RED_ID = 100, BLUE_ID = 200;
const DURATION = 1000;

function solid(bgra, w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgra[0]; data[i + 1] = bgra[1];
    data[i + 2] = bgra[2]; data[i + 3] = bgra[3];
  }
  return { data, stride: w * 4 };
}

test("bundled in-thread plugin runs sdk.transitions.run (crossfade)",
    { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  const { PluginRuntime } = await import(join(OD, "dist", "plugins", "index.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));
  const { createSceneRegistry } = await import(join(OD, "dist", "plugins", "scene-registry.js"));
  const { createTransitionEvaluator } = await import(join(OD, "dist", "transitions", "evaluator.js"));
  const {
    createTransitionsBroker, NOT_HANDLED: TX_NOT_HANDLED,
  } = await import(join(OD, "dist", "plugins", "transitions-broker.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  let runtime = null;
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const compositor = new JsCompositor(device, dawn.globals, addon,
      { width: W, height: H }, dawn, h.device);

    // Upload two full-screen surfaces (red + blue). Stack neither;
    // the plugin sets the output stack per snapshot before calling
    // compose.scene.
    const red  = solid([0, 0, 0xff, 0xff], W, H);
    const blue = solid([0xff, 0, 0, 0xff], W, H);
    compositor.uploadPixels(RED_ID,
      { width: W, height: H, stride: red.stride }, red.data);
    compositor.uploadPixels(BLUE_ID,
      { width: W, height: H, stride: blue.stride }, blue.data);
    compositor.setSurfaceLayout(RED_ID,  0, 0, W, H);
    compositor.setSurfaceLayout(BLUE_ID, 0, 0, W, H);
    // Stack is empty -- the plugin captures snapshots by setting the
    // stack per scene before compose.scene, then clears it. (The test
    // doesn't need the stack to be non-empty after; the transition
    // pass overrides the on-screen output anyway while active.)

    let serial = 1000;
    const ovState = { serial: () => ++serial, compositor };
    const overlays = createOverlayBroker(ovState, { width: W, height: H });

    const sceneRegistry = createSceneRegistry();
    const transitionEvaluator = createTransitionEvaluator();
    const transitionsBroker = createTransitionsBroker({
      compositor, evaluator: transitionEvaluator, sceneRegistry,
    });

    const logs = [];
    runtime = new PluginRuntime({
      inThreadGpu: {
        coreDevice: device, globals: dawn.globals,
        overlays, compositor, sceneRegistry,
      },
      onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
      onRequest: (plugin, method, params) => {
        if (method.startsWith("transitions.")) {
          const r = transitionsBroker(plugin, method, params);
          if (r === TX_NOT_HANDLED) throw new Error(`no handler for '${method}'`);
          return r;
        }
        throw new Error(`unexpected request '${method}'`);
      },
    });

    // The plugin captures each scene against a single-window stack.
    // Set up the helper here: when the plugin calls compose.scene we
    // need the WM stack to contain just that one window. The plugin's
    // fixture does this directly via the windows list -- compose.scene
    // takes the window list as an arg, so we don't need to swap the
    // stack at all. Empty stack here.
    compositor.setStack([]);

    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "inthread-transitions.mjs")).href,
      name: "inthread-transitions", restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true,
      raw: {
        fromWindowId: RED_ID, toWindowId: BLUE_ID,
        kind: "crossfade", durationMs: DURATION,
        outW: W, outH: H,
      },
    }]);

    // Wait for the plugin to submit the transition.
    const t0 = Date.now();
    while (!logs.includes("transition submitted") && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("transition submitted"),
      `plugin did not submit transition; logs=${JSON.stringify(logs)}`);

    // After install: the transition is active but no tick has fired
    // yet. The compositor has setActiveTransition installed.
    assert.equal(compositor.hasActiveTransition(), true,
      "compositor should have active transition after submit");

    const px = (data, x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    const close = (a, b, tol = 4) => {
      for (let i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
      return true;
    };

    // Tick to t=0 -> progress=0 -> output should be FROM (red).
    transitionEvaluator.tick(0);
    compositor.renderFrame();
    let { data } = await compositor.readback();
    let p = px(data, W >> 1, H >> 1);
    assert.ok(close(p, [0, 0, 0xff, 0xff]),
      `progress=0 expected red, got ${p}`);

    // Tick to midpoint -> progress=0.5 -> ~50/50 blend.
    transitionEvaluator.tick(DURATION / 2);
    compositor.renderFrame();
    ({ data } = await compositor.readback());
    p = px(data, W >> 1, H >> 1);
    assert.ok(Math.abs(p[0] - 128) < 8, `mid B: expected ~128, got ${p[0]}`);
    assert.ok(p[1] < 8, `mid G: expected ~0, got ${p[1]}`);
    assert.ok(Math.abs(p[2] - 128) < 8, `mid R: expected ~128, got ${p[2]}`);

    // Tick past the end -> commit fires sync, then run promise resolves.
    transitionEvaluator.tick(DURATION + 10);
    compositor.renderFrame();
    // After completion the compositor's transition slot is cleared and
    // hasActiveTransition is false. The framebuffer drew the post-
    // commit normal composite -- which is an empty stack here, so
    // opaque-black background.
    assert.equal(compositor.hasActiveTransition(), false,
      "compositor should clear transition after completion");
    ({ data } = await compositor.readback());
    p = px(data, W >> 1, H >> 1);
    assert.ok(close(p, [0, 0, 0, 0xff]),
      `post-transition expected clear-color, got ${p}`);

    // Wait for the plugin's "transition done" log (the run() Promise
    // resolved after our tick).
    const t1 = Date.now();
    while (!logs.includes("transition done") && Date.now() - t1 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("transition done"),
      `plugin did not see transition done; logs=${JSON.stringify(logs)}`);

    // Wait for scene release log (the plugin awaits both releases).
    const t2 = Date.now();
    while (!logs.includes("scenes released") && Date.now() - t2 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("scenes released"),
      `plugin did not release scenes; logs=${JSON.stringify(logs)}`);
  } finally {
    if (runtime) await runtime.stop();
    addon.stop();
  }
});
