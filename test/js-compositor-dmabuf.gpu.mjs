// Slice 2: a real dmabuf client (zero-copy GBM buffer) composited by the JS
// compositor. The dmabuf commit routes through the protocol path to
// JsCompositor.commitSurfaceDmabuf -> native createTextureFromDmabuf (async
// reserve/inject) -> dawn.node wrapTexture -> sampled in the JS render pass.
// Verifies the imported dmabuf shows correct pixels. Requires GPU + host Wayland
// + DRM render node + bundled dawn.node.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { setupCompositor, canRunGpu, loadDawn, buildBin, pixelAt, pixelMatches } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (WAYLAND_DISPLAY unset)"
  : (!loadDawn() ? "dawn.node not built" : false);
const OUT = { width: 1280, height: 720 };
const RED_BGRA = [0, 0, 255, 255]; // ARGB 0xFFFF0000 -> BGRA readback

test("JS compositor: real dmabuf client composites (red)", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  let client = null;
  try {
    // dmabuf-test-client takes the socket positionally and holds ~400ms.
    client = spawn(buildBin("dmabuf-test-client"), [c.sock], { stdio: ["ignore", "pipe", "pipe"] });

    // Wait for the window to map (import completed + placed by the WM).
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1,
      { what: "dmabuf window", timeoutMs: 3000 });
    const w = snap.windows[0];
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);

    let px = null;
    for (let i = 0; i < 20; i++) {
      px = await c.frameReadback();
      if (px && pixelMatches(pixelAt(px, OUT.width, cx, cy), RED_BGRA, 4)) break;
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(px, "got a frame");
    assert.ok(pixelMatches(pixelAt(px, OUT.width, cx, cy), RED_BGRA, 4),
      `dmabuf surface center should be red; got ${pixelAt(px, OUT.width, cx, cy)}`);
  } finally {
    // Fully reap the client before teardown so it never overlaps the
    // GPU-process leak scan.
    if (client) {
      try { client.kill("SIGTERM"); } catch { /* gone */ }
      await once(client, "exit").catch(() => {});
    }
    await c.teardown();
  }
});
