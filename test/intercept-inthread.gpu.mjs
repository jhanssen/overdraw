// End-to-end GPU tests for Phase 10a in-thread intercept:
//   - invert demo: a known-red client window composites as cyan (invert
//     of red) when intercepted; the surface displaces the client buffer.
//   - outputRect: the plugin returns a different rect each frame; the
//     compositor places the surface there instead of the WM tile.
//   - match scope: two clients, one matches (intercepted), one doesn't
//     (raw client buffer). Verify only the right one is inverted.
//   - unmatched on close: client unmaps -> intercept's onSurfaceUnmatched
//     fires (observed via plugin log).
//
// All tests load the bundled fixture `intercept-invert.mjs` with a
// regex configured to match the test client's --app-id. Each
// test owns a fresh setupCompositor lifecycle (server bring-up isn't
// safely repeatable in-process; one harness per test file is the
// pattern other GPU tests follow).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const HARNESS_BIN = buildBin("harness-client");
const FIXTURE = join(here, "fixtures", "plugins", "intercept-invert.mjs");

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";

// Solid color BGRA value -> ARGB8888 hex string for the client's --color.
// harness-client expects an ARGB hex (`AARRGGBB`); we test with opaque red.
const RED_ARGB = "FFFF0000";          // ARGB: red
const CYAN_BGRA_INVERT = [255, 255, 0, 255];   // BGRA: cyan (1 - red.rgb)
const RED_BGRA = [0, 0, 255, 255];             // BGRA: red

function px(data, W, x, y) {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

function fixturePlugin(name, raw) {
  return {
    module: FIXTURE,
    name,
    restart: "never",
    maxRestarts: 0,
    windowSeconds: 60,
    // bundled: true so the runtime loads the fixture on the main
    // thread and routes its sdk.intercept through the in-thread
    // broker (which is what 10a supports). 'bundled' here means
    // "in-process with core's GPU device"; the fixture isn't a
    // real shipped bundled plugin.
    bundled: true,
    raw,
  };
}

test("intercept: invert plugin displaces a red client buffer with its cyan output",
  { skip }, async () => {
  const c = await setupCompositor({
    headless: { width: 256, height: 256 },
    intercept: true,
    plugins: [fixturePlugin("invert", {
      appIdSource: "^intercept-test$",
      appIdFlags: "",
    })],
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "intercept-test", "--color", RED_ARGB,
       "--size", "200x150", "--title", "t"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    // Wait for the broker's matched event to fire (the fixture logs).
    await c.waitFor(
      () => ({ matched: client.stdout.includes("[harness-client] mapped") }),
      (s) => s.matched);
    // Let the plugin's setup + first matched render fire.
    await new Promise((r) => setTimeout(r, 200));

    const data = await c.frameReadback();
    assert.ok(data, "got a frame");
    // The harness-client maps a window with size 200x150 at the WM-
    // assigned tile. The exact tile depends on the layout plugin; with
    // a single client and the default master-stack layout, it gets the
    // full output rect (256x256). Sample at (50,50) which is inside
    // the intercept output.
    const center = px(data, 256, 50, 50);
    assert.deepEqual(center, CYAN_BGRA_INVERT,
      `expected cyan (inverted red), got [${center.join(",")}]`);
  } finally {
    await c.teardown();
  }
});

test("intercept: outputRect overrides the WM-assigned placement",
  { skip }, async () => {
  const c = await setupCompositor({
    headless: { width: 256, height: 256 },
    intercept: true,
    plugins: [fixturePlugin("invert", {
      appIdSource: "^intercept-test$",
      appIdFlags: "",
      // Place the inverted output at a known small rect; everything
      // outside should be the clear color (black), not the client
      // buffer.
      outputRect: { x: 64, y: 64, w: 64, h: 64 },
    })],
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "intercept-test", "--color", RED_ARGB,
       "--size", "200x150", "--title", "t"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    await new Promise((r) => setTimeout(r, 200));

    const data = await c.frameReadback();
    // Inside the outputRect [64,128) x [64,128): cyan.
    assert.deepEqual(px(data, 256, 96, 96), CYAN_BGRA_INVERT,
      "inside outputRect -> cyan");
    // Outside the outputRect: black (cleared; the client buffer is
    // displaced and there's no compose at the WM rect).
    assert.deepEqual(px(data, 256, 200, 200), [0, 0, 0, 255],
      "outside outputRect -> black");
    assert.deepEqual(px(data, 256, 30, 30), [0, 0, 0, 255],
      "above-left of outputRect -> black");
  } finally {
    await c.teardown();
  }
});

test("intercept: only matching clients are intercepted; others draw raw",
  { skip }, async () => {
  // Master-stack layout splits two clients across the output. We
  // arrange them so the test can sample each one's tile.
  const logs = [];
  const c = await setupCompositor({
    headless: { width: 256, height: 256 },
    intercept: true,
    onEvent: (plugin, name, data) => {
      if (name === "log") logs.push(`[${plugin}] ${data}`);
    },
    plugins: [fixturePlugin("invert", {
      appIdSource: "^matches-this$",
      appIdFlags: "",
    })],
  });
  try {
    const a = c.spawnClient(
      ["--app-id", "matches-this", "--color", RED_ARGB,
       "--size", "200x150", "--title", "match"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await a.ready;
    const b = c.spawnClient(
      ["--app-id", "other", "--color", RED_ARGB,
       "--size", "200x150", "--title", "skip"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await b.ready;
    await new Promise((r) => setTimeout(r, 500));

    // Sanity: only ONE matched event for the "matches-this" client.
    const matched = logs.filter((l) => l.includes("intercept-invert: matched"));
    assert.equal(matched.length, 1, `expected one matched log, got:\n${logs.join("\n")}`);

    // The WM places windows in surface-creation order; the intercept
    // matches against app_id, not order. Look up each window's tile
    // from the query and sample inside it. This makes the test
    // robust against insertion-order changes in the WM.
    const snap = c.query();
    const matchWin = snap.windows.find((w) => w.appId === "matches-this");
    const otherWin = snap.windows.find((w) => w.appId === "other");
    assert.ok(matchWin && otherWin, "both windows must be mapped");

    const data = await c.frameReadback();
    const matchCenter = {
      x: matchWin.rect.x + Math.floor(matchWin.rect.width / 2),
      y: matchWin.rect.y + Math.floor(matchWin.rect.height / 2),
    };
    const otherCenter = {
      x: otherWin.rect.x + Math.floor(otherWin.rect.width / 2),
      y: otherWin.rect.y + Math.floor(otherWin.rect.height / 2),
    };
    const matchPx = px(data, 256, matchCenter.x, matchCenter.y);
    const otherPx = px(data, 256, otherCenter.x, otherCenter.y);
    assert.deepEqual(matchPx, CYAN_BGRA_INVERT,
      `matched client should be inverted at (${matchCenter.x},${matchCenter.y}), ` +
      `got [${matchPx.join(",")}]; logs:\n${logs.join("\n")}`);
    assert.deepEqual(otherPx, RED_BGRA,
      `unmatched client should draw raw red at (${otherCenter.x},${otherCenter.y}), ` +
      `got [${otherPx.join(",")}]`);
  } finally {
    await c.teardown();
  }
});

test("intercept: onSurfaceUnmatched fires when the client unmaps",
  { skip }, async () => {
  const logs = [];
  const c = await setupCompositor({
    headless: { width: 256, height: 256 },
    intercept: true,
    log: (line) => logs.push(line),
    onEvent: (plugin, name, data) => {
      if (name === "log") logs.push(`[${plugin}] ${data}`);
    },
    plugins: [fixturePlugin("invert", {
      appIdSource: "^intercept-test$",
      appIdFlags: "",
    })],
  });
  try {
    const client = c.spawnClient(
      ["--app-id", "intercept-test", "--color", RED_ARGB,
       "--size", "100x100", "--title", "t"],
      { bin: HARNESS_BIN, readyMarker: "[harness-client] mapped" });
    await client.ready;
    await new Promise((r) => setTimeout(r, 200));
    // Plugin should have logged 'matched'.
    assert.ok(logs.some((l) => l.includes("intercept-invert: matched")),
      `expected match log, got logs:\n${logs.join("\n")}`);

    // Kill the client; the wayland server observes the disconnect and
    // fires window.unmap; the broker fires onSurfaceUnmatched.
    client.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(logs.some((l) => l.includes("intercept-invert: unmatched")),
      `expected unmatched log, got logs:\n${logs.join("\n")}`);
  } finally {
    await c.teardown();
  }
});
