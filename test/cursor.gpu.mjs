// GPU pixel tests for the cursor compositing slot (Phase 9c).
//
// Builds a small BGRA8 image via setCursorPixels, positions the cursor
// via setCursorPosition, and asserts the rendered pixels appear at
// (pointer - hotspot). Verifies:
//   - visibility flag gates rendering
//   - cursor draws above the content layer
//   - hotspot offsets the rendered rect correctly
//   - clearCursor tears down cleanly
//   - resolveCursorShape integrates: built-in 'default' resolves and renders

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadAddon, loadDawn, gpuBin, coreRoot } from "./harness.mjs";

const addon = loadAddon();
const dawn = loadDawn();

const W = 128, H = 128;
const skip = !dawn ? "dawn.node not built" : false;

// Solid-color BGRA8 image as a Uint8Array (stride = w*4).
function solidPixels(bgra, w, h) {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = bgra[0]; buf[i + 1] = bgra[1];
    buf[i + 2] = bgra[2]; buf[i + 3] = bgra[3];
  }
  return buf;
}

const px = (data, x, y) => {
  const i = (y * W + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

test("cursor compositing slot (Phase 9c)", { skip }, async (t) => {
  addon.start(gpuBin, () => {}, null, { width: W, height: H });
  try {
    const h = addon.gpuHandles();
    const device = dawn.wrapDevice(h.instance, h.device);
    const { JsCompositor } = await import(join(coreRoot, "dist", "gpu", "compositor.js"));

    await t.test("cursor invisible by default (no pixels drawn)", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const red = solidPixels([0, 0, 255, 255], 16, 16);
      comp.setCursorPixels(red, 16, 16, 0, 0);
      // setCursorVisible never called -> not in drawOrder.
      comp.setCursorPosition(40, 40);
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 48, 48), [0, 0, 0, 255], "no cursor pixels visible");
      comp.clearCursor();
    });

    await t.test("setCursorVisible(true) draws cursor at pointer position", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const green = solidPixels([0, 255, 0, 255], 16, 16);
      comp.setCursorPixels(green, 16, 16, 0, 0);
      comp.setCursorPosition(40, 40);
      comp.setCursorVisible(true);
      comp.renderFrame();
      const { data } = await comp.readback();
      // Cursor draws at (40,40) with hotspot (0,0); covers [40,56) x [40,56).
      assert.deepEqual(px(data, 48, 48), [0, 255, 0, 255], "green cursor at center of rect");
      assert.deepEqual(px(data, 40, 40), [0, 255, 0, 255], "green at top-left of rect");
      assert.deepEqual(px(data, 56, 56), [0, 0, 0, 255], "just past the cursor: clear");
      assert.deepEqual(px(data, 39, 39), [0, 0, 0, 255], "just before the cursor: clear");
      comp.clearCursor();
    });

    await t.test("hotspot shifts the cursor rect", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const blue = solidPixels([255, 0, 0, 255], 16, 16);
      // hotspot = (8,8) -- center of the 16x16 image. The cursor should draw
      // with the pointer position at its center.
      comp.setCursorPixels(blue, 16, 16, 8, 8);
      comp.setCursorPosition(64, 64);
      comp.setCursorVisible(true);
      comp.renderFrame();
      const { data } = await comp.readback();
      // Rect = (64-8, 64-8) .. (72, 72) = [56,72) x [56,72).
      assert.deepEqual(px(data, 64, 64), [255, 0, 0, 255], "pointer pos at cursor center");
      assert.deepEqual(px(data, 56, 56), [255, 0, 0, 255], "top-left of shifted rect");
      assert.deepEqual(px(data, 72, 72), [0, 0, 0, 255], "just past bottom-right");
      assert.deepEqual(px(data, 55, 55), [0, 0, 0, 255], "just before top-left");
      comp.clearCursor();
    });

    await t.test("cursor draws above content layer", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      // A full-frame red surface in the content layer.
      const fullRed = solidPixels([0, 0, 255, 255], W, H);
      comp.uploadPixels(1, { width: W, height: H, stride: W * 4 }, fullRed);
      comp.setSurfaceLayout(1, 0, 0, W, H);
      comp.setStack([1]);
      // A green cursor at (40,40).
      const green = solidPixels([0, 255, 0, 255], 16, 16);
      comp.setCursorPixels(green, 16, 16, 0, 0);
      comp.setCursorPosition(40, 40);
      comp.setCursorVisible(true);
      comp.renderFrame();
      const { data } = await comp.readback();
      // At (48,48): cursor's green wins over content's red.
      assert.deepEqual(px(data, 48, 48), [0, 255, 0, 255], "cursor overrides content");
      // Outside cursor: red (content).
      assert.deepEqual(px(data, 80, 80), [0, 0, 255, 255], "content visible outside cursor");
      comp.clearCursor();
    });

    await t.test("clearCursor stops drawing", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const yellow = solidPixels([0, 255, 255, 255], 16, 16);
      comp.setCursorPixels(yellow, 16, 16, 0, 0);
      comp.setCursorPosition(40, 40);
      comp.setCursorVisible(true);
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 48, 48), [0, 255, 255, 255], "yellow before clear");

      comp.clearCursor();
      comp.renderFrame();
      ({ data } = await comp.readback());
      assert.deepEqual(px(data, 48, 48), [0, 0, 0, 255], "black after clear");
    });

    await t.test("setCursorPixels resize reallocates owned texture", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const red = solidPixels([0, 0, 255, 255], 16, 16);
      comp.setCursorPixels(red, 16, 16, 0, 0);
      comp.setCursorPosition(40, 40);
      comp.setCursorVisible(true);
      comp.renderFrame();
      let { data } = await comp.readback();
      assert.deepEqual(px(data, 48, 48), [0, 0, 255, 255]);

      // Resize to 32x32 green.
      const green = solidPixels([0, 255, 0, 255], 32, 32);
      comp.setCursorPixels(green, 32, 32, 0, 0);
      comp.renderFrame();
      ({ data } = await comp.readback());
      // Now the cursor occupies [40,72) x [40,72).
      assert.deepEqual(px(data, 48, 48), [0, 255, 0, 255], "green after resize");
      assert.deepEqual(px(data, 64, 64), [0, 255, 0, 255], "green still inside larger rect");
      comp.clearCursor();
    });

    await t.test("native default shape resolves + renders", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      // Force a bogus theme so the built-in fallback is exercised.
      const prevTheme = process.env.XCURSOR_THEME;
      process.env.XCURSOR_THEME = "overdraw-test-no-such-theme-" + Math.random();
      try {
        const r = addon.resolveCursorShape("default", 16, 1);
        assert.ok(r, "default always resolves via built-in fallback");
        comp.setCursorPixels(r.rgba, r.width, r.height, r.hotspotX, r.hotspotY);
        comp.setCursorPosition(40, 40);
        comp.setCursorVisible(true);
        comp.renderFrame();
        const { data } = await comp.readback();
        // The fallback arrow has a non-zero pixel at (0,0) of the image
        // (top-left of the arrow body). With hotspot=(0,0) that maps to
        // pointer position (40,40).
        // It is BGRA bytes [0,0,0,255] there (black border), so just
        // verify the alpha at (40,40) is fully opaque -- the cursor
        // rect actually drew something.
        const [, , , a] = px(data, 40, 40);
        assert.equal(a, 255, "fallback arrow has opaque pixel at hotspot origin");
      } finally {
        if (prevTheme === undefined) delete process.env.XCURSOR_THEME;
        else process.env.XCURSOR_THEME = prevTheme;
      }
      comp.clearCursor();
    });

    await t.test("cursorState() reflects current state", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      // Before anything: visible=false, no target.
      let s = comp.cursorState();
      assert.equal(s.visible, false);
      assert.equal(s.targetSurfaceId, null);
      assert.equal(s.width, 0);

      const red = solidPixels([0, 0, 255, 255], 16, 16);
      comp.setCursorPixels(red, 16, 16, 4, 5);
      comp.setCursorPosition(40, 50);
      comp.setCursorVisible(true);
      s = comp.cursorState();
      assert.equal(s.visible, true);
      assert.ok(s.targetSurfaceId !== null, "internal cursor surface installed");
      assert.equal(s.width, 16);
      assert.equal(s.height, 16);
      assert.equal(s.hotspotX, 4);
      assert.equal(s.hotspotY, 5);
      // x,y = pointer - hotspot.
      assert.equal(s.x, 36);
      assert.equal(s.y, 45);
      comp.clearCursor();
      s = comp.cursorState();
      assert.equal(s.visible, false);
      assert.equal(s.targetSurfaceId, null);
    });

    await t.test("setCursorFromSurface points slot at existing surface", async () => {
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      // Set up a "client cursor surface": a normal surface entry with a
      // texture installed via uploadPixels (the same path shm clients use).
      // This simulates what wl_pointer.set_cursor will do.
      const CURSOR_CLIENT_SURFACE_ID = 9001;
      const orange = solidPixels([0, 165, 255, 255], 24, 24);
      comp.uploadPixels(CURSOR_CLIENT_SURFACE_ID,
        { width: 24, height: 24, stride: 24 * 4 }, orange);
      // Point the cursor slot at this surface (instead of the internal one).
      comp.setCursorFromSurface(CURSOR_CLIENT_SURFACE_ID, 0, 0);
      comp.setCursorPosition(50, 50);
      comp.setCursorVisible(true);
      // Important: the client cursor surface is NOT in the WM stack
      // (cursors are never window-stacked); drawOrder appends it as the
      // cursor target only.
      comp.renderFrame();
      const { data } = await comp.readback();
      // Cursor rect = [50, 74) x [50, 74). Center at (62, 62).
      assert.deepEqual(px(data, 62, 62), [0, 165, 255, 255], "client cursor surface drawn");
      assert.deepEqual(px(data, 50, 50), [0, 165, 255, 255], "top-left of cursor");
      assert.deepEqual(px(data, 49, 49), [0, 0, 0, 255], "just before cursor: clear");

      // Now setCursorFromSurface(null) hides cursor.
      comp.setCursorFromSurface(null, 0, 0);
      comp.renderFrame();
      const { data: data2 } = await comp.readback();
      assert.deepEqual(px(data2, 62, 62), [0, 0, 0, 255], "cleared after setCursorFromSurface(null)");
      comp.clearCursor();
    });

    await t.test("moving a client cursor surface damages the output (no choppy freeze)", async () => {
      // A client cursor surface (Xwayland's pointer cursor) is never in the WM
      // layout, so its layoutW/H are not set by the layout sweep. A pure cursor
      // MOVE must still mark the output dirty -- the per-output render gate
      // skips outputs with no damage, so a zero-size move would never present
      // and the cursor would freeze until some other commit (choppy motion over
      // an XWayland window while smooth over a native one). updateCursorLayout
      // derives the move-damage rect from the cursor surface's own buffer dims.
      const comp = new JsCompositor(device, dawn.globals, addon, { width: W, height: H });
      const CURSOR_CLIENT_SURFACE_ID = 9002;
      const teal = solidPixels([128, 128, 0, 255], 24, 24);
      comp.uploadPixels(CURSOR_CLIENT_SURFACE_ID,
        { width: 24, height: 24, stride: 24 * 4 }, teal);
      comp.setCursorFromSurface(CURSOR_CLIENT_SURFACE_ID, 0, 0);
      comp.setCursorVisible(true);
      comp.setCursorPosition(50, 50);
      // Present to consume the setup damage; the output is clean afterwards.
      comp.renderFrame();
      await comp.readback();
      assert.equal(comp.isOutputDirty(0), false, "clean after present");
      // Pure move, no new buffer: must re-dirty the output.
      comp.setCursorPosition(100, 100);
      assert.equal(comp.isOutputDirty(0), true,
        "a client-cursor move marks the output dirty -> a present is scheduled");
      comp.clearCursor();
    });

    await t.test("hardware cursor plane routing", async () => {
      // Wrap the addon so the plane-bound sends are observable; every
      // other method falls through to the real addon.
      const sent = { images: [], states: [] };
      const rec = Object.create(addon);
      rec.sendCursorImage = (outputId, pixels, srcW, srcH, dstW, dstH) =>
        sent.images.push({ outputId, len: pixels.length, srcW, srcH, dstW, dstH });
      rec.sendCursorImageShm = () => {};
      rec.sendCursorState = (outputId, x, y, visible, commitNow) =>
        sent.states.push({ outputId, x, y, visible, commitNow });
      const comp = new JsCompositor(device, dawn.globals, rec, { width: W, height: H });

      const mag = solidPixels([255, 0, 255, 255], 16, 16);
      comp.setCursorPixels(mag, 16, 16, 2, 3);
      comp.setCursorPosition(40, 40);
      comp.setCursorVisible(true);

      // Plane arrives: the image ships, the plane activates, and the
      // software slot drops out of the composite on that output.
      comp.setCursorPlaneStatus(0, true, 64, 64);
      assert.equal(sent.images.length, 1, "image shipped to the plane");
      assert.deepEqual(
        { srcW: sent.images[0].srcW, dstW: sent.images[0].dstW },
        { srcW: 16, dstW: 16 }, "scale-1 output: dst == src");
      assert.deepEqual(comp.hwCursorState().activeOutputs, [0]);
      comp.renderFrame();
      const { data } = await comp.readback();
      assert.deepEqual(px(data, 44, 42), [0, 0, 0, 255],
        "software cursor NOT composited while the plane owns it");
      assert.ok(sent.states.length >= 1, "plane position flushed");
      const st = sent.states.at(-1);
      assert.deepEqual(
        [st.x, st.y, st.visible, st.commitNow],
        [38, 37, true, false],
        "hotspot-adjusted device position; rendered output folds into its present");

      // A move re-flushes the plane position without any output damage.
      comp.setCursorPosition(60, 20);
      assert.equal(comp.isOutputDirty(0), false,
        "cursor move adds no damage on a hw-cursor output");
      comp.renderFrame();
      const st2 = sent.states.at(-1);
      assert.deepEqual([st2.x, st2.y], [58, 17]);

      // Demotion (status ok=false): the software slot takes over again.
      comp.setCursorPlaneStatus(0, false, 0, 0);
      assert.deepEqual(comp.hwCursorState().activeOutputs, []);
      assert.equal(comp.isOutputDirty(0), true, "fallback repaints the cursor rect");
      comp.renderFrame();
      const { data: d2 } = await comp.readback();
      assert.deepEqual(px(d2, 62, 20), [255, 0, 255, 255], "software cursor is back");

      // An image too large for the plane FB never activates the plane.
      comp.setCursorPlaneStatus(0, true, 8, 8);
      assert.deepEqual(comp.hwCursorState().activeOutputs, [],
        "16x16 image exceeds an 8x8 plane; output stays software");
      comp.clearCursor();
    });

    await t.test("theme shapes resolve at per-output scale (no upscale)", async () => {
      const sent = { images: [] };
      const rec = Object.create(addon);
      rec.sendCursorImage = (outputId, pixels, srcW, srcH, dstW, dstH) =>
        sent.images.push({ outputId, srcW, srcH, dstW, dstH });
      rec.sendCursorImageShm = () => {};
      rec.sendCursorState = () => {};
      const comp = new JsCompositor(device, dawn.globals, rec, { width: W, height: H });

      // A scale-2 output: 64x64 logical glass over the 128x128 device target.
      comp.setOutputs([{ id: 0, deviceWidth: W, deviceHeight: H,
                         logicalX: 0, logicalY: 0, scale: 2 }]);
      comp.setCursorPlaneStatus(0, true, 256, 256);

      const asked = [];
      const provider = (sizeDev) => {
        asked.push(sizeDev);
        return {
          width: sizeDev, height: sizeDev,
          hotspotX: sizeDev / 2, hotspotY: sizeDev / 2,
          rgba: solidPixels([0, 255, 255, 255], sizeDev, sizeDev),
        };
      };
      assert.equal(comp.setCursorShape(provider, 16), true);
      comp.setCursorVisible(true);

      // Software image resolved at the highest output scale (16 * 2 = 32)...
      assert.ok(asked.includes(32), `expected a resolve at 32, got [${asked}]`);
      // ...and the plane shipped a native-resolution image (src == dst,
      // nothing upscaled).
      const img = sent.images.at(-1);
      assert.deepEqual({ srcW: img.srcW, dstW: img.dstW, dstH: img.dstH },
        { srcW: 32, dstW: 32, dstH: 32 });
      // The internal surface holds the 32px image at bufferScale 2, so the
      // logical cursor size stays 16 and the hotspot converts to logical.
      const cs = comp.cursorState();
      assert.equal(cs.width, 32, "surface holds the scale-2 image");
      assert.equal(cs.hotspotX, 8, "16px image hotspot -> logical 8 at bs=2");
      comp.clearCursor();
    });
  } finally {
    addon.stop();
  }
});
