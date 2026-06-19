// End-to-end: a real Wayland client maps and then changes its app_id; the core's
// window-state change stream (set_app_id -> markWindowChanged -> per-frame flush ->
// bus window.change -> plugin runtime broadcast -> Worker observer -> sdk.window
// .onChange) delivers the new app_id to a plugin. This is the one wire-through the
// unit tests only covered in segments. Requires GPU + host Wayland.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu, loadDawn, waitFor } from "./harness.mjs";
import { createCompositorBus } from "../packages/core/dist/events/window-bus.js";
import { DynamicBus } from "../packages/core/dist/events/dynamic-bus.js";
import { WINDOW_EVENT } from "../packages/core/dist/events/types.js";
import { PluginRuntime } from "../packages/core/dist/plugins/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "packages", "core");
const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : !loadDawn() ? "dawn.node not built" : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("client set_app_id after map -> plugin sees window.change with new app_id", { skip }, async () => {
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const c = await setupCompositor({ bus });

  // Forward window.* over the bus to the plugin runtime (mirrors main.ts).
  let runtime = null;
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.change, (ev) => pluginBus.emit(WINDOW_EVENT.change, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  const logs = [];
  // No GPU/window SDK paths needed: the window-observer plugin only logs. Omit
  // pluginAddonPath/dawnPath so the bootstrap does NOT bring up a device (faster,
  // and proves sdk.window works without the gpu capability).
  runtime = new PluginRuntime({
    liveOutputIds: () => [0],
    pingIntervalMs: 200, maxMissedPongs: 5, shutdownTimeoutMs: 500, heapMb: 64,
    log: () => {},
    bus: pluginBus,
    onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
  });

  try {
    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "window-observer.mjs")).href,
      name: "obs", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);
    await waitForLog(logs, (l) => l === "ready");

    // Client maps with app_id "first". stdin enabled so we can trigger a post-map
    // rename only AFTER the window is confirmed mapped (deterministic: the rename
    // must arrive strictly after the map sweep, exercising the change stream).
    const client = c.spawnClient(["--app-id", "first"], { stdin: true });
    await client.ready;
    await waitFor(c.query, (s) => s.windows.length === 1, { what: "window mapped" });
    await waitForLog(logs, (l) => l.startsWith("MAP "), 4000);

    // Now rename; the change is coalesced + flushed on a compositor frame. Wait for
    // a CHANGE that actually carries the NEW app_id (there may be earlier changes --
    // e.g. an `activated` change at focus-on-map -- so match on the value, not just
    // the field being present).
    client.send("rename second");
    await client.waitForLine(/renamed app_id=second/, { what: "client renamed" });
    await waitForLog(logs, (l) => l.startsWith("CHANGE ") && JSON.parse(l.slice(7)).appId === "second", 4000);

    const mapEv = JSON.parse(logs.find((l) => l.startsWith("MAP ")).slice(4));
    const appIdChange = logs
      .filter((l) => l.startsWith("CHANGE "))
      .map((l) => JSON.parse(l.slice(7)))
      .find((e) => e.changed.includes("appId") && e.appId === "second");

    assert.equal(mapEv.appId, "first", "map snapshot carries the initial app_id");
    assert.ok(appIdChange, "a change reported the renamed app_id");
    assert.equal(appIdChange.appId, "second", "change carries the renamed app_id");
    assert.equal(appIdChange.surfaceId, mapEv.surfaceId, "same surface");
  } finally {
    if (runtime) await runtime.stop();
    await c.teardown();
  }
});

async function waitForLog(logs, pred, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    if (logs.some(pred)) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waitForLog timed out; logs:\n${logs.join("\n")}`);
    }
    await sleep(15);
  }
}
