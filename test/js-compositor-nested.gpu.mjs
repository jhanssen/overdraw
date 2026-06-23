// Nested mode: the JS compositor acquires the host's output texture each
// frame (addon.acquireOutputTexture -> wrapTexture), renders the composite
// into it, and presents (addon.presentOutput). Verifies the acquire/render/
// present wiring is functional end-to-end against a real host window.
//
// On-screen PIXEL correctness is not asserted here -- swapchain textures are
// not readable after present. The render pass itself is identical to the
// headless path, which IS pixel-verified (js-compositor*.gpu.mjs).
//
// The compositor's per-output dirty gate (see renderFrame) intentionally
// skips presents when nothing has changed on an output -- idle = no present,
// matching wlroots / Hyprland. So the client must keep committing to make
// presents observable. --frames drives that: it re-commits on each
// wl_callback.done, producing damage every host vblank.
//
// Requires GPU + a host Wayland window (nested), so it pops a real window.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunNested, loadDawn } from "./harness.mjs";

const skip = !loadDawn() ? "dawn.node not built"
  : (!canRunNested() ? "needs GPU + host Wayland (nested)" : false);

test("JS compositor presents to the host swapchain (nested)", { skip }, async () => {
  const c = await setupCompositor({ headless: false, jsCompositor: true });
  try {
    // --frames: client re-commits on each wl_callback.done, generating damage
    // every vblank so the per-output dirty gate stays armed.
    const client = c.spawnClient(
      ["--size", "300x200", "--color", "ff2080c0", "--frames"]);
    await client.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });

    // Wait for the client to confirm at least one frame.done so the present
    // loop is established before we sample the counter.
    await client.waitForLine(/frame\.done n=1/,
      { timeoutMs: 2000, what: "first frame.done" });

    // With the client committing every vblank, presents must advance over
    // 300ms (~18 presents at 60Hz; threshold of >0 tolerates slow CI).
    const before = c.addon.presentedCount();
    await new Promise((r) => setTimeout(r, 300));
    const after = c.addon.presentedCount();
    assert.ok(after > before,
      `expected presented frames to advance (before=${before} after=${after})`);
  } finally {
    await c.teardown();
  }
});
