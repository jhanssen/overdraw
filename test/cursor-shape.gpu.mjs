// wp_cursor_shape_v1 end-to-end:
//   - cursor-shape-test-client maps a red toplevel and binds the cursor-
//     shape manager.
//   - The harness injects pointer motion to trigger pointer.enter.
//   - The client calls wp_cursor_shape_device_v1.set_shape(serial, DEFAULT).
//   - The compositor's cursor slot resolves 'default' via the XCursor
//     theme (built-in fallback when no theme installed) and renders it
//     at the pointer position.
//
// Forces XCURSOR_THEME to a bogus name so we exercise the built-in
// fallback arrow, ensuring the test isn't dependent on the host's
// theme set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CS_BIN = buildBin("cursor-shape-test-client");

test("wp_cursor_shape_v1: set_shape installs a themed shape via the resolver",
  { skip }, async () => {
  // Force the built-in fallback arrow: the test environment shouldn't
  // depend on any system XCursor theme.
  const prevTheme = process.env.XCURSOR_THEME;
  process.env.XCURSOR_THEME = "overdraw-cs-test-no-theme-" + Math.random();
  try {
    const c = await setupCompositor({ headless: { width: 256, height: 256 } });
    try {
      const client = c.spawnClient([], { bin: CS_BIN, readyMarker: "[client] mapped" });
      await client.ready;

      c.addon.injectInput({ type: "pointerMotion", x: 64, y: 64 });
      c.addon.injectInput({ type: "pointerFrame" });

      await client.waitForLine("[client] set_shape", { timeoutMs: 4000, what: "set_shape done" });

      // After set_shape the cursor slot is pointing at the internal
      // surface holding the resolver's 'default' shape. Move the pointer
      // to a known position; the cursor should follow.
      c.addon.injectInput({ type: "pointerMotion", x: 100, y: 100 });
      c.addon.injectInput({ type: "pointerFrame" });
      await new Promise((r) => setTimeout(r, 50));

      const data = await c.frameReadback();
      assert.ok(data, "got a frame");
      const W = 256;
      const px = (x, y) => {
        const i = (y * W + x) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      };
      // Built-in arrow: 16x16 BGRA, body fills upper-left triangle, mostly
      // opaque (white + black border). At the pointer position (100,100)
      // hotspot is (0,0) so cursor rect = [100,116)x[100,116). Top-left
      // pixel (100,100) is the arrow border (black, alpha=255). Verify
      // alpha there is opaque.
      const [, , , a100] = px(100, 100);
      assert.equal(a100, 255, "arrow opaque at hotspot origin");
      // A point outside the cursor: still red (the toplevel pixel).
      // The toplevel is 128x128 so (30,30) is inside it but outside the
      // cursor's rect [100,116) -- should be red.
      const outside = px(30, 30);
      assert.deepEqual(outside, [0, 0, 255, 255],
        `toplevel red at (30,30), got [${outside.join(",")}]`);
    } finally {
      await c.teardown();
    }
  } finally {
    if (prevTheme === undefined) delete process.env.XCURSOR_THEME;
    else process.env.XCURSOR_THEME = prevTheme;
  }
});
