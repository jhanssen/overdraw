// A subsurface is placed size-from-intrinsic: the WM/emit path calls
// setSurfaceLayout(id, x, y, 0, 0), so its layoutW/H stay 0 and the on-screen
// footprint comes from the buffer. When such a surface MOVES (its parent
// retiles), the move must re-dirty the output -- the per-output render gate
// skips outputs with no damage, so a move damaged as a 0x0 rect (dropped by the
// damage ring) would leave stale pixels at the old position and never paint the
// new one until some unrelated commit forces a full repaint. setSurfaceLayout
// derives the move-damage rect from the surface's own buffer dims, not the 0x0
// layout.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128;

function solidPixels(bgra, w, h) {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1]; buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return buf;
}

test("moving a size-from-intrinsic (0x0-layout) surface damages the output",
  { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const handles = addon.gpuHandles();
    const device = dawn.wrapDevice(handles.instance, handles.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    const SID = 5001;
    comp.uploadPixels(SID, { width: 40, height: 30, stride: 40 * 4 },
      solidPixels([0, 255, 0, 255], 40, 30));
    // Size-from-intrinsic placement: layout w/h = 0 (the subsurface path).
    comp.setSurfaceLayout(SID, 10, 10, 0, 0);
    comp.setStack([SID]);
    // Present to consume the setup damage; the output is clean afterwards.
    comp.renderFrame();
    await comp.readback();
    assert.equal(comp.isOutputDirty(0), false, "clean after present");

    // Pure move, still 0x0 layout: must re-dirty via the buffer footprint. A
    // 0x0 damage rect is dropped by the ring (and never sets the dirty bit).
    comp.setSurfaceLayout(SID, 70, 60, 0, 0);
    assert.equal(comp.isOutputDirty(0), true,
      "a 0x0-layout surface move marks the output dirty -> a repaint is scheduled");
  } finally {
    addon.stop();
  }
});
