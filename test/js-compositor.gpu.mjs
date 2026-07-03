// Slice-1 verification: the JS compositor (src/gpu/compositor.ts) composites shm
// surfaces over the Dawn wire via a wire-retargeted dawn.node, headless, and the
// readback matches computed expectations. Proves the core compositing pass runs
// in JS (not C++) end-to-end. Requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128, SZ = 64;

// A solid-color BGRA8 buffer (stride = w*4), as a Uint8Array.
function solid(fillBGRA, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = fillBGRA[0]; buf[i + 1] = fillBGRA[1]; buf[i + 2] = fillBGRA[2]; buf[i + 3] = fillBGRA[3];
  }
  return { data: buf, stride };
}

test("JS compositor composites two shm surfaces over the wire", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    const red = solid([0, 0, 255, 255], SZ, SZ);    // BGRA red
    const green = solid([0, 255, 0, 255], SZ, SZ);   // BGRA green

    comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data);
    comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
    comp.uploadPixels(2, { width: SZ, height: SZ, stride: green.stride }, green.data);
    comp.setSurfaceLayout(2, SZ, 0, SZ, SZ);
    comp.setStack([1, 2]);

    comp.renderFrame();
    const { data } = await comp.readback();

    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    assert.deepEqual(px(32, 32), [0, 0, 255, 255], "red surface top-left");
    assert.deepEqual(px(96, 32), [0, 255, 0, 255], "green surface top-right");
    assert.deepEqual(px(32, 96), [0, 0, 0, 255], "background below = black");
  } finally {
    addon.stop();
  }
});
