// Composite-scissor (Layer 2) verification, headless. After a full first frame,
// a content-only change to ONE surface produces a partial frame: the unchanged
// surface is preserved (scissor + loadOp:load skip its region), the changed
// surface updates, and a transparent part of the new buffer shows the black-fill
// (proving the damaged region was cleared to black, not left with stale pixels).
//
// The headless offscreen target acts as a 1-slot damage ring (keyed by a fixed
// handle); the same code path serves the KMS scanout ring (keyed per slot).
//
// Run: npm run test:gpu

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "packages", "core");

const addon = require(join(OD, "build", "overdraw_native.node"));
let dawn = null;
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const W = 128, H = 128, HALF = 64;
const BLUE = [255, 0, 0, 255];   // BGRA opaque blue
const RED = [0, 0, 255, 255];    // BGRA opaque red
const BLACK = [0, 0, 0, 255];    // opaque black (the black-fill)

function solid(bgra, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1]; buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return { data: buf, stride };
}

// A HALF-wide buffer: left columns opaque red, right columns fully transparent.
function redLeftTransparentRight(w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < w / 2) { buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 255; buf[i + 3] = 255; } // red
      // else leave 0,0,0,0 (transparent)
    }
  }
  return { data: buf, stride };
}

test("partial frame: scissor preserves the untouched surface; black-fill clears the damaged region", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    const blue = solid(BLUE, HALF, H);

    // A = left half, B = right half, both opaque blue.
    comp.uploadPixels(1, { width: HALF, height: H, stride: blue.stride }, blue.data);
    comp.setSurfaceLayout(1, 0, 0, HALF, H);
    comp.uploadPixels(2, { width: HALF, height: H, stride: blue.stride }, blue.data);
    comp.setSurfaceLayout(2, HALF, 0, HALF, H);
    comp.setStack([1, 2]);

    // Frame 1: first frame for the (headless) slot -> full repaint.
    comp.renderFrame();
    let { data } = await comp.readback();
    const px = (d, x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    assert.deepEqual(px(data, 32, 64), BLUE, "frame1 left = blue");
    assert.deepEqual(px(data, 96, 64), BLUE, "frame1 right = blue");

    // Frame 2: change ONLY B's content (no stack/layout change) -> partial frame
    // scissored to B's rect. Left columns red, right columns transparent.
    const b2 = redLeftTransparentRight(HALF, H);
    comp.uploadPixels(2, { width: HALF, height: H, stride: b2.stride }, b2.data);
    comp.renderFrame();
    ({ data } = await comp.readback());

    // A (left half) was outside the scissor: preserved from frame 1.
    assert.deepEqual(px(data, 32, 64), BLUE, "A preserved (scissor + load skipped its region)");
    // B left columns: redrawn red.
    assert.deepEqual(px(data, HALF + 16, 64), RED, "B redrawn = red");
    // B right columns transparent -> black-fill shows (NOT stale blue). This is
    // the load-vs-clear discriminator: without the black-fill it would be blue.
    assert.deepEqual(px(data, HALF + 48, 64), BLACK, "transparent B reveals the black-fill, not stale pixels");
  } finally {
    addon.stop();
  }
});
