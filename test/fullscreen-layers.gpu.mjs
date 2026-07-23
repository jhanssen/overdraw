// Fullscreen vs. layer-shell layers, end-to-end. An ACTIVE fullscreen
// window covers the "top" layer (bars, panels): the output's draw order
// drops the "above" layer while one is present (which is also what lets
// the fullscreen buffer top the draw list for direct scanout), and the
// seat's pick skips "top" at points the fullscreen covers. "overlay"
// (lock screens, OSDs) stays above fullscreen in both render and input.
// When the fullscreen window loses its output's activity it drops below
// the tiled tier and the bar returns, composited and pickable.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, pixelAt, pixelMatches }
  from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const LS_BIN = buildBin("layer-shell-test-client");

const A_TOP = 1, A_LEFT = 4, A_RIGHT = 8;

// Poll the composited frame until the pixel at (x, y) matches [b, g, r, a].
async function waitPixel(c, x, y, bgra, what) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 4000) {
    const px = await c.frameReadback();
    if (px) {
      last = pixelAt(px, c.dims.width, x, y);
      if (pixelMatches(last, bgra, 8)) return;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`${what}: pixel (${x},${y}) = [${last}] != [${bgra}]`);
}

test("fullscreen covers the top layer; overlay stays above; bar returns on deactivation",
  { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 256, height: 256 } });
  try {
    // Green bar: top layer, full width, 30px tall.
    const panel = c.spawnClient(
      ["--layer", "top", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", "0x30", "--zone", "30", "--kbd", "none", "--color", "00FF00",
       "--lifetime", "20000"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    await panel.ready;

    // A blue tiled toplevel to cycle focus back to later.
    const tl = c.spawnClient(
      ["--app-id", "tl", "--title", "tl", "--color", "FF0000FF",
       "--size", "100x100", "--fill-configured"]);
    await tl.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1 && s.windows[0].mapped,
      { what: "toplevel mapped" });
    const tlId = c.query().windows[0].surfaceId;

    // Bar composites above the tiled world.
    await waitPixel(c, 128, 25, [0, 255, 0, 255], "bar over tiled world");
    assert.equal(c.state.seat.pick(128, 25)?.surfaceId,
      [...c.state.layerSurfaces.values()][0].surface.id,
      "pick in the bar region hits the bar while no fullscreen is active");

    // Red fullscreen client: focused on map -> active -> covers the bar.
    const game = c.spawnClient(
      ["--app-id", "game", "--title", "game", "--color", "FFFF0000",
       "--size", "100x100", "--fill-configured", "--initial-state", "fullscreen"]);
    await game.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 2,
      { what: "game mapped", timeoutMs: 8000 });
    const gameId = c.query().windows.map((w) => w.surfaceId)
      .find((id) => id !== tlId);
    await c.waitFor(() => c.state.wm.state.windows.find((w) => w.surfaceId === gameId),
      (w) => w?.windowState.sizeMode === "fullscreen",
      { timeoutMs: 8000, what: "game fullscreen" });
    await c.waitFor(c.query, (s) => s.keyboardFocus === gameId,
      { what: "game focused on map" });

    await waitPixel(c, 128, 25, [0, 0, 255, 255], "fullscreen covers the bar");
    assert.equal(c.state.seat.pick(128, 25)?.rootSurfaceId, gameId,
      "pick in the bar region hits the fullscreen window while it is active");

    // Orange overlay-layer strip: draws above the fullscreen window.
    const osd = c.spawnClient(
      ["--layer", "overlay", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", "0x20", "--zone", "0", "--kbd", "none", "--color", "FF8000",
       "--lifetime", "20000"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    await osd.ready;
    // The panel's 30px exclusive zone positions the top-anchored overlay
    // strip at y = 30..50, overlapping the fullscreen window.
    await waitPixel(c, 128, 40, [0, 128, 255, 255], "overlay above fullscreen");
    const overlayRec = [...c.state.layerSurfaces.values()]
      .find((r) => r.applied.layer === "overlay");
    assert.equal(c.state.seat.pick(128, 40)?.surfaceId, overlayRec.surface.id,
      "pick in the overlay region hits the overlay above fullscreen");

    // Focus the toplevel: the fullscreen window loses its output's
    // activity, drops below the tiled tier, and the bar returns.
    c.state.seat.applyKeyboardFocus(tlId);
    await waitPixel(c, 128, 25, [0, 255, 0, 255], "bar returns on deactivation");
    const barRec = [...c.state.layerSurfaces.values()]
      .find((r) => r.applied.layer === "top");
    assert.equal(c.state.seat.pick(128, 25)?.surfaceId, barRec.surface.id,
      "pick in the bar region hits the bar again once fullscreen deactivates");
  } finally {
    await c.teardown();
  }
});
