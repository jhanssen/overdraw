// Slice 1b: the JS compositor (src/gpu/compositor.ts) driven through the REAL
// protocol path — a real libwayland shm client commits, the protocol layer
// routes the commit to JsCompositor.commitSurfaceBuffer (zero-copy via
// addon.shmView), and the composited offscreen frame reads back correct pixels.
// This exercises shmView end-to-end and proves the compositor seam works with
// the JS backend. Requires GPU + host Wayland + the bundled dawn.node.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, loadDawn, pixelAt, pixelMatches } from "./harness.mjs";

const skip = !canRunGpu() ? "needs GPU (WAYLAND_DISPLAY unset)"
  : (!loadDawn() ? "dawn.node not built" : false);
const OUT = { width: 1280, height: 720 };

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff, a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
const BLACK = [0, 0, 0, 255];

async function readWhenComposited(c, expect, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const px = await c.frameReadback();
    if (px && pixelMatches(pixelAt(px, OUT.width, expect.x, expect.y), expect.bgra, 4)) return px;
    await new Promise((r) => setTimeout(r, 16));
  }
  return c.frameReadback();
}

test("JS compositor (via protocol path): real shm client composites at its rect", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, jsCompositor: true });
  try {
    const color = 0xff2080c0;
    const bgra = argbToBgra(color);
    const { ready } = c.spawnClient(["--size", "300x200", "--color", color.toString(16)]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });
    const w = snap.windows[0];
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);

    const px = await readWhenComposited(c, { x: cx, y: cy, bgra });
    assert.ok(px, "got a frame");
    assert.ok(pixelMatches(pixelAt(px, OUT.width, cx, cy), bgra, 4),
      `center should be the client color; got ${pixelAt(px, OUT.width, cx, cy)}`);
    const ox = Math.min(OUT.width - 1, w.rect.x + w.rect.width + 100);
    const oy = Math.min(OUT.height - 1, w.rect.y + w.rect.height + 100);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, ox, oy), BLACK, 4),
      `outside should be black; got ${pixelAt(px, OUT.width, ox, oy)}`);
  } finally {
    await c.teardown();
  }
});
