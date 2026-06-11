// Phase 8 step 4-live: Worker transitions with live (ring-backed)
// scenes. Verifies the per-frame producer Begin/End wire brackets fire
// on the right slot so Dawn's STM validation stays clean across the
// ring rotation.
//
// Strategy: capture all of stderr; after the test, scan for the Dawn
// validation error string ("used in a submit without current access to
// SharedTextureMemory"). If any appear, the bracket discipline is
// wrong even if the test otherwise looks like it passed.

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

test("Worker plugin: sdk.transitions.run on LIVE scenes (per-frame brackets)",
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

  // Capture stderr so we can scan for Dawn validation errors after.
  // Dawn writes them to stderr via fprintf in the GPU process; the
  // GPU-process stderr is inherited by the parent in this harness.
  const capturedStderr = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line no-restricted-syntax
  process.stderr.write = ((chunk, ...rest) => {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return origWrite(chunk, ...rest);
  });

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

    const priorBefore = c.state.beforeRender;
    c.state.beforeRender = (timeMs) => {
      priorBefore?.(timeMs);
      transitionEvaluator.tick(timeMs);
    };

    // Spawn a client. Single client, single window; both live scenes
    // capture the same window contents -- the test isn't about pixel
    // correctness but about the per-frame bracket discipline.
    const color = 0xff2080c0;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "window" });
    const windowId = snap.windows[0].surfaceId;

    const fixture = pathToFileURL(
      join(__dirname, "fixtures", "plugins", "worker-transitions-live.mjs")).href;
    await c.runtime.load([{
      module: fixture,
      name: "worker-transitions-live",
      restart: "never", maxRestarts: 0, windowSeconds: 60,
      raw: {
        windowId, outW: OUT.width, outH: OUT.height,
        kind: "crossfade", durationMs: DURATION,
      },
    }]);

    // Wait for submit.
    const t0 = Date.now();
    while (!logs.includes("worker-transitions-live submitted") && Date.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("worker-transitions-live submitted"),
      `plugin did not submit; logs=${JSON.stringify(logs)}`);
    assert.equal(c.jsCompositor.hasActiveTransition(), true,
      "compositor should have active transition after submit");

    // Run for the full transition duration. Many frames pass; each
    // frame's resolver returns a (possibly different) slot's
    // surfaceBufId. The per-frame Begin/End must pair correctly on
    // every slot.
    const t1 = Date.now();
    while (!logs.includes("worker-transitions-live done") && Date.now() - t1 < 5000) {
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(logs.includes("worker-transitions-live done"),
      `transition did not complete; logs=${JSON.stringify(logs)}`);
    assert.equal(c.jsCompositor.hasActiveTransition(), false,
      "compositor should clear transition after done");

    // Wait for release.
    const t2 = Date.now();
    while (!logs.includes("worker-transitions-live released") && Date.now() - t2 < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(logs.includes("worker-transitions-live released"),
      `scenes not released; logs=${JSON.stringify(logs)}`);

    // Settle a couple frames so the deferred teardown completes
    // before we scan stderr (the trailing producer.End from the
    // ring's per-frame loop should also have fired by now).
    await new Promise((r) => setTimeout(r, 100));

    // Critical: NO Dawn validation errors about SharedTextureMemory
    // access. The per-frame Begin/End wrapping the transition's
    // sample MUST cover every slot resolveTexture picked.
    const allStderr = capturedStderr.join("");
    const stmErrors = (allStderr.match(/SharedTextureMemory/g) || []).length;
    assert.equal(stmErrors, 0,
      `Dawn STM validation errors present in stderr (count=${stmErrors}):\n` +
      allStderr.split("\n").filter((l) => l.includes("SharedTextureMemory")).slice(0, 10).join("\n"));

    // And no plugin ERROR logs.
    const errs = logs.filter((l) => l.includes("ERROR"));
    assert.deepEqual(errs, [],
      `unexpected ERROR logs: ${JSON.stringify(errs)}`);
  } finally {
    process.stderr.write = origWrite;
    await c.teardown();
  }
});
