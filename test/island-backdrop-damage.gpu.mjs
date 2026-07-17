// Island-backdrop damage accounting, headless. Removing a backdrop (a pure
// shrink of the setIslandBackdrops list) must record damage: the next frame
// has to repaint the vacated region. The regression this guards: a shrink-only
// update recorded no damage, so a subsequent partial frame (scissored to
// unrelated damage) preserved the dead backdrop's pixels in the target -- a
// ghost grey quad that persisted until some other change forced a full
// repaint.
//
// The unrelated corner-surface commit in frame 2 is load-bearing: an empty
// damage ring falls back to a full repaint (which would clean the ghost by
// accident), so the ghost only manifests when the frame is scissored to some
// small unrelated box.
//
// Run: npm run test:gpu

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128, CORNER = 16;
const BLUE = [255, 0, 0, 255];   // BGRA opaque blue
const RED = [0, 0, 255, 255];    // BGRA opaque red
const GREY = [128, 128, 128, 255];
const BLACK = [0, 0, 0, 255];

function solid(bgra, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1]; buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return { data: buf, stride };
}

test("backdrop removal damages its region: no ghost after a shrink-only update", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    // A small surface in the top-left corner, and one opaque grey backdrop
    // in the middle of the output.
    const blue = solid(BLUE, CORNER, CORNER);
    comp.uploadPixels(1, { width: CORNER, height: CORNER, stride: blue.stride }, blue.data);
    comp.setSurfaceLayout(1, 0, 0, CORNER, CORNER);
    comp.setStack([1]);
    comp.setIslandBackdrops([
      { x: 64, y: 64, width: 32, height: 32, color: { r: 128, g: 128, b: 128, a: 255 } },
    ]);

    // Frame 1: first frame for the headless slot -> full repaint.
    comp.renderFrame();
    let { data } = await comp.readback();
    const px = (d, x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    assert.deepEqual(px(data, 8, 8), BLUE, "frame1 corner surface = blue");
    assert.deepEqual(px(data, 80, 80), GREY, "frame1 backdrop = grey");

    // Frame 2: remove the backdrop (shrink-only update) and commit new content
    // to the corner surface so the frame is partial, scissored to the corner.
    comp.setIslandBackdrops([]);
    const red = solid(RED, CORNER, CORNER);
    comp.uploadPixels(1, { width: CORNER, height: CORNER, stride: red.stride }, red.data);
    comp.renderFrame();
    ({ data } = await comp.readback());

    assert.deepEqual(px(data, 8, 8), RED, "corner surface redrawn = red");
    // The backdrop's old region must be repainted (background black), not a
    // preserved grey ghost.
    assert.deepEqual(px(data, 80, 80), BLACK, "removed backdrop leaves no ghost");
  } finally {
    addon.stop();
  }
});
