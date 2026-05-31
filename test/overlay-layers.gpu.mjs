// C-M3 part 1: the stack-layer model (background < below < content < above <
// overlay). Proves layer ordering through the REAL JS compositor render pass
// (headless, pixel readback): a surface in the `overlay` layer composites ON TOP
// of a content surface at the same rect; placed in `below` it composites UNDER.
// This is the substrate plugin overlays (C-M4) compose into.
//
// Requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..");

const addon = require(join(OD, "build", "overdraw_native.node"));
let dawn = null;
try {
  const [p] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  if (p) dawn = require(p);
} catch { dawn = null; }
const gpuBin = join(OD, "build", "overdraw-gpu-process");

const W = 128, H = 128, SZ = 64;

function solid(fillBGRA, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = fillBGRA[0]; buf[i + 1] = fillBGRA[1]; buf[i + 2] = fillBGRA[2]; buf[i + 3] = fillBGRA[3];
  }
  return { data: buf, stride };
}

test("stack layers compose in order (overlay over content, below under)",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    const red = solid([0, 0, 255, 255], SZ, SZ);     // BGRA red  -> content
    const green = solid([0, 255, 0, 255], SZ, SZ);    // BGRA green -> overlay
    // Both occupy the SAME rect (0,0,SZ,SZ); the layer order decides who wins.
    comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
    comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
    comp.uploadPixels(2, { width: SZ, height: SZ, stride: green.stride }, green.data);
    comp.setSurfaceLayout(2, 0, 0, SZ, SZ);

    // surface 1 in content, surface 2 in overlay -> overlay (green) wins.
    comp.setStack([1]);
    comp.setLayerSurfaces("overlay", [2]);
    comp.renderFrame();
    let { data } = await comp.readback();
    const px = (d, x, y) => { const i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
    assert.deepEqual(px(data, 32, 32), [0, 255, 0, 255], "overlay (green) over content (red)");

    // Move surface 2 to `below` instead -> content (red) now wins at the overlap.
    comp.setLayerSurfaces("overlay", []);
    comp.setLayerSurfaces("below", [2]);
    comp.renderFrame();
    ({ data } = await comp.readback());
    assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "content (red) over below (green)");
  } finally {
    addon.stop();
  }
});
