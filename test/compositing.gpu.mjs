// Headless compositing tests: render the placed + stacked + blended output into
// an offscreen texture and verify pixels against a COMPUTED expectation (each
// client is a known solid color at a known rect from query()). Supersedes the
// interactive compositing-eyeball test. No host Wayland window; requires the GPU.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };

// ARGB 0xFFRRGGBB as the client stores it -> BGRA readback bytes [B,G,R,A].
function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff, a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

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

// Clients use --fill-configured so they resize to the compositor-assigned tile
// (tiling owns geometry). This also exercises the configure -> client-resize ->
// recommit loop that proactive configure depends on.
const FILL = "--fill-configured";

test("headless: single client fills its (full-output) tile; pixels match", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xff2080c0; // opaque, distinctive
    const bgra = argbToBgra(color);
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });
    const w = snap.windows[0];
    // Single window tiles to the full output.
    assert.equal(w.rect.width, OUT.width);
    assert.equal(w.rect.height, OUT.height);
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);

    const px = await readWhenComposited(c, { x: cx, y: cy, bgra });
    assert.ok(px, "got a frame");
    assert.ok(pixelMatches(pixelAt(px, OUT.width, cx, cy), bgra, 4),
      `center should be the client color; got ${pixelAt(px, OUT.width, cx, cy)}`);
    // Near a corner of the (full-output) tile is still the client color.
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 5, 5), bgra, 4),
      `tile corner should be the client color; got ${pixelAt(px, OUT.width, 5, 5)}`);
  } finally {
    await c.teardown();
  }
});

test("headless: two clients tile side-by-side; each fills its half", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, layout: { masterFraction: 0.5, gap: 0 } });
  try {
    const cA = 0xff3030c0, cB = 0xff30c030;
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]); await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "first" });
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]); await b.ready;
    // Wait for both windows to be present + the layout's resize transaction
    // to settle (each client must re-render at its new tile size before the
    // WM commits the geometry; see wm/index.ts applyLayout transaction path).
    // Poll on tile width: master tiles at masterFraction=0.5 -> 640px wide.
    const settled = await c.waitFor(c.query,
      (s) => s.windows.length === 2 && s.windows.every((w) => w.rect.width === 640),
      { what: "two tiles settled at 640px" });

    // windows[0] = master (newest = B), windows[1] = stack (A).
    const master = settled.windows[0];   // B, left half
    const stack = settled.windows[1];    // A, right half
    const bgraMaster = argbToBgra(cB);
    const bgraStack = argbToBgra(cA);

    const mc = { x: master.rect.x + (master.rect.width >> 1), y: master.rect.y + (master.rect.height >> 1) };
    const sc = { x: stack.rect.x + (stack.rect.width >> 1), y: stack.rect.y + (stack.rect.height >> 1) };

    // Wait until both tiles have filled (poll the master, then verify both).
    await readWhenComposited(c, { x: mc.x, y: mc.y, bgra: bgraMaster });
    const px = await readWhenComposited(c, { x: sc.x, y: sc.y, bgra: bgraStack });

    assert.ok(pixelMatches(pixelAt(px, OUT.width, mc.x, mc.y), bgraMaster, 4),
      `master tile center should be B; got ${pixelAt(px, OUT.width, mc.x, mc.y)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, sc.x, sc.y), bgraStack, 4),
      `stack tile center should be A; got ${pixelAt(px, OUT.width, sc.x, sc.y)}`);
    // Tiles do not overlap: master is entirely left of stack.
    assert.ok(master.rect.x + master.rect.width <= stack.rect.x, "tiles are side-by-side, no overlap");
  } finally {
    await c.teardown();
  }
});
