// wl_surface.set_buffer_transform rendering verification (headless readback).
// A 4-quadrant buffer (TL red, TR green, BL blue, BR white) is drawn at each
// of the 8 wl_output.transform orientations; the compositor samples with the
// transform's inverse, so the displayed corners are the spec-defined result.
// Expected tables derived from "the compositor applies the inverse of the
// client's transform" (wl_surface.set_buffer_transform). Requires the GPU.

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

const W = 64, H = 64;
const R = [0, 0, 255, 255], G = [0, 255, 0, 255], B = [255, 0, 0, 255], Wh = [255, 255, 255, 255];

function quads() {
  const w = 64, h = 64, stride = w * 4, buf = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = y < 32 ? (x < 32 ? R : G) : (x < 32 ? B : Wh);
    const i = (y * w + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  }
  return { data: buf, stride };
}

// [TL, TR, BL, BR] expected per transform 0..7.
const EXPECT = [
  [R, G, B, Wh],   // 0 normal
  [B, R, Wh, G],   // 1 90
  [Wh, B, G, R],   // 2 180
  [G, Wh, R, B],   // 3 270
  [G, R, Wh, B],   // 4 flipped
  [R, B, G, Wh],   // 5 flipped_90
  [B, Wh, R, G],   // 6 flipped_180
  [Wh, G, B, R],   // 7 flipped_270
];
const NAMES = ["normal", "90", "180", "270", "flipped", "flipped_90", "flipped_180", "flipped_270"];

test("wl_surface.set_buffer_transform: all 8 orientations sample correctly",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    const comp = new JsCompositor(dawn.wrapDevice(h.instance, h.device), dawn.globals, addon, { width: W, height: H });
    const q = quads();
    comp.uploadPixels(1, { width: 64, height: 64, stride: q.stride }, q.data);
    comp.setSurfaceLayout(1, 0, 0, 64, 64);
    comp.setStack([1]);
    for (let t = 0; t < 8; t++) {
      comp.setSurfaceBufferTransform(1, t);
      comp.renderFrame();
      const { data } = await comp.readback();
      const px = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
      const [tl, tr, bl, br] = EXPECT[t];
      assert.deepEqual(px(8, 8), tl, `${NAMES[t]} TL`);
      assert.deepEqual(px(56, 8), tr, `${NAMES[t]} TR`);
      assert.deepEqual(px(8, 56), bl, `${NAMES[t]} BL`);
      assert.deepEqual(px(56, 56), br, `${NAMES[t]} BR`);
    }
  } finally {
    addon.stop();
  }
});
