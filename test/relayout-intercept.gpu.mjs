// Integration test for window.relayout interception. A bundled in-thread
// fixture plugin registers an interceptor that modifies newOuter; the test
// maps a real wayland client and verifies the WM installs the intercepted
// rect rather than the layout's full-output rect.
//
// Requires GPU + host Wayland; auto-skips otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { setupCompositor, canRunGpu } from "./harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";

const SNAP = { x: 100, y: 50, width: 200, height: 150 };

function snapPlugin(config) {
  return {
    module: pathToFileURL(join(__dirname, "fixtures", "plugins", "relayout-snap.mjs")).href,
    name: "relayout-snap",
    restart: "never",
    maxRestarts: 0,
    windowSeconds: 60,
    bundled: true,
    raw: config,
  };
}

test("relayout intercept: bundled plugin's newOuter is applied by the WM", { skip }, async () => {
  const c = await setupCompositor({
    plugins: [snapPlugin({ snapRect: SNAP })],
  });
  try {
    const { ready } = c.spawnClient(["--title", "snap-target"]);
    await ready;
    const snap = await c.waitFor(c.query,
      (s) => s.windows.length === 1
          && s.windows[0].rect.width === SNAP.width
          && s.windows[0].rect.height === SNAP.height,
      { what: "window relayout snapped" });
    assert.deepEqual(snap.windows[0].rect, SNAP);
  } finally {
    await c.teardown();
  }
});

test("relayout intercept: interceptor sees both old and new outer in payload", { skip }, async () => {
  const logs = [];
  const c = await setupCompositor({
    plugins: [snapPlugin({ snapRect: SNAP })],
    onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
  });
  try {
    const { ready } = c.spawnClient([]);
    await ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window mapped" });
    // The plugin logs an INTERCEPT line per emit. There may be more than one
    // (the relayout-on-content reflow can trigger a second pass), but at
    // least one must have a populated payload.
    const intercepts = logs.filter((l) => l.includes("INTERCEPT "));
    assert.ok(intercepts.length >= 1, `expected >= 1 intercept log, got: ${logs.join("\n")}`);
    const first = intercepts[0].slice(intercepts[0].indexOf("{"));
    const parsed = JSON.parse(first);
    assert.equal(typeof parsed.surfaceId, "number");
    assert.equal(typeof parsed.oldOuter.x, "number");
    assert.equal(typeof parsed.newOuter.width, "number");
  } finally {
    await c.teardown();
  }
});
