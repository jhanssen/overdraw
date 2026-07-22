// GPU pixel tests for backdrop effects (setSurfaceBackdropEffect) with the
// built-in dual-Kawase blur renderer. Runs the JS compositor headless over
// the Dawn wire and reads back composited pixels: a bottom surface with a
// hard red/blue vertical boundary, a fully-transparent top surface over the
// boundary. With blur active, pixels near the boundary UNDER the top
// surface mix both colors; outside the top surface the boundary stays
// sharp. Requires GPU + Dawn; skips otherwise.
//
// All tests share a single addon.start()/stop() lifecycle: server bring-up
// is not safely repeatable in one process (uv__finish_close assertion on
// the second cycle; status.md "Known testing bugs").

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128;
const skip = !dawn ? "dawn.node not built" : false;

// Left half red, right half blue (opaque), BGRA8.
function redBlueSplit(w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < w / 2) { buf[i + 2] = 0xff; }       // red
      else { buf[i] = 0xff; }                     // blue
      buf[i + 3] = 0xff;
    }
  }
  return { data: buf, stride };
}

// Uniform premultiplied BGRA fill.
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

test("backdrop effects: dual-Kawase blur behind a translucent surface",
  { skip }, async (t) => {
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));
    const { createBackdropBlurRenderer } =
      await import(join(coreRoot, "dist", "gpu", "backdrop-blur.js"));

    const backdrop = redBlueSplit(W, H);
    // Fully transparent 64x64 (premultiplied all-zero): the surface itself
    // contributes nothing, so what shows in its rect is exactly its
    // (processed) backdrop.
    const clear = solid([0, 0, 0, 0], 64, 64);

    // One compositor + renderer per sub-test group; the effect toggles
    // in-place to exercise the damage/partial-repaint path between frames.
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
    const blur = createBackdropBlurRenderer(device, dawn.globals, "bgra8unorm");
    comp.registerBackdropEffectRenderer("blur", blur);

    comp.uploadPixels(1, { width: W, height: H, stride: backdrop.stride }, backdrop.data);
    comp.setSurfaceLayout(1, 0, 0, W, H);
    comp.uploadPixels(2, { width: 64, height: 64, stride: clear.stride }, clear.data);
    comp.setSurfaceLayout(2, 32, 32, 64, 64);
    comp.setStack([1, 2]);

    await t.test("no effect: the boundary is sharp everywhere", async () => {
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 58, 64), [0, 0, 255, 255], "left of boundary pure red");
      assert.deepEqual(px(data, 70, 64), [255, 0, 0, 255], "right of boundary pure blue");
    });

    await t.test("blur mixes the boundary under the surface only", async () => {
      comp.setSurfaceBackdropEffect(2, { kind: "blur", params: { radius: 16 } });
      comp.renderFrame();
      const { data } = await comp.readback();
      // Under the top surface, 6px each side of the boundary: both channels
      // present (6px is inside the radius-16 kernel but beyond half-res
      // resampling wobble).
      let [b, , r] = px(data, 58, 64);
      assert.ok(r > 20 && b > 20, `under surface, left of boundary mixed: b=${b} r=${r}`);
      ([b, , r] = px(data, 70, 64));
      assert.ok(r > 20 && b > 20, `under surface, right of boundary mixed: b=${b} r=${r}`);
      // Outside the top surface (same columns, above its rect): still sharp.
      assert.deepEqual(px(data, 58, 8), [0, 0, 255, 255], "outside surface stays pure red");
      assert.deepEqual(px(data, 70, 8), [255, 0, 0, 255], "outside surface stays pure blue");
    });

    await t.test("capture (composeOutput) shows the same blurred scene", async () => {
      // Screen capture composites through the same compositeScene path, so
      // the captured frame must match the on-screen result: mixed under
      // the effect surface, sharp outside it.
      const r = comp.composeOutput(0);
      assert.ok(r, "composeOutput returned a texture");
      try {
        const { data } = await comp.readbackTexture(r.texture, r.outW, r.outH);
        let [b, , rr] = px(data, 58, 64);
        assert.ok(rr > 20 && b > 20, `capture: under surface mixed: b=${b} r=${rr}`);
        ([b, , rr] = px(data, 70, 64));
        assert.ok(rr > 20 && b > 20, `capture: under surface mixed: b=${b} r=${rr}`);
        assert.deepEqual(px(data, 58, 8), [0, 0, 255, 255], "capture: outside sharp red");
        assert.deepEqual(px(data, 70, 8), [255, 0, 0, 255], "capture: outside sharp blue");
      } finally {
        r.texture.destroy();
      }
    });

    await t.test("larger radius mixes further from the boundary", async () => {
      comp.setSurfaceBackdropEffect(2, { kind: "blur", params: { radius: 48 } });
      comp.renderFrame();
      const { data } = await comp.readback();
      // 24px left of the boundary: radius 16 leaves this essentially pure;
      // radius 48 reaches it.
      const [b, , r] = px(data, 40, 64);
      assert.ok(r > 20 && b > 10, `wide blur reaches 24px out: b=${b} r=${r}`);
    });

    await t.test("clearing the effect restores the sharp boundary", async () => {
      comp.setSurfaceBackdropEffect(2, null);
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 58, 64), [0, 0, 255, 255], "sharp again (left)");
      assert.deepEqual(px(data, 70, 64), [255, 0, 0, 255], "sharp again (right)");
    });

    await t.test("surface content blends over the blurred backdrop", async () => {
      // Half-transparent black content (premultiplied 0,0,0,128): the
      // result under the surface is the blurred backdrop at ~half
      // brightness.
      const halfBlack = solid([0, 0, 0, 128], 64, 64);
      comp.uploadPixels(2, { width: 64, height: 64, stride: halfBlack.stride },
        halfBlack.data);
      comp.setSurfaceBackdropEffect(2, { kind: "blur", params: { radius: 16 } });
      comp.renderFrame();
      const { data } = await comp.readback();
      // Deep in the red half (24px from the boundary): mostly red, dimmed
      // to about half by the overlay.
      const [b, , r] = px(data, 40, 64);
      assert.ok(r > 90 && r < 165, `dimmed red under overlay: r=${r}`);
      assert.ok(b < 60, `little blue this far out: b=${b}`);
    });

    await t.test("unknown effect kind composites without the effect", async () => {
      const clear2 = solid([0, 0, 0, 0], 64, 64);
      comp.uploadPixels(2, { width: 64, height: 64, stride: clear2.stride }, clear2.data);
      comp.setSurfaceBackdropEffect(2, { kind: "no-such-effect" });
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 58, 64), [0, 0, 255, 255], "no renderer -> sharp");
      assert.deepEqual(px(data, 70, 64), [255, 0, 0, 255], "no renderer -> sharp");
    });

    blur.destroy();
  } finally {
    addon.stop();
  }
});
