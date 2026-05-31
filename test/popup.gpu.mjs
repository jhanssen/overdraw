// xdg_popup end-to-end (headless pixel test): a parent toplevel with a popup
// positioned via xdg_positioner (anchor rect + bottom_left anchor + bottom_right
// gravity) composites the popup at parent + computed offset, above the parent.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (WAYLAND_DISPLAY unset)";
const POPUP = buildBin("popup-test-client");
const OUT = { width: 1280, height: 720 };

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff, a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
async function readWhen(c, expect, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const px = await c.frameReadback();
    if (px && pixelMatches(pixelAt(px, OUT.width, expect.x, expect.y), expect.bgra, 4)) return px;
    await new Promise((r) => setTimeout(r, 16));
  }
  return c.frameReadback();
}

test("xdg_popup composites at the positioner-computed location above the parent", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const pColor = 0xff0000ff, uColor = 0xff00ff00; // parent blue, popup green
    const PW = 300, PH = 200, UW = 80, UH = 60;
    // anchor rect (10,180,20,20); anchor bottom_left -> (10,200); gravity
    // bottom_right -> popup top-left at parent-relative (10,200).
    const cl = c.spawnClient(
      ["--parent", `${PW}x${PH}`, "--popup", `${UW}x${UH}`, "--anchor-rect", "10,180,20,20",
       "--parent-color", pColor.toString(16), "--popup-color", uColor.toString(16)],
      { bin: POPUP, readyMarker: "[popup-client] popup configured" });
    await cl.ready;

    // The parent is the WM-placed toplevel; get its rect.
    const snap = await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "parent window" });
    const p = snap.windows[0].rect;

    // Popup center in output space = parent origin + (10,200) + half popup.
    const ux = p.x + 10 + (UW >> 1);
    const uy = p.y + 200 + (UH >> 1);
    const bgraPopup = argbToBgra(uColor);
    const frame = await readWhen(c, { x: ux, y: uy, bgra: bgraPopup });
    assert.ok(pixelMatches(pixelAt(frame, OUT.width, ux, uy), bgraPopup, 4),
      `popup should composite at the computed position; got ${pixelAt(frame, OUT.width, ux, uy)}`);

    // The popup configure position the client received should be (10,200).
    const cfg = cl.stdout.match(/popup configured at (-?\d+),(-?\d+)/);
    assert.ok(cfg, "popup configure received");
    assert.equal(Number(cfg[1]), 10, "popup x");
    assert.equal(Number(cfg[2]), 200, "popup y");
  } finally {
    await c.teardown();
  }
});
