// wp_viewport source-crop rendering verification (headless JsCompositor +
// one readback). A 4-quadrant buffer is cropped via setSurfaceViewport on
// three surfaces in a single frame, proving: the src -> cropUV conversion,
// the Y/X orientation (a flip would sample the wrong quadrant), and the
// size-from-source rule (src set, dst unset -> surface logical size = src).
//
// One renderFrame + one comp.readback() only: repeated headless readbacks
// without advancing the device queue between them busy-spin (the nested
// frameReadback path is the multi-frame one). Requires the GPU; skips if
// dawn.node is absent.

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

const W = 128, H = 128;
const RED = [0, 0, 255, 255], GREEN = [0, 255, 0, 255];
const BLUE = [255, 0, 0, 255], WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];

// 64x64 buffer split into quadrants: TL red, TR green, BL blue, BR white (BGRA).
function quads() {
  const w = 64, h = 64, stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = y < 32 ? (x < 32 ? RED : GREEN) : (x < 32 ? BLUE : WHITE);
      const i = (y * w + x) * 4;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
    }
  }
  return { data: buf, stride };
}

test("wp_viewport source crop: conversion, orientation, size-from-source",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const handles = addon.gpuHandles();
    const device = dawn.wrapDevice(handles.instance, handles.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
    const q = quads();
    const up = (id) => comp.uploadPixels(id, { width: 64, height: 64, stride: q.stride }, q.data);

    // S1 @ (0,0,64,64), crop TOP-LEFT -> whole rect red (bottom-of-rect red
    // proves no v-flip; it would otherwise sample bottom-left = blue).
    up(1); comp.setSurfaceLayout(1, 0, 0, 64, 64);
    comp.setSurfaceViewport(1, null, { x: 0, y: 0, width: 32, height: 32 });

    // S2 @ (64,0,64,64), crop BOTTOM-RIGHT -> white (both axes: a flip would
    // pick green/blue instead).
    up(2); comp.setSurfaceLayout(2, 64, 0, 64, 64);
    comp.setSurfaceViewport(2, null, { x: 32, y: 32, width: 32, height: 32 });

    // S3 @ (0,64) with NO layout size (layoutW/H = 0) and a 32x32 source crop,
    // no destination. Size-from-source => the surface is 32x32 (not 64x64).
    up(3); comp.setSurfaceLayout(3, 0, 64, 0, 0);
    comp.setSurfaceViewport(3, null, { x: 0, y: 0, width: 32, height: 32 });

    comp.setStack([1, 2, 3]);
    comp.renderFrame();
    const { data } = await comp.readback();
    const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };

    // S1: TL crop fills the rect, top and bottom both red.
    assert.deepEqual(px(8, 8), RED, "S1 TL crop: top red");
    assert.deepEqual(px(8, 56), RED, "S1 TL crop: bottom red (no v-flip)");
    assert.deepEqual(px(56, 56), RED, "S1 TL crop: fills rect");
    // S2: BR crop -> white across both axes.
    assert.deepEqual(px(72, 8), WHITE, "S2 BR crop: white");
    assert.deepEqual(px(120, 56), WHITE, "S2 BR crop: white fills rect");
    // S3: size-from-source -> 32x32 red at (0,64); outside is background black.
    assert.deepEqual(px(8, 72), RED, "S3: inside 32x32 = cropped red");
    assert.deepEqual(px(40, 72), BLACK, "S3: x>32 outside surface = black");
    assert.deepEqual(px(8, 104), BLACK, "S3: y>32 outside surface = black");

    // surfaceReadyAt (the WM resize-transaction "is this buffer drawable at the
    // new size yet?" gate) judges readiness in LOGICAL space, NOT buffer pixels.
    // A viewport/fractional-scale client picks its own buffer resolution, so a
    // buffer-pixel equality gate would never pass and would stall the held
    // transaction forever (the Firefox-on-top-of-Chrome bug). S1's 64x64 buffer
    // has a 32x32 source crop, so its logical size is 32x32 (size-from-source).
    // uploadPixels is an shm-style helper that leaves currentBufferId at 0 (the
    // real wl_buffer attach path sets it); surfaceReadyAt requires a live buffer.
    comp.surfaces.get(1).currentBufferId = 1;
    assert.equal(comp.surfaceReadyAt(1, 32, 32), true, "ready at viewport logical size");
    assert.equal(comp.surfaceReadyAt(1, 64, 64), false, "NOT ready at raw buffer pixels");
    // A viewport DESTINATION decouples logical size from the buffer outright.
    comp.setSurfaceViewport(1, { width: 50, height: 40 }, null);
    assert.equal(comp.surfaceReadyAt(1, 50, 40), true, "ready at viewport dst (logical)");
    assert.equal(comp.surfaceReadyAt(1, 64, 64), false, "still NOT ready at buffer pixels");
  } finally {
    addon.stop();
  }
});
