// GPU integration: the bar lives in the camera, not the world (canvas
// world mode + a real layer-shell panel with an exclusive zone). Islands
// are workarea-sized with NO carved bar band -- the layout driver uses
// explicit island rects verbatim -- and the docked camera offsets the
// island below the bar (island origin at the workarea origin). Zone
// changes (panel map / disconnect) resize islands and re-dock cameras
// via the reserved-zone registry's onChange -> output.workarea-changed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled, buildBin }
  from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const GUTTER = 128;   // SLOT_GUTTER default
const BAR = 30;

const LS_BIN = buildBin("layer-shell-test-client");
const A_TOP = 1, A_LEFT = 4, A_RIGHT = 8;

const FILL = "--fill-configured";

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

test("world mode: islands size to the workarea; the dock offsets them below the bar", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, config: { canvas: { world: true } } });
  try {
    const winArgb = 0xffc03030;   // red-ish
    const winBgra = argbToBgra(winArgb);
    const barBgra = [0, 255, 0, 255];  // panel green, X8 alpha reads 255

    // Toplevel A on workspace 1 -- maps before any bar exists, so its
    // island starts viewport-sized.
    const a = c.spawnClient([FILL, "--color", winArgb.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    await c.state.wm.settled();
    assert.equal(c.query().windows[0].rect.height, OUT.height,
      "no bar yet: the island (and A) span the full viewport");

    // The bar: top-anchored, full width, 30px tall, 30px exclusive.
    const panel = c.spawnClient(
      ["--layer", "top", "--anchor", String(A_TOP | A_LEFT | A_RIGHT),
       "--size", `0x${BAR}`, "--zone", String(BAR), "--kbd", "none",
       "--color", "00FF00"],
      { bin: LS_BIN, readyMarker: "[client] mapped" });
    await panel.ready;

    // The zone lands -> output.workarea-changed -> the island resizes to
    // the workarea and A relayouts into it. The island rect is VERBATIM
    // world space: A sits at world y=0 (no carved band), sized to the
    // 690px workarea.
    await settled(() => c.query().windows[0].rect,
      (r) => r.height === OUT.height - BAR,
      { what: "A resized to the workarea" });
    const rect = c.query().windows[0].rect;
    assert.equal(rect.y, 0, "island rect carries no bar band (world y=0)");

    // The dock compensates on the lens: camera y=-30 places world y=0 at
    // glass y=30, just below the bar.
    await settled(() => c.query().outputs[0],
      (o) => o.cameraY === -BAR && o.cameraX === 0,
      { what: "camera docked below the bar" });

    // On glass: bar pixels above, window pixels below.
    await settled(() => c.frameReadback(),
      (px) => px && pixelMatches(pixelAt(px, OUT.width, 640, 15), barBgra, 8)
        && pixelMatches(pixelAt(px, OUT.width, 640, 200), winBgra, 8),
      { timeoutMs: 3000, intervalMs: 16, what: "bar above, window below" });

    // A second workspace docks with the same lens offset; slots pack at
    // workarea width + gutter (the bar is top-anchored, so pitch is
    // unchanged -- the point is the y offset rides every dock).
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.show-at-index", { index: 2 });
    await settled(() => c.query().outputs[0],
      (o) => o.cameraX === OUT.width + GUTTER && o.cameraY === -BAR,
      { what: "workspace 2 docks below the bar too" });
    await c.runtime.invokeAction("workspace.show-at-index", { index: 1 });

    // The bar disconnects: the zone clears, the workarea grows back, and
    // the world re-solves -- viewport-sized islands, camera re-docked at
    // the slot itself.
    panel.child.kill("SIGTERM");
    await settled(() => c.query().windows[0].rect,
      (r) => r.height === OUT.height,
      { what: "A regrows to the full viewport" });
    await settled(() => c.query().outputs[0],
      (o) => o.cameraY === 0 && o.cameraX === 0,
      { what: "camera re-docked at the bare slot" });
  } finally {
    await c.teardown();
  }
});
