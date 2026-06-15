// wl_pointer.set_cursor end-to-end:
//   - cursor-test-client maps a red toplevel and prepares a green
//     16x16 shm cursor surface.
//   - The harness injects a pointer motion over the toplevel.
//   - The client receives wl_pointer.enter (recording the serial)
//     and calls set_cursor(serial, cursor_surface, hotspot=0,0).
//   - The compositor's cursor slot points at the green client cursor
//     surface; the readback shows green where the pointer is,
//     not red (the toplevel below).
//
// Also covers the priority decision: a client cursor beats the
// compositor's built-in default (the boot 'default' shape from the
// resolver, which is also installed).

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const CURSOR_BIN = buildBin("cursor-test-client");

test("wl_pointer.set_cursor: client cursor composites over the focused window",
  { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 256, height: 256 } });
  try {
    const client = c.spawnClient([], { bin: CURSOR_BIN, readyMarker: "[client] mapped" });
    await client.ready;

    // The toplevel is mapped + has its red buffer; inject pointer motion
    // over the window so the client receives wl_pointer.enter (recording
    // its serial) and can then call set_cursor.
    c.addon.injectInput({ type: "pointerMotion", x: 64, y: 64 });
    c.addon.injectInput({ type: "pointerFrame" });

    // Wait for the client to have completed set_cursor.
    await client.waitForLine("[client] set_cursor", { timeoutMs: 4000, what: "set_cursor done" });

    // Inject one more motion to make sure the cursor slot is positioned
    // (set_cursor only swaps the texture; the position update happens
    // on the next pointer event). 100x100 keeps us inside the 128x128
    // window so we stay on the client; cursor draws at (100,100) since
    // hotspot is (0,0).
    c.addon.injectInput({ type: "pointerMotion", x: 100, y: 100 });
    c.addon.injectInput({ type: "pointerFrame" });

    // Let the compositor process the motion + sample the latest cursor
    // surface buffer. Couple of frames of slack.
    await new Promise((r) => setTimeout(r, 50));

    const data = await c.frameReadback();
    assert.ok(data, "got a frame");
    // The toplevel is 128x128 at (0,0); the harness output is 256x256.
    // At (100, 100): pointer position, hotspot (0,0). Cursor pixels span
    // [100, 116) x [100, 116). Expect green (BGRA: 0,255,0,255).
    const px = (x, y) => {
      const W = 256;
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    // Center of the cursor rect.
    const center = px(108, 108);
    assert.deepEqual(center, [0, 255, 0, 255],
      `cursor pixels at (108,108) should be green, got [${center.join(",")}]`);
    // A point clearly inside the toplevel but outside the cursor: red.
    const outside = px(30, 30);
    assert.deepEqual(outside, [0, 0, 255, 255],
      `toplevel pixels at (30,30) should be red, got [${outside.join(",")}]`);
  } finally {
    await c.teardown();
  }
});
