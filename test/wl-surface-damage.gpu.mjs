// Upload-damage verification: a partial (damage-rect) shm upload changes only
// the damaged region of the surface's persistent texture; the undamaged region
// retains the previous frame's pixels. Drives JsCompositor.uploadPixels directly
// (the path commitSurfaceBuffer feeds), headless. The protocol-layer damage
// accumulation + buffer-coordinate reconciliation is covered by the pure-unit
// test (wl-surface-damage.test.js).
//
// Run: npm run test:gpu

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128, SZ = 64;
const BLUE = [255, 0, 0, 255];   // BGRA
const RED = [0, 0, 255, 255];    // BGRA

function solid(bgra, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1]; buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return { data: buf, stride };
}

// Single addon.start/stop per process (two start/stop cycles double-close a
// libuv handle on teardown). Both behaviors share one compositor: surface 1
// (top-left tile) gets a partial-damage upload; surface 2 (top-right tile) gets
// a full upload with no damage arg.
test("damage controls how much of a re-uploaded shm surface changes", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    const blue = solid(BLUE, SZ, SZ);
    const red = solid(RED, SZ, SZ);

    // Surface 1 (tile at 0,0): blue full upload, then RED buffer but damage
    // only a 16x16 patch -- only that patch must reach the texture.
    comp.uploadPixels(1, { width: SZ, height: SZ, stride: blue.stride }, blue.data);
    comp.setSurfaceLayout(1, 0, 0, SZ, SZ);
    comp.uploadPixels(1, { width: SZ, height: SZ, stride: red.stride }, red.data,
      [{ x: 16, y: 16, width: 16, height: 16 }]);

    // Surface 2 (tile at 64,0): blue full upload, then RED with NO damage arg
    // -> the whole surface is replaced.
    comp.uploadPixels(2, { width: SZ, height: SZ, stride: blue.stride }, blue.data);
    comp.setSurfaceLayout(2, SZ, 0, SZ, SZ);
    comp.uploadPixels(2, { width: SZ, height: SZ, stride: red.stride }, red.data);

    comp.setStack([1, 2]);
    comp.renderFrame();
    const { data } = await comp.readback();
    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };

    // Surface 1: inside the damage rect -> red; outside -> retained blue.
    assert.deepEqual(px(24, 24), RED, "center of damage rect = new color");
    assert.deepEqual(px(16, 16), RED, "damage rect top-left corner = new color");
    assert.deepEqual(px(8, 8), BLUE, "above-left of damage = retained old color");
    assert.deepEqual(px(48, 48), BLUE, "below-right of damage = retained old color");
    assert.deepEqual(px(32, 32), BLUE, "just outside damage (exclusive edge) = retained");

    // Surface 2: no damage arg -> the full surface was replaced with red.
    assert.deepEqual(px(SZ + 8, 8), RED, "no-damage upload replaced the whole surface");
    assert.deepEqual(px(SZ + 48, 48), RED, "no-damage upload replaced the whole surface");
  } finally {
    addon.stop();
  }
});
