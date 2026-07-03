// GPU pixel tests for per-surface render-state primitives
// (setSurfaceOpacity / setSurfaceTransform / setSurfaceOutputMargin). Runs
// the JS compositor headless over the Dawn wire and reads back composited
// pixels. Requires GPU + Dawn; skips otherwise.
//
// All tests share a single addon.start()/stop() lifecycle: server bring-up
// is not safely repeatable in one process (uv__finish_close assertion on
// the second cycle; status.md "Known testing bugs"). The shared device
// hosts independent JsCompositor instances per test.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128, SZ = 64;
const skip = !dawn ? "dawn.node not built" : false;

// Solid-color BGRA8 surface as a Uint8Array (stride = w*4).
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

// All sub-tests run under one server lifecycle. Each sub-test gets its own
// JsCompositor (independent state) on the shared device.
test("per-surface render state primitives (opacity/transform/outputMargin)",
  { skip }, async (t) => {
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

    const red = solid([0, 0, 255, 255], SZ, SZ);  // opaque red

    await t.test("opacity=0.5 attenuates RGB by half (premultiplied)", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Default opacity = 1.
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "opacity=1: full red");

      // Premultiplied opacity 0.5: src rgb * 0.5; alpha of the composited
      // pixel is determined by the blend (src_a + dst_a*(1-src_a)) and the
      // opaque clear, so the framebuffer alpha stays 1.
      comp.setSurfaceOpacity(1, 0.5);
      comp.renderFrame();
      ({ data } = await comp.readback());
      const [b, g, r, a] = px(data, 32, 32);
      assert.equal(b, 0);
      assert.equal(g, 0);
      assert.ok(Math.abs(r - 128) <= 1, `red ~= 128 got ${r}`);
      assert.equal(a, 255, "framebuffer alpha is the blended alpha (1)");
    });

    await t.test("opacity=0 hides the surface (clear color shows through)", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceOpacity(1, 0);
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255], "opacity=0: black (clear)");
    });

    await t.test("opacity clamps outside [0,1]", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceOpacity(1, 5);
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "5 -> clamped to 1");

      comp.setSurfaceOpacity(1, -3);
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255], "-3 -> clamped to 0");
    });

    await t.test("transform translate moves the rendered quad", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceTransform(1, { translateX: 32, translateY: 32 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // Translated rect: x in [32, 96), y in [32, 96).
      assert.deepEqual(px(data, 64, 64), [0, 0, 255, 255], "center of translated rect");
      assert.deepEqual(px(data, 16, 16), [0, 0, 0, 255], "original top-left now black");
      assert.deepEqual(px(data, 33, 33), [0, 0, 255, 255], "translated top-left red");
    });

    await t.test("transform scale 2x doubles the rendered extent", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceTransform(1, { scaleX: 2, scaleY: 2 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // 2x scale anchored at the placement top-left (0,0) -> covers [0,128).
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "inside original rect");
      assert.deepEqual(px(data, 96, 96), [0, 0, 255, 255], "inside 2x-scaled rect");
    });

    await t.test("outputMargin: surface texture contributes only in [0,1] surface UV",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      // Place inset from edges so a 16px margin is fully on-screen.
      comp.setSurfaceLayout(1, 32, 32, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceOutputMargin(1, { top: 16, right: 16, bottom: 16, left: 16 });
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 48, 48), [0, 0, 255, 255], "inside surface = red");
      // Margin region: outside [0,1] surface UV -> surface contributes 0
      // (default mask is white, but rgb*a all multiplied by inside=0).
      assert.deepEqual(px(data, 24, 64), [0, 0, 0, 255], "left margin = black");
      assert.deepEqual(px(data, 64, 24), [0, 0, 0, 255], "top margin = black");
      assert.deepEqual(px(data, 8, 8), [0, 0, 0, 255], "far outside = black");
    });

    // Helper to build a mask texture from a per-pixel alpha callback.
    // Stores alpha in the .a channel of BGRA8 (the shader reads .a).
    function makeMask(w, h, alphaAt) {
      const stride = w * 4;
      const buf = new Uint8Array(stride * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          buf[i] = 0xff; buf[i+1] = 0xff; buf[i+2] = 0xff;  // rgb ignored
          buf[i+3] = alphaAt(x, y);
        }
      }
      const tex = device.createTexture({
        size: { width: w, height: h },
        format: "bgra8unorm",
        usage: dawn.globals.GPUTextureUsage.TEXTURE_BINDING
             | dawn.globals.GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture(
        { texture: tex }, buf,
        { bytesPerRow: stride, rowsPerImage: h },
        { width: w, height: h },
      );
      return tex;
    }

    await t.test("setSurfaceMask: opaque region renders, transparent region clears",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Mask: bottom-right half opaque, top-left half transparent.
      // Use surface-UV-aligned coords so corner means same in mask and surface.
      const mask = makeMask(SZ, SZ, (x, y) => (x + y) > SZ ? 0xff : 0x00);
      comp.setSurfaceMask(1, mask);
      comp.renderFrame();
      const { data } = await comp.readback();

      // Bottom-right of the surface (well past the diagonal): full red.
      assert.deepEqual(px(data, 56, 56), [0, 0, 255, 255], "BR (opaque mask) = red");
      // Top-left of the surface: mask alpha 0 -> contributes nothing -> clear.
      assert.deepEqual(px(data, 8, 8), [0, 0, 0, 255], "TL (transparent mask) = clear");
    });

    await t.test("setSurfaceMask: 0.5 mask attenuates RGB and alpha equally",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Uniform half-alpha mask.
      const mask = makeMask(SZ, SZ, () => 0x80);
      comp.setSurfaceMask(1, mask);
      comp.renderFrame();
      const { data } = await comp.readback();

      // Sampling on the mask's interior (no soft filter edge cases).
      const [b, g, r, a] = px(data, 32, 32);
      assert.equal(b, 0);
      assert.equal(g, 0);
      // mAlpha = 0x80/0xff ~= 0.502. Source red (0,0,255,255) -> premul scaled
      // by ~0.502. Blended over opaque-black dst: rgb stays at 0.502*255 ~= 128.
      assert.ok(Math.abs(r - 128) <= 2, `red ~= 128 got ${r}`);
      // Framebuffer alpha after blend with opaque dst -> 1.
      assert.equal(a, 255);
    });

    await t.test("setSurfaceMask(null): clears a previously installed mask", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      const mask = makeMask(SZ, SZ, () => 0x00);  // fully transparent
      comp.setSurfaceMask(1, mask);
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255], "transparent mask -> clear");

      comp.setSurfaceMask(1, null);
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "null mask -> full red");
    });

    await t.test("setSurfaceMask + outputMargin: mask UV remap covers the expanded region",
      async () => {
      // With a margin, the mask's UV space [0,1] covers (surface + margin)
      // expanded by the per-edge margin. Verify the remap: a mask transition
      // placed in the MARGIN-overlap region of mask UV produces a screen-
      // space transition that does not fall on the surface boundary.
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      // Surface at (32,32)-(96,96). With 32px margin, expanded region is
      // (0,0)-(128,128) -- the whole output.
      comp.setSurfaceLayout(1, 32, 32, SZ, SZ);
      comp.setStack([1]);
      comp.setSurfaceOutputMargin(1, { top: 32, right: 32, bottom: 32, left: 32 });

      // Mask is 96x96 spanning the expanded region. Transparent for
      // mask x < 32 (== left third == screen x in [0, 42.67)), opaque rest.
      const mask = makeMask(96, 96, (x) => x < 32 ? 0x00 : 0xff);
      comp.setSurfaceMask(1, mask);
      comp.renderFrame();
      const { data } = await comp.readback();

      // Surface center (screen 64, 64): mask opaque -> red.
      assert.deepEqual(px(data, 64, 64), [0, 0, 255, 255],
        "surface center -> mask opaque -> red");
      // Surface interior just inside left edge (screen 36, 64): mask
      // transparent (mask UV.x ~= 0.281 < 0.333) -> clear. The mask
      // transition is inside the surface (not at the surface boundary)
      // because the mask UV [0,1] covers (-mL, 1+mR) in surface UV.
      assert.deepEqual(px(data, 36, 64), [0, 0, 0, 255],
        "surface left interior -> mask transparent");
      // Surface interior further right (screen 50, 64): mask UV.x ~=
      // (0.281 + (50-36)/64 / 2) ... easier: surfUV.x = 18/64 = 0.281,
      // maskUV.x = (0.281 + 0.5) / 2 = 0.391 > 0.333 -> mask opaque -> red.
      assert.deepEqual(px(data, 50, 64), [0, 0, 255, 255],
        "surface mid-left -> mask opaque -> red");
    });

    await t.test("setSurfaceMask: leaves other surfaces unaffected", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const green = solid([0, 255, 0, 255], SZ, SZ);
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.uploadPixels(2, { width: SZ, height: SZ, stride: green.stride }, green.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setSurfaceLayout(2, SZ, 0, SZ, SZ);
      comp.setStack([1, 2]);

      const transparent = makeMask(SZ, SZ, () => 0x00);
      comp.setSurfaceMask(1, transparent);
      comp.renderFrame();
      const { data } = await comp.readback();

      // Surface 1: masked out. Surface 2: unmasked.
      assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255], "surface 1 masked out");
      assert.deepEqual(px(data, 96, 32), [0, 255, 0, 255], "surface 2 unmasked = green");
    });

    // ---- Phase 5.5a: tint + color matrix ------------------------------------

    await t.test("setSurfaceTint: per-channel scale on the sampled rgba", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Halve the R channel; leave the others identity.
      comp.setSurfaceTint(1, { r: 0.5 });
      comp.renderFrame();
      const { data } = await comp.readback();
      const [b, g, r, a] = px(data, 32, 32);
      assert.equal(b, 0);
      assert.equal(g, 0);
      assert.ok(Math.abs(r - 128) <= 1, `red ~= 128 got ${r}`);
      assert.equal(a, 255);
    });

    await t.test("setSurfaceTint: identity (default) leaves the surface unchanged",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // No setSurfaceTint call -- default tint is (1,1,1,1).
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "default tint = identity");

      // Explicit identity (empty object -> all fields default to 1).
      comp.setSurfaceTint(1, {});
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "explicit identity tint");
    });

    await t.test("setSurfaceTint: zero on all rgb channels blacks the surface",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      comp.setSurfaceTint(1, { r: 0, g: 0, b: 0 });
      comp.renderFrame();
      const { data } = await comp.readback();
      // rgb gone; surf.a stays 1, so alpha modulation outputs (0,0,0,1).
      assert.deepEqual(px(data, 32, 32), [0, 0, 0, 255], "rgb tinted to zero");
    });

    await t.test("setSurfaceColorMatrix: swap-rg matrix turns red into green",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Column-major 4x4 matrix that maps (r,g,b,a) -> (g,r,b,a). Each
      // 4-tuple below is one COLUMN (not one row).
      const swapRG = [
        0, 1, 0, 0,  // column 0: contributes (g=col0[0]=0, r=col0[1]=1, b=col0[2]=0, a=col0[3]=0) for input r
        1, 0, 0, 0,  // column 1: r=1 from input g, etc.
        0, 0, 1, 0,
        0, 0, 0, 1,
      ];
      comp.setSurfaceColorMatrix(1, swapRG);
      comp.renderFrame();
      const { data } = await comp.readback();
      // Sampled red (r=1,g=0,b=0,a=1) -> matrix -> (r=0,g=1,b=0,a=1) = green.
      // Framebuffer BGRA bytes: B=0,G=255,R=0,A=255.
      assert.deepEqual(px(data, 32, 32), [0, 255, 0, 255], "swap-rg matrix turns red to green");
    });

    await t.test("setSurfaceColorMatrix: identity is the default (no change)",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // No setSurfaceColorMatrix call -- default is identity.
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "default = identity");

      // Explicit identity.
      comp.setSurfaceColorMatrix(1, [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "explicit identity");

      // null also restores identity (test the clear path after a non-identity).
      comp.setSurfaceColorMatrix(1, [
        0, 1, 0, 0,
        1, 0, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);  // swap-rg
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 32, 32), [0, 255, 0, 255], "swap-rg in effect");
      comp.setSurfaceColorMatrix(1, null);
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 32, 32), [0, 0, 255, 255], "null cleared swap-rg");
    });

    await t.test("setSurfaceColorMatrix + tint: matrix applied before tint",
      async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Swap r and g, then halve the resulting g channel via tint. Input red
      // (r=1,g=0,b=0) -> matrix -> (r=0,g=1,b=0) -> tint*(g=0.5) -> (r=0,g=0.5,b=0).
      const swapRG = [
        0, 1, 0, 0,
        1, 0, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ];
      comp.setSurfaceColorMatrix(1, swapRG);
      comp.setSurfaceTint(1, { g: 0.5 });
      comp.renderFrame();
      const { data } = await comp.readback();
      const [b, g, r, a] = px(data, 32, 32);
      assert.equal(b, 0);
      assert.equal(r, 0);
      assert.ok(Math.abs(g - 128) <= 1, `green ~= 128 got ${g}`);
      assert.equal(a, 255);
    });

    await t.test("setSurfaceColorMatrix accepts a Float32Array", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
      comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
      comp.setStack([1]);

      // Same swap-rg matrix as before but as a typed array.
      const swap = new Float32Array([
        0, 1, 0, 0,
        1, 0, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ]);
      comp.setSurfaceColorMatrix(1, swap);
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 32, 32), [0, 255, 0, 255], "Float32Array works");
    });
  } finally {
    addon.stop();
  }
});
