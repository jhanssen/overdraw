// Headless compositing tests: render the placed + stacked + blended output into
// an offscreen texture and verify pixels against a COMPUTED expectation (each
// client is a known solid color at a known rect from query()). Supersedes the
// interactive compositing-eyeball test. No host Wayland window; requires the GPU.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const OUT = { width: 1280, height: 720 };

// ARGB 0xFFRRGGBB as the client stores it -> BGRA readback bytes [B,G,R,A].
function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff, a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
const BLACK = [0, 0, 0, 255];

// Read the composited frame, retrying until the named surface's center shows the
// expected color (the first post-map frame may not have composited yet).
async function readWhenComposited(c, expectCenter /* {x,y,bgra} */, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const px = await c.frameReadback();
    if (px && pixelMatches(pixelAt(px, OUT.width, expectCenter.x, expectCenter.y), expectCenter.bgra, 4)) {
      return px;
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  return c.frameReadback();
}

test("headless: single client composites at its rect; background is black", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xff2080c0; // opaque, distinctive
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
    // A point well outside the window rect is background (black).
    const ox = Math.min(OUT.width - 1, w.rect.x + w.rect.width + 100);
    const oy = Math.min(OUT.height - 1, w.rect.y + w.rect.height + 100);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, ox, oy), BLACK, 4),
      `outside should be black; got ${pixelAt(px, OUT.width, ox, oy)}`);
  } finally {
    await c.teardown();
  }
});

test("headless: two clients at distinct positions both appear", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cA = 0xff3030c0, cB = 0xff30c030;
    const a = c.spawnClient(["--size", "300x200", "--color", cA.toString(16)]); await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "first" });
    const b = c.spawnClient(["--size", "300x200", "--color", cB.toString(16)]); await b.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "second" });

    const wA = snap.windows.find((w) => w.surfaceId === snap.stack[0]);
    const wB = snap.windows.find((w) => w.surfaceId === snap.stack[1]);
    const center = (w) => ({ x: w.rect.x + (w.rect.width >> 1), y: w.rect.y + (w.rect.height >> 1) });
    const pB = center(wB);
    const bgraB = argbToBgra(cB);

    // Wait until the top (second) window has composited at its center.
    const px = await readWhenComposited(c, { x: pB.x, y: pB.y, bgra: bgraB });
    assert.ok(pixelMatches(pixelAt(px, OUT.width, pB.x, pB.y), bgraB, 4),
      `window B center should be its color; got ${pixelAt(px, OUT.width, pB.x, pB.y)}`);
    // Sample A where B does NOT cover it: B is cascaded down-right of A, so A's
    // top-left interior is visible. (A's center can be under B for small offsets.)
    const aOnlyX = wA.rect.x + 5, aOnlyY = wA.rect.y + 5;
    assert.ok(aOnlyX < wB.rect.x || aOnlyY < wB.rect.y, "A has an uncovered top-left region");
    assert.ok(pixelMatches(pixelAt(px, OUT.width, aOnlyX, aOnlyY), argbToBgra(cA), 4),
      `window A (uncovered region) should be its color; got ${pixelAt(px, OUT.width, aOnlyX, aOnlyY)}`);
  } finally {
    await c.teardown();
  }
});

test("headless: top window wins in the overlap region (opaque stacking)", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const cBottom = 0xff0000ff, cTop = 0xff00ff00;
    const a = c.spawnClient(["--size", "400x400", "--color", cBottom.toString(16)]); await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "bottom" });
    const b = c.spawnClient(["--size", "400x400", "--color", cTop.toString(16)]); await b.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "top" });

    const bottom = snap.windows.find((w) => w.surfaceId === snap.stack[0]);
    const top = snap.windows.find((w) => w.surfaceId === snap.stack[1]);
    // Overlap rect = intersection of the two 400x400 rects (cascade offset 80).
    const ox = Math.max(bottom.rect.x, top.rect.x);
    const oy = Math.max(bottom.rect.y, top.rect.y);
    const ex = Math.min(bottom.rect.x + bottom.rect.width, top.rect.x + top.rect.width);
    const ey = Math.min(bottom.rect.y + bottom.rect.height, top.rect.y + top.rect.height);
    assert.ok(ex > ox && ey > oy, "rects overlap");
    const px = Math.floor((ox + ex) / 2), py = Math.floor((oy + ey) / 2);
    const bgraTop = argbToBgra(cTop);

    const frame = await readWhenComposited(c, { x: px, y: py, bgra: bgraTop });
    assert.ok(pixelMatches(pixelAt(frame, OUT.width, px, py), bgraTop, 4),
      `overlap should show the TOP window color (opaque); got ${pixelAt(frame, OUT.width, px, py)}`);
  } finally {
    await c.teardown();
  }
});
