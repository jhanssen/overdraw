// Core-side ScanoutClientReject handling. A plain reject (refused present,
// never latched) vetoes the buffer and releases it at once. A cursor
// reject (the kernel refused the hw cursor over the buffer) vetoes nothing
// and holds scanout off on the output while the cursor is shown there. A
// latched reject (cursor-only commit refused over an on-plane buffer)
// keeps the buffer held until the composite frame's ScanoutClientFlip
// retires it. Headless; requires the GPU; skips if dawn.node is absent.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();
const W = 128, H = 128;
const XRGB8888 = 0x34325258;

// One addon start per process: the addon does not survive a stop/start
// cycle in the same process.
test("scanout reject handling", { skip: !dawn ? "dawn.node not built" : false }, async (t) => {
  const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    assert.ok(h, "gpuHandles");
    const device = dawn.wrapDevice(h.instance, h.device);
    const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
    const retired = [];
    const step = comp.lifecycle.step.bind(comp.lifecycle);
    comp.lifecycle.step = (ev) => {
      if (ev.kind === "scanoutRetired") retired.push(ev.bufferId);
      return step(ev);
    };
    const scanout = () => comp.introspect().outputs[0].scanout;
    const sub = (name, fn) => t.test(name, async () => {
      retired.length = 0;
      comp.scanoutVeto.clear();
      comp.scanoutCursorBlocked.clear();
      comp.scanoutActive.clear();
      comp.scanoutFlipPending.clear();
      await fn();
    });

    await sub("latched cursor reject: no veto, buffer held until the retire", () => {
      // Buffer 7 latched on output 0, with another present in flight.
      comp.handleScanoutClientFlip(0, 7, 0);
      comp.scanoutFlipPending.add(0);

      comp.handleScanoutClientReject(0, 7, { latched: true, cursor: true });
      assert.deepEqual(scanout(), {
        latchedBufferId: 7, flipPending: true, vetoedBufferIds: [], cursorBlocked: true,
      });
      assert.deepEqual(retired, [], "latched buffer not released by the reject");

      // The composite frame latches and retires 7.
      comp.scanoutFlipPending.delete(0);
      comp.handleScanoutClientFlip(0, 0, 7);
      assert.deepEqual(scanout(), {
        latchedBufferId: null, flipPending: false, vetoedBufferIds: [], cursorBlocked: true,
      });
      assert.deepEqual(retired, [7]);
    });

    await sub("plain reject vetoes and releases; unlatched cursor reject releases without veto", () => {
      comp.scanoutFlipPending.add(0);
      comp.handleScanoutClientReject(0, 9);
      assert.deepEqual(scanout(), {
        latchedBufferId: null, flipPending: false, vetoedBufferIds: [9], cursorBlocked: false,
      });
      assert.deepEqual(retired, [9]);

      comp.scanoutFlipPending.add(0);
      comp.handleScanoutClientReject(0, 10, { cursor: true });
      assert.deepEqual(scanout(), {
        latchedBufferId: null, flipPending: false, vetoedBufferIds: [9], cursorBlocked: true,
      });
      assert.deepEqual(retired, [9, 10]);
    });

    await sub("cursor block holds scanout off only while the cursor is shown on the output", () => {
      // An output-covering opaque dmabuf candidate. The import record is
      // the only part the eligibility test reads; no real dmabuf needed.
      const px = new Uint8Array(W * H * 4).fill(255);
      comp.uploadPixels(1, { width: W, height: H, stride: W * 4 }, px);
      comp.setSurfaceLayout(1, 0, 0, W, H);
      comp.setStack([1]);
      comp.surfaces.get(1).currentBufferId = 42;
      comp.dmabufImports.set(42, { width: W, height: H, importId: 1, fourcc: XRGB8888 });
      // The cursor rides the hw plane on output 0 (not in the draw list).
      comp.setCursorPixels(new Uint8Array(8 * 8 * 4), 8, 8, 0, 0);
      comp.hwCursorActive.add(0);
      comp.setCursorPosition(20, 20);
      comp.setCursorVisible(true);
      assert.equal(comp.scanoutEligibilityReason(0), null, "eligible before any refusal");

      comp.handleScanoutClientReject(0, 42, { cursor: true });
      assert.match(comp.scanoutEligibilityReason(0) ?? "", /hw cursor/);
      assert.equal(scanout().cursorBlocked, true);

      // Cursor moved off the output: not shown there, block lifts.
      comp.setCursorPosition(W + 50, 20);
      assert.equal(comp.scanoutEligibilityReason(0), null);
      assert.equal(scanout().cursorBlocked, false);

      // A hidden cursor lifts it too; the buffer itself was never vetoed.
      comp.setCursorPosition(20, 20);
      comp.handleScanoutClientReject(0, 42, { cursor: true });
      assert.match(comp.scanoutEligibilityReason(0) ?? "", /hw cursor/);
      comp.setCursorVisible(false);
      assert.equal(comp.scanoutEligibilityReason(0), null);
      assert.deepEqual(scanout().vetoedBufferIds, []);
    });
  } finally {
    addon.stop();
  }
});
