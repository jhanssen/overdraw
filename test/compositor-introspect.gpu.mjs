// CompositorSink.introspect(): the diagnostic snapshot behind the IPC
// query.render action. Verifies the draw list reflects the real per-output
// draw order with correct segment labels (content / layer / cursor), the
// effective rects (layout size, or intrinsic buffer size for
// size-from-intrinsic entries), and the idle scanout state. Headless;
// requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128, SZ = 64;

function solid(fillBGRA, w, h) {
  const stride = w * 4;
  const buf = new Uint8Array(stride * h);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = fillBGRA[0]; buf[i + 1] = fillBGRA[1]; buf[i + 2] = fillBGRA[2]; buf[i + 3] = fillBGRA[3];
  }
  return { data: buf, stride };
}

test("introspect reports labeled draw order, rects, and scanout state", { skip: !dawn ? "dawn.node not built" : false }, async () => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });

    const px = solid([0, 0, 255, 255], SZ, SZ);

    // Surface 1: content with an explicit layout rect.
    comp.uploadPixels(1, { width: SZ, height: SZ, stride: px.stride }, px.data);
    comp.setSurfaceLayout(1, 4, 8, SZ, SZ);
    // Surface 2: content, size-from-intrinsic (zero layout size -- the
    // effective size is the buffer's logical size, like a subsurface).
    comp.uploadPixels(2, { width: SZ, height: SZ, stride: px.stride }, px.data);
    comp.setSurfaceLayout(2, 70, 0, 0, 0);
    comp.setStack([1, 2]);
    // Surface 3: a plugin overlay on the 'overlay' layer.
    comp.uploadPixels(3, { width: SZ, height: SZ, stride: px.stride }, px.data);
    comp.setSurfaceLayout(3, 0, 0, W, H);
    comp.setLayerSurfaces("overlay", [3]);
    // Software cursor: always the topmost entry.
    comp.setCursorPixels(new Uint8Array(8 * 8 * 4), 8, 8, 0, 0);
    comp.setCursorVisible(true);

    const snap = comp.introspect();
    assert.equal(snap.directScanout, false);
    assert.equal(snap.outputs.length, 1);
    const o = snap.outputs[0];
    assert.equal(o.outputId, 0);
    assert.equal(o.hwCursor, false);
    assert.deepEqual(o.scanout,
      { latchedBufferId: null, flipPending: false, vetoedBufferIds: [] });

    assert.equal(o.drawList.length, 4);
    const [a, b, c, d] = o.drawList;
    assert.deepEqual(
      { id: a.id, kind: a.kind, x: a.x, y: a.y, width: a.width, height: a.height, hasBuffer: a.hasBuffer },
      { id: 1, kind: "content", x: 4, y: 8, width: SZ, height: SZ, hasBuffer: true });
    // Size-from-intrinsic: effective size = buffer dims / bufferScale (1).
    assert.deepEqual(
      { id: b.id, kind: b.kind, width: b.width, height: b.height },
      { id: 2, kind: "content", width: SZ, height: SZ });
    assert.equal(c.id, 3);
    assert.equal(c.kind, "layer");
    assert.equal(c.layer, "overlay");
    assert.equal(d.kind, "cursor");
  } finally {
    addon.stop();
  }
});
