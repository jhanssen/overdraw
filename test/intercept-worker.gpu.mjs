// Phase 10a Worker intercept: invert demo through cross-device dmabuf.
// Same setup as intercept-inthread.gpu.mjs but the fixture plugin runs
// in its own Worker on its own GPU device. Verifies the full input-
// copy + output-consume cross-device chain produces the same pixel
// result as in-thread.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OD = join(here, "..", "packages", "core");
const HARNESS_BIN = buildBin("harness-client");
const FIXTURE = join(here, "fixtures", "plugins", "intercept-invert-worker.mjs");

const [dawnPath] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
const pluginAddonPath = join(OD, "build", "overdraw_plugin_native.node");

const skip = !canRunGpu()
  ? "needs GPU (no render node / dawn.node)"
  : (!dawnPath ? "dawn.node not built" : false);

const RED_ARGB = "FFFF0000";
const CYAN_BGRA = [255, 255, 0, 255];
const RED_BGRA = [0, 0, 255, 255];

function px(data, W, x, y) {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

function workerFixture(name, raw) {
  return {
    module: FIXTURE,
    name,
    restart: "never",
    maxRestarts: 0,
    windowSeconds: 60,
    bundled: false,   // Worker plugin
    raw,
  };
}

test("intercept (Worker): invert plugin displaces a red client buffer with its cyan output",
  { skip }, async () => {
  const logs = [];
  const c = await setupCompositor({
    headless: { width: 256, height: 256 },
    intercept: true,
    pluginAddonPath, dawnPath,
    onEvent: (plugin, name, data) => {
      if (name === "log") logs.push(`[${plugin}] ${data}`);
    },
    // Disable the bundled decoration plugin so the Worker fixture is
    // the only intercept active for the test client (the bundled
    // plugin's default ".*" pattern would otherwise win against the
    // worker fixture's narrower pattern at the same priority).
    config: { decoration: { appIdPattern: "^never-matches-anyone$" } },
    plugins: [workerFixture("invert-worker", {
      appIdSource: "^intercept-worker-test$",
      appIdFlags: "",
    })],
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "intercept-worker-test", "--color", RED_ARGB,
       "--size", "200x150", "--title", "t"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;

    // Worker render + cross-device dmabuf round-trip; takes a few
    // frames longer than in-thread before the first output slot is
    // PRESENTED and the compositor installs it. Give it a generous
    // wait + verify the matched log fired.
    const start = Date.now();
    while (!logs.some((l) => l.includes("matched")) && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(logs.some((l) => l.includes("matched")),
      `expected matched log; got:\n${logs.join("\n")}`);
    // Wait for the cross-device chain to deliver at least one output
    // frame. Poll on activeInterceptIds: the compositor installs the
    // worker's output slot only after the first PRESENTED appears.
    const t1 = Date.now();
    while (c.jsCompositor.activeInterceptIds().length === 0
           && Date.now() - t1 < 3000) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(c.jsCompositor.activeInterceptIds().length > 0,
      `expected compositor to install the worker's output; logs:\n${logs.join("\n")}`);
    // One more frame so the install propagates to the next composite.
    await new Promise((r) => setTimeout(r, 100));

    const data = await c.frameReadback();
    assert.ok(data, "got a frame");
    // Sample inside the surface (full-output single-window layout).
    const center = px(data, 256, 50, 50);
    assert.deepEqual(center, CYAN_BGRA,
      `expected cyan (inverted red), got [${center.join(",")}]; logs:\n${logs.join("\n")}`);
    void RED_BGRA;
  } finally {
    await c.teardown();
  }
});
