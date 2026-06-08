// Master-stack tiling, end-to-end with real clients. Brings up the compositor,
// spawns N real libwayland clients, and asserts the WM assigned each window the
// master-stack tile via the state-query channel. Proves the proactive configure +
// layout path: geometry is compositor-owned (the harness-client draws a fixed-size
// buffer and ignores the configured size, so this checks WM geometry, which is
// exactly what tiling controls). Requires GPU + host Wayland + dawn.node.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, loadDawn } from "./harness.mjs";
import { masterStackLayout } from "../packages/core/dist/wm/placement.js";

const skip = !canRunGpu() ? "needs GPU (WAYLAND_DISPLAY unset)"
  : (!loadDawn() ? "dawn.node not built" : false);

const LAYOUT = { masterFraction: 0.5, gap: 0 };

// Spawn a client and wait until exactly `n` windows are present in query().
async function spawnAndWait(c, n, appId) {
  const h = c.spawnClient(["--app-id", appId, "--title", appId]);
  await h.ready;
  await c.waitFor(c.query, (s) => s.windows.length === n,
    { what: `${n} window(s)`, timeoutMs: 4000 });
  return h;
}

// query() reports windows in WM layout order (index 0 = master/front).
function rectsById(snap) {
  const m = new Map();
  for (const w of snap.windows) m.set(w.surfaceId, w.rect);
  return m;
}

test("tiling: 1/2/3 clients map to master-stack tiles", { skip }, async () => {
  const c = await setupCompositor({ layout: LAYOUT });
  const out = { width: c.dims.width, height: c.dims.height };
  try {
    // One window: fills the output.
    await spawnAndWait(c, 1, "w1");
    let snap = c.query();
    let expect = masterStackLayout(1, out, LAYOUT);
    // Single window: its rect equals the full-output tile.
    assert.deepEqual(snap.windows[0].rect, expect[0], "1 window fills output");

    // Two windows: new one becomes master (front), order [w2, w1].
    await spawnAndWait(c, 2, "w2");
    snap = c.query();
    expect = masterStackLayout(2, out, LAYOUT);
    // windows[0] is the master (the most recently added); windows[1] the stack.
    assert.deepEqual(snap.windows[0].rect, expect[0], "master = left half");
    assert.deepEqual(snap.windows[1].rect, expect[1], "stack = right half");

    // Three windows: master + two stack slices.
    await spawnAndWait(c, 3, "w3");
    snap = c.query();
    expect = masterStackLayout(3, out, LAYOUT);
    assert.deepEqual(snap.windows[0].rect, expect[0], "master");
    assert.deepEqual(snap.windows[1].rect, expect[1], "stack top");
    assert.deepEqual(snap.windows[2].rect, expect[2], "stack bottom");

    // Tiles partition the output without overlap (master + stack widths sum to W,
    // stack slices sum to H).
    const r = rectsById(snap);
    const allRects = [...r.values()];
    assert.equal(allRects.length, 3);
    // master width + stack width == output width
    const master = snap.windows[0].rect;
    const stackTop = snap.windows[1].rect;
    assert.equal(master.width + stackTop.width, out.width, "no horizontal gap/overlap");
  } finally {
    await c.teardown();
  }
});

test("tiling: unmap reflows survivors", { skip }, async () => {
  const c = await setupCompositor({ layout: LAYOUT });
  const out = { width: c.dims.width, height: c.dims.height };
  try {
    const h1 = await spawnAndWait(c, 1, "a1");
    const h2 = await spawnAndWait(c, 2, "a2");
    // Kill the master (most recent = h2). Survivor should reflow to full output.
    h2.child.kill("SIGTERM");
    await c.waitFor(c.query, (s) => s.windows.length === 1,
      { what: "1 window after unmap", timeoutMs: 4000 });
    const snap = c.query();
    const expect = masterStackLayout(1, out, LAYOUT);
    assert.deepEqual(snap.windows[0].rect, expect[0], "survivor fills output after unmap");
    void h1;
  } finally {
    await c.teardown();
  }
});
