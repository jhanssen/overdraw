// GPU pixel tests for the per-surface analytic shape (setSurfaceShape):
// rounded-rect, per-corner radii, superellipse. Runs the JS compositor
// headless over the Dawn wire and reads back composited pixels. Requires
// GPU + Dawn; skips otherwise.

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

const W = 128, H = 128, SZ = 64;
const skip = !dawn ? "dawn.node not built" : false;

function solid(fillBGRA, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = fillBGRA[0]; buf[i + 1] = fillBGRA[1];
    buf[i + 2] = fillBGRA[2]; buf[i + 3] = fillBGRA[3];
  }
  return { data: buf, stride };
}

const px = (data, x, y) => {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

// Coordinates: the surface is placed at (0,0)-(SZ,SZ). Sample the surface's
// pixel at (sx,sy) (in surface-local px) by reading the framebuffer at the
// same coords (the surface is anchored at the framebuffer origin).
const at = (data, sx, sy) => px(data, sx, sy);

test("per-surface analytic shape (setSurfaceShape)", { skip }, async (t) => {
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import(join(OD, "dist", "gpu", "compositor.js"));

    const red = solid([0, 0, 255, 255], SZ, SZ);  // opaque red BGRA

    await t.test("rounded-rect: surface corners go to the clear (black), center stays red", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Baseline: rectangle. The whole 64x64 region is red.
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(at(data, 0, 0), [0, 0, 255, 255],
        "rect baseline: top-left corner is red");
      assert.deepEqual(at(data, SZ - 1, SZ - 1), [0, 0, 255, 255],
        "rect baseline: bottom-right corner is red");
      assert.deepEqual(at(data, SZ / 2, SZ / 2), [0, 0, 255, 255],
        "rect baseline: center is red");

      // Rounded with a radius of 12px. The corner pixel (well inside the
      // arc) should be clear (black); the center should remain red.
      comp.setSurfaceShape(1, { kind: "rounded-rect", radius: 12 });
      comp.renderFrame();
      ({ data } = await comp.readback());
      const tl = at(data, 1, 1);
      assert.equal(tl[2], 0, `top-left near-corner red==0; got ${tl}`);
      assert.equal(tl[3], 255, `top-left framebuffer alpha (cleared) is 1`);
      const tr = at(data, SZ - 2, 1);
      assert.equal(tr[2], 0, `top-right near-corner red==0; got ${tr}`);
      const br = at(data, SZ - 2, SZ - 2);
      assert.equal(br[2], 0, `bottom-right near-corner red==0; got ${br}`);
      const bl = at(data, 1, SZ - 2);
      assert.equal(bl[2], 0, `bottom-left near-corner red==0; got ${bl}`);
      const c = at(data, SZ / 2, SZ / 2);
      assert.equal(c[2], 255, `center red==255; got ${c}`);

      // A mid-edge pixel (well away from any corner) stays inside the
      // rounded rect -> red.
      const midTop = at(data, SZ / 2, 1);
      assert.equal(midTop[2], 255, `mid-top edge stays red; got ${midTop}`);

      // Clearing the shape restores the full rect.
      comp.setSurfaceShape(1, null);
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(at(data, 1, 1), [0, 0, 255, 255],
        "after setSurfaceShape(null): corner is red again");
    });

    await t.test("rounded-rect-per-corner: only the specified corners are rounded", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Round only the top corners; the bottom corners stay square.
      comp.setSurfaceShape(1, {
        kind: "rounded-rect-per-corner",
        tl: 12, tr: 12, br: 0, bl: 0,
      });
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.equal(at(data, 1, 1)[2], 0, "TL corner is clipped");
      assert.equal(at(data, SZ - 2, 1)[2], 0, "TR corner is clipped");
      assert.equal(at(data, 1, SZ - 1)[2], 255, "BL corner stays red (square)");
      assert.equal(at(data, SZ - 1, SZ - 1)[2], 255, "BR corner stays red (square)");
    });

    await t.test("superellipse: rounds the corners with a fatter middle than rounded-rect", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // A squircle: exponent 4 makes a recognizable fat-corner shape. Same
      // top-left near-corner pixel should still be clipped, while the
      // center stays red.
      comp.setSurfaceShape(1, { kind: "superellipse", exponent: 4, radius: 0 });
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.equal(at(data, 0, 0)[2], 0, "TL outermost corner is clipped");
      assert.equal(at(data, SZ / 2, SZ / 2)[2], 255, "center stays red");
      // Mid-edge: a squircle's edge bulges out to nearly touch the rect bound,
      // so a mid-edge pixel one in from the edge should still be inside.
      assert.equal(at(data, SZ / 2, 1)[2], 255, "mid-edge stays red");
    });

    await t.test("shape composes with opacity (multiplicative)", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);
      comp.setSurfaceShape(1, { kind: "rounded-rect", radius: 12 });
      comp.setSurfaceOpacity(1, 0.5);
      comp.renderFrame();
      const { data } = await comp.readback();
      // Corner still clipped to black (shape coverage 0).
      assert.equal(at(data, 1, 1)[2], 0, "corner still clipped");
      // Center premultiplied to ~128 red by opacity.
      const c = at(data, SZ / 2, SZ / 2);
      assert.ok(Math.abs(c[2] - 128) <= 2, `center red ~128, got ${c[2]}`);
    });
  } finally {
    addon.stop();
  }
});
