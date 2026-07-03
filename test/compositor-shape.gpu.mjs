// GPU pixel tests for the per-surface analytic shape (setSurfaceShape):
// rounded-rect, per-corner radii, superellipse. Runs the JS compositor
// headless over the Dawn wire and reads back composited pixels. Requires
// GPU + Dawn; skips otherwise.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

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
    const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

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

    await t.test("superellipse: squircle corners (localized), straight edges", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Squircle corners with extent 12px and exponent 4 (macOS-ish look).
      // The corner is localized to the (radius, radius) box; the rest of
      // the edge is a straight line of the rectangle.
      comp.setSurfaceShape(1, { kind: "superellipse", exponent: 4, radius: 12 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // Near-corner pixel is clipped (inside the corner-extent box, the
      // squircle curve excludes the outermost pixel).
      assert.equal(at(data, 1, 1)[2], 0, "TL near-corner is clipped");
      assert.equal(at(data, SZ - 2, 1)[2], 0, "TR near-corner is clipped");
      assert.equal(at(data, 1, SZ - 2)[2], 0, "BL near-corner is clipped");
      assert.equal(at(data, SZ - 2, SZ - 2)[2], 0, "BR near-corner is clipped");
      // Mid-edge: outside the (radius, radius) corner box, the shape is a
      // straight rectangle edge -- so a mid-edge pixel right at the edge
      // stays red.
      assert.equal(at(data, SZ / 2, 1)[2], 255, "mid-top edge stays red");
      assert.equal(at(data, SZ / 2, SZ - 2)[2], 255, "mid-bottom edge stays red");
      assert.equal(at(data, 1, SZ / 2)[2], 255, "mid-left edge stays red");
      assert.equal(at(data, SZ - 2, SZ / 2)[2], 255, "mid-right edge stays red");
      // Center stays red.
      assert.equal(at(data, SZ / 2, SZ / 2)[2], 255, "center stays red");
    });

    await t.test("superellipse: radius=0 means no rounding (effective rect)", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceShape(1, { kind: "superellipse", exponent: 5, radius: 0 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // All four corners stay red -- corner extent is 0, no curve to apply.
      assert.equal(at(data, 0, 0)[2], 255, "TL stays red (no rounding)");
      assert.equal(at(data, SZ - 1, 0)[2], 255, "TR stays red");
      assert.equal(at(data, 0, SZ - 1)[2], 255, "BL stays red");
      assert.equal(at(data, SZ - 1, SZ - 1)[2], 255, "BR stays red");
    });

    await t.test("superellipse exponent=2 matches rounded-rect (circular arc baseline)", async () => {
      // Under the new model, exponent=2 reduces to a circular arc corner --
      // i.e. the squircle SDF degenerates to a quarter-circle. So a squircle
      // with exponent=2 and a rounded-rect with the same radius should
      // produce visually-equivalent corner clipping.
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // The straight-edge midpoints + center stay red for both shapes;
      // the near-corner pixels are clipped for both. Stronger test:
      // assert the squircle case shows clipping at the same near-corner
      // pixels rounded-rect does.
      comp.setSurfaceShape(1, { kind: "superellipse", exponent: 2, radius: 12 });
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.equal(at(data, 1, 1)[2], 0, "TL corner clipped (n=2)");
      assert.equal(at(data, SZ / 2, 1)[2], 255, "mid-top stays red (n=2)");
    });

    await t.test("subsurface inherits + is clipped by the parent window's rounded shape", async () => {
      // Firefox renders its whole content as ONE full-window subsurface. The
      // parent (shaped) window's rounded corners must clip that subsurface, or
      // its square corners escape the decoration.
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const green = solid([0, 255, 0, 255], SZ, SZ);
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.uploadPixels(2, { width: SZ, height: SZ, stride: green.stride }, green.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setSurfaceLayout(2, 0, 0, SZ, SZ);           // covers the window
      comp.setSubsurfaceAccessor({ children: (p) => (p === 1 ? [{ id: 2, offX: 0, offY: 0 }] : []) });
      comp.setStack([1, 2]);                             // child (2) above parent (1)
      comp.setSurfaceShape(1, { kind: "rounded-rect", radius: 12 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // The child (green) is on top and covers the window; at a corner BOTH the
      // child and the parent are clipped by the window shape -> black.
      const tl = at(data, 1, 1);
      assert.equal(tl[1], 0, `child TL corner clipped (green==0); got ${tl}`);
      assert.equal(tl[2], 0, `parent clipped there too (red==0); got ${tl}`);
      assert.equal(at(data, SZ - 2, 1)[1], 0, "child TR corner clipped");
      assert.equal(at(data, 1, SZ - 2)[1], 0, "child BL corner clipped");
      assert.equal(at(data, SZ - 2, SZ - 2)[1], 0, "child BR corner clipped");
      // Interior + mid-edge of the child stay green (unclipped).
      assert.equal(at(data, SZ / 2, SZ / 2)[1], 255, "child center stays green");
      assert.equal(at(data, SZ / 2, 1)[1], 255, "child mid-top edge stays green");
    });

    await t.test("partial subsurface clipped only where it overlaps a window corner", async () => {
      // A subsurface covering just the bottom-right quadrant: its OUTER corner
      // (the window's BR corner) is clipped; its INNER corner (window interior)
      // is not -- proves the surfUV->windowUV offset map.
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const q = SZ / 2;                                  // 32
      const green = solid([0, 255, 0, 255], q, q);
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.uploadPixels(2, { width: q, height: q, stride: q * 4 }, green.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setSurfaceLayout(2, q, q, q, q);              // BR quadrant of the window
      comp.setSubsurfaceAccessor({ children: (p) => (p === 1 ? [{ id: 2, offX: q, offY: q }] : []) });
      comp.setStack([1, 2]);
      comp.setSurfaceShape(1, { kind: "rounded-rect", radius: 12 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // Window BR corner (framebuffer (SZ-1,SZ-1)) overlaps the child -> clipped.
      assert.equal(at(data, SZ - 2, SZ - 2)[1], 0, "child outer (window-BR) corner clipped");
      // Child's inner corner sits at the window center -> interior -> green.
      assert.equal(at(data, q + 1, q + 1)[1], 255, "child inner corner (window interior) stays green");
    });

    await t.test("shaped 0x0 container clips its full-window content subsurface (Firefox structure)", async () => {
      // Firefox's shaped surface is an empty 0x0 container; its content is a
      // full-window subsurface. The container footprint is degenerate, so the
      // content must clip to its OWN rect with the container's shape.
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const green = solid([0, 255, 0, 255], SZ, SZ);
      comp.uploadPixels(2, { width: SZ, height: SZ, stride: green.stride }, green.data);
      comp.setSurfaceLayout(1, 0, 0, 0, 0);   // 0x0 container (draws nothing itself)
      comp.setSurfaceLayout(2, 0, 0, SZ, SZ);
      comp.setSubsurfaceAccessor({ children: (p) => (p === 1 ? [{ id: 2, offX: 0, offY: 0 }] : []) });
      comp.setStack([2]);                       // only the content surface draws
      comp.setSurfaceShape(1, { kind: "rounded-rect", radius: 12 });
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.equal(at(data, 1, 1)[1], 0, "content TL corner clipped by container shape");
      assert.equal(at(data, SZ - 2, 1)[1], 0, "content TR corner clipped");
      assert.equal(at(data, SZ - 2, SZ - 2)[1], 0, "content BR corner clipped");
      assert.equal(at(data, SZ / 2, SZ / 2)[1], 255, "content center stays green");
      assert.equal(at(data, SZ / 2, 1)[1], 255, "content mid-top edge stays green");
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
