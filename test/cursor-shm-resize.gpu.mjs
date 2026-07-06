// wl_shm_pool.resize + cursor upload end-to-end: the client creates its
// cursor pool sized for one image, grows it with wl_shm_pool.resize (the
// libwayland-cursor theme-pool pattern GTK uses), and carves the cursor
// buffer PAST the pool's creation size. The resize must reach every
// mapping that stages upload bytes -- including the GPU process's
// fast-path mmap -- or the upload is silently dropped and the cursor
// renders as transparent (invisible pointer over GTK/emacs windows).
// Request ordering is GTK's: set_cursor before the cursor surface's
// first attach/commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CLIENT_BIN = buildBin("cursor-shm-resize-client");

test("cursor buffer past the pool's creation size composites after resize",
  { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 256, height: 256 } });
  try {
    const client = c.spawnClient([], { bin: CLIENT_BIN, readyMarker: "[client] mapped" });
    await client.ready;

    // Enter the toplevel so the client gets a serial and sets its cursor.
    c.addon.injectInput({ type: "pointerMotion", x: 64, y: 64 });
    c.addon.injectInput({ type: "pointerFrame" });

    await client.waitForLine("[client] cursor_committed",
      { timeoutMs: 8000, what: "resized-pool cursor committed" });

    // Position the cursor at a known spot; hotspot is (0,0) so the 16x16
    // green image spans [100,116)^2.
    c.addon.injectInput({ type: "pointerMotion", x: 100, y: 100 });
    c.addon.injectInput({ type: "pointerFrame" });
    await new Promise((r) => setTimeout(r, 150));

    const data = await c.frameReadback();
    assert.ok(data, "got a frame");
    const px = (x, y) => {
      const i = (y * 256 + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    assert.deepEqual(px(108, 108), [0, 255, 0, 255],
      `cursor from the grown pool region should be green at (108,108), got [${px(108, 108)}]`);
    // Toplevel pixels away from the cursor stay red (BGRA).
    assert.deepEqual(px(30, 30), [0, 0, 255, 255],
      `toplevel at (30,30) should be red, got [${px(30, 30)}]`);
  } finally {
    await c.teardown();
  }
});
