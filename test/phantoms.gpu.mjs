// Phase 9a step 1: compositor-direct test for the closing-phantom
// snapshot + draw-order inclusion. Drives JsCompositor.createClosingPhantom
// + destroyClosingPhantom against a single surface and verifies:
//
//   1. The phantom appears in the on-screen output at the original
//      surface's rect (the snapshot matches the source's pixels).
//   2. destroyClosingPhantom removes it from drawOrder + frees the
//      texture.
//   3. The phantom draws ABOVE the content layer (so it would mask
//      a survivor that reflowed into its tile).
//
// Run isolated (this is GPU pipeline machinery; no plugin SDK yet).

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const OUT = { width: 320, height: 240 };

// Write a solid-color BGRA texture using the compositor's coreDevice.
function solidTexture(c, bgra, w, h) {
  const tex = c.coreDevice.createTexture({
    size: { width: w, height: h },
    format: "bgra8unorm",
    usage: c.dawn.globals.GPUTextureUsage.TEXTURE_BINDING
         | c.dawn.globals.GPUTextureUsage.COPY_DST,
  });
  const row = new Uint8Array(w * 4);
  for (let i = 0; i < w; i++) {
    row[i * 4 + 0] = bgra[0];
    row[i * 4 + 1] = bgra[1];
    row[i * 4 + 2] = bgra[2];
    row[i * 4 + 3] = bgra[3];
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(row, y * w * 4);
  c.coreDevice.queue.writeTexture(
    { texture: tex },
    data,
    { bytesPerRow: w * 4, rowsPerImage: h },
    { width: w, height: h },
  );
  return tex;
}

async function frame(c) {
  c.jsCompositor.renderFrame();
  return c.frameReadback();
}

const RED = [0, 0, 0xff, 0xff];
const BLUE = [0xff, 0, 0, 0xff];

test("createClosingPhantom: snapshot of one surface displays at its original rect",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    // Fake source surface: id 100, a 100x80 red region at (50, 30).
    const sourceId = 100;
    const sourceTex = solidTexture(c, RED, 100, 80);
    c.jsCompositor.setSurfaceLayout(sourceId, 50, 30, 100, 80);
    c.jsCompositor.setSurfaceTexture(sourceId, sourceTex, 100, 80);
    c.jsCompositor.setStack([sourceId]);

    // Baseline: red rect on screen at (50,30,100,80).
    let px = await frame(c);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 100, 70), RED, 4),
      `baseline: source red at center; got ${pixelAt(px, OUT.width, 100, 70)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 10, 10), [0, 0, 0, 0xff], 4),
      `baseline: clear-color outside source`);

    // Snapshot. The phantom should appear at the same rect, with the
    // same red pixels.
    const phantomId = 999;
    c.jsCompositor.createClosingPhantom({
      phantomSurfaceId: phantomId,
      surfaceIds: [sourceId],
      outerRect: { x: 50, y: 30, w: 100, h: 80 },
    });

    // Remove the original surface so we know the on-screen red is
    // coming from the phantom, not the original.
    c.jsCompositor.removeSurface(sourceId);
    c.jsCompositor.setStack([]);

    // With phantom only (no content), the screen should still show
    // red at (50..150, 30..110) because the phantom is in drawOrder.
    px = await frame(c);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 100, 70), RED, 4),
      `phantom: red at center; got ${pixelAt(px, OUT.width, 100, 70)}`);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 10, 10), [0, 0, 0, 0xff], 4),
      `phantom: clear-color outside`);
    assert.deepEqual(c.jsCompositor.activePhantomIds(), [phantomId]);

    // Destroy the phantom; screen returns to clear color everywhere.
    c.jsCompositor.destroyClosingPhantom(phantomId);
    assert.deepEqual(c.jsCompositor.activePhantomIds(), []);
    px = await frame(c);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 100, 70), [0, 0, 0, 0xff], 4),
      `after destroy: clear-color everywhere; got ${pixelAt(px, OUT.width, 100, 70)}`);

    sourceTex.destroy();
  } finally {
    await c.teardown();
  }
});

test("phantom draws above the content layer", { skip }, async () => {
  // Place a phantom over a content surface at the same screen rect;
  // the phantom's pixels should win (it's drawn on top per phase 9a's
  // z model).
  const c = await setupCompositor({ headless: OUT });
  try {
    // Content surface: 100x80 blue at (50,30).
    const contentId = 100;
    const contentTex = solidTexture(c, BLUE, 100, 80);
    c.jsCompositor.setSurfaceLayout(contentId, 50, 30, 100, 80);
    c.jsCompositor.setSurfaceTexture(contentId, contentTex, 100, 80);
    c.jsCompositor.setStack([contentId]);

    // Verify content is composited (blue).
    let px = await frame(c);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 100, 70), BLUE, 4),
      `content: blue at center`);

    // Now add a phantom-source: 100x80 red, also at (50,30). We
    // composite the phantom OUT of this source surface, then destroy
    // that source -- but the phantom owns its own texture, so the
    // image survives.
    const sourceId = 200;
    const sourceTex = solidTexture(c, RED, 100, 80);
    c.jsCompositor.setSurfaceLayout(sourceId, 50, 30, 100, 80);
    c.jsCompositor.setSurfaceTexture(sourceId, sourceTex, 100, 80);

    const phantomId = 999;
    c.jsCompositor.createClosingPhantom({
      phantomSurfaceId: phantomId,
      surfaceIds: [sourceId],
      outerRect: { x: 50, y: 30, w: 100, h: 80 },
    });
    c.jsCompositor.removeSurface(sourceId);  // clean up the source

    // Content stack still has the blue contentId. Phantom is on top
    // (above content per drawOrder); screen should show red.
    px = await frame(c);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 100, 70), RED, 4),
      `phantom on top of content: red at center; got ${pixelAt(px, OUT.width, 100, 70)}`);

    c.jsCompositor.destroyClosingPhantom(phantomId);

    // After destroy, content (blue) is visible again.
    px = await frame(c);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, 100, 70), BLUE, 4),
      `content visible again: blue at center`);

    // Tear down: remove the still-in-use content surface BEFORE
    // destroying its texture, so the addon's frame timer can't
    // encode a sample of a destroyed texture between here and
    // teardown.
    c.jsCompositor.removeSurface(contentId);
    sourceTex.destroy();
    contentTex.destroy();
  } finally {
    await c.teardown();
  }
});
