// Slice 3: the JS compositor presents to the REAL host swapchain (nested), not
// an offscreen target. A real shm client maps; the JS compositor acquires the
// host swapchain texture each frame (addon.acquireOutputTexture -> wrapTexture),
// renders the composite into it, and presents (addon.presentOutput). Verifies
// frames are presented end-to-end without crashing.
//
// On-screen PIXEL correctness is not asserted here -- you cannot read back a
// swapchain texture after Present, and it is not allocated CopySrc. The render
// pass itself is identical to the headless path, which IS pixel-verified
// (js-compositor*.gpu.mjs). This test proves the WSI acquire/render/present wiring
// (incl. wrapping a swapchain texture as a render-attachment) works.
//
// Requires GPU + a host Wayland window (nested), so it pops a real window.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, loadDawn } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU + host Wayland (nested)"
  : (!loadDawn() ? "dawn.node not built" : false);

test("JS compositor presents to the host swapchain (nested)", { skip }, async () => {
  // headless:false -> nested host window + WSI swapchain, JS-driven present.
  const c = await setupCompositor({ headless: false, jsCompositor: true });
  try {
    const { ready } = c.spawnClient(["--size", "300x200", "--color", "ff2080c0"]);
    await ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });

    // Let the present loop run a bit, then assert frames were actually presented.
    const before = c.addon.presentedCount();
    await new Promise((r) => setTimeout(r, 300));
    const after = c.addon.presentedCount();
    assert.ok(after > before, `expected presented frames to advance (before=${before} after=${after})`);
  } finally {
    await c.teardown();
  }
});
