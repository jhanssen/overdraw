// Phase 8 step 4: Worker transitions end-to-end. A Worker plugin
// (running in worker_threads) captures two SceneHandles via
// sdk.compose.scene snapshot (cross-device dmabuf) and calls
// sdk.transitions.run to blend them. The test wires the transitions
// broker into the harness's runtime and verifies that the Worker SDK
// path (sceneIds across postMessage; commit-rejection) drives the
// transition pipeline correctly.
//
// Pixel-level kind correctness is already covered by the compositor-
// direct test (transitions-compositor.gpu.mjs); this test focuses on
// the Worker wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
const DURATION = 400;

test("Worker plugin: sdk.transitions.run drives a transition end to end (snapshot)",
  { skip }, async () => {
  const { createGpuBroker } = await import(join(OD, "dist", "plugins", "gpu-broker.js"));
  const { createOverlayBroker } = await import(join(OD, "dist", "overlay.js"));
  const { createSceneRegistry } = await import(join(OD, "dist", "plugins", "scene-registry.js"));
  const { createTransitionEvaluator } = await import(join(OD, "dist", "transitions", "evaluator.js"));
  const { createTransitionsBroker, NOT_HANDLED: TX_NOT_HANDLED } =
    await import(join(OD, "dist", "plugins", "transitions-broker.js"));

  const logs = [];
  let gpuBroker = null;
  let transitionsBroker = null;
  let transitionEvaluator = null;

  const c = await setupCompositor({
    headless: OUT,
    pluginAddonPath,
    dawnPath,
    onEvent: (_p, name, data) => {
      if (name === "log") logs.push(String(data));
    },
    onRequest: (plugin, method, params) => {
      if (method.startsWith("gpu.") || method.startsWith("surface.")
          || method.startsWith("compose.")) {
        return gpuBroker.onRequest(plugin, method, params);
      }
      if (method.startsWith("transitions.")) {
        const r = transitionsBroker(plugin, method, params);
        if (r === TX_NOT_HANDLED) throw new Error(`no handler for ${method}`);
        return r;
      }
      throw new Error(`unexpected request: ${method}`);
    },
  });
  try {
    // Wire the brokers. Share the same sceneRegistry between
    // gpuBroker (which registers Worker scenes) and transitionsBroker
    // (which resolves them).
    let serial = 1000;
    const overlayState = { serial: () => ++serial, compositor: c.jsCompositor };
    const overlays = createOverlayBroker(overlayState, OUT);
    const h = c.addon.gpuHandles();
    const sceneRegistry = createSceneRegistry();
    gpuBroker = createGpuBroker({
      addon: c.addon, compositor: c.jsCompositor, overlays, dawn,
      coreDeviceHandle: h.device,
      sceneRegistry,
    });
    transitionEvaluator = createTransitionEvaluator();
    transitionsBroker = createTransitionsBroker({
      compositor: c.jsCompositor,
      evaluator: transitionEvaluator,
      sceneRegistry,
    });

    // The transition evaluator needs a clock. Hook it into the
    // existing state.beforeRender so renderFrame ticks it (the
    // harness leaves beforeRender unset by default).
    const priorBefore = c.state.beforeRender;
    c.state.beforeRender = (timeMs) => {
      priorBefore?.(timeMs);
      transitionEvaluator.tick(timeMs);
    };

    // Spawn a client. Color doesn't matter -- the Worker captures the
    // same window twice; the transition runs but is visually identity
    // (both inputs identical).
    const color = 0xff20a060;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "window" });
    const windowId = snap.windows[0].surfaceId;

    // Load the worker fixture AFTER the client maps.
    const fixture = pathToFileURL(
      join(__dirname, "fixtures", "plugins", "worker-transitions.mjs")).href;
    await c.runtime.load([{
      module: fixture,
      name: "worker-transitions",
      restart: "never", maxRestarts: 0, windowSeconds: 60,
      raw: {
        windowId, outW: OUT.width, outH: OUT.height,
        kind: "crossfade", durationMs: DURATION,
      },
    }]);

    // Wait for the plugin to submit the transition.
    const t0 = Date.now();
    while (!logs.includes("worker-transitions submitted") && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("worker-transitions submitted"),
      `plugin did not submit transition; logs=${JSON.stringify(logs)}`);

    // The plugin's scenes are now registered + the transition is
    // installed. Confirm compositor sees it as active.
    assert.equal(c.jsCompositor.hasActiveTransition(), true,
      "compositor should have an active transition after Worker submit");
    assert.equal(transitionEvaluator.isActive(), true,
      "evaluator should be running");

    // The addon's native frame timer ticks dispatchFrameCallbacks
    // on its own; our beforeRender hook above advances the transition
    // evaluator. Just wait for the plugin's "done" log.
    const t1 = Date.now();
    while (!logs.includes("worker-transitions done") && Date.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(logs.includes("worker-transitions done"),
      `transition did not complete; logs=${JSON.stringify(logs)}`);

    // Compositor should be back to no active transition.
    assert.equal(c.jsCompositor.hasActiveTransition(), false,
      "compositor should clear transition after done");
    assert.equal(transitionEvaluator.isActive(), false,
      "evaluator should be idle after done");

    // Wait for scenes to be released by the plugin's then() chain.
    const t2 = Date.now();
    while (!logs.includes("worker-transitions released") && Date.now() - t2 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("worker-transitions released"),
      `scenes not released; logs=${JSON.stringify(logs)}`);

    // No ERROR logs.
    const errs = logs.filter((l) => l.includes("ERROR"));
    assert.deepEqual(errs, [],
      `unexpected ERROR logs from plugin: ${JSON.stringify(errs)}`);
  } finally {
    await c.teardown();
  }
});
