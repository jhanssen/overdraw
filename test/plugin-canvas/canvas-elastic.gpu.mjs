// GPU integration: an elastic island under the columns layout -- a niri
// strip (canvas-design.md §5: `layout.mode` declares the algorithm,
// `canvas.elastic` only sizes the island to the layout's measure). The
// island grows one half-viewport column per managed member; the docked
// camera scrolls within the strip to keep the focused window visible
// (reorders retile the focused window and the camera follows).

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const COL = OUT.width / 2;             // elastic column = 0.5 × viewport
const FILL = "--fill-configured";

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

async function readUntil(c, pred, { timeoutMs = 3000 } = {}) {
  return await settled(() => c.frameReadback(),
    (px) => px && pred(px),
    { timeoutMs, intervalMs: 16, what: "frame readback" });
}

test("elastic: strip grows per member; camera scrolls to follow focus", { skip }, async () => {
  const c = await setupCompositor({
    headless: OUT,
    focus: { policy: "follow-pointer", focusOnMap: true },
    config: {
      canvas: { world: true, elastic: true },
      layout: { mode: "columns" },
    },
  });
  try {
    const cA = 0xff3030c0;   // blue-ish
    const cB = 0xff30c030;   // green-ish
    const cC = 0xffc03030;   // red-ish

    // Three windows on workspace 1. Columns mode appends, so the strip
    // reads A | B | C left to right in the order they opened.
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    const s1 = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    const aId = s1.windows[0].surfaceId;
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]);
    await b.ready;
    const s2 = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "B mapped" });
    const bId = s2.windows.find((w) => w.surfaceId !== aId).surfaceId;
    const d = c.spawnClient([FILL, "--color", cC.toString(16)]);
    await d.ready;
    // Strip geometry settles at columns 0, COL, 2*COL -- the island grew
    // to 3 columns (1920) while the viewport stays 1280.
    const s3 = await c.waitFor(c.query,
      (s) => s.windows.length === 3
        && s.windows.every((w) => w.rect.width === COL)
        && JSON.stringify(s.windows.map((w) => w.rect.x).sort((p, q) => p - q))
          === JSON.stringify([0, COL, 2 * COL]),
      { what: "three equal columns across the strip" });
    const cId = s3.windows.find((w) => w.surfaceId !== aId && w.surfaceId !== bId).surfaceId;
    const rectOf = (id) => c.query().windows.find((w) => w.surfaceId === id).rect;
    assert.equal(rectOf(cId).x, 2 * COL, "newest member joins the tail");
    assert.equal(rectOf(aId).x, 0, "oldest member leads the strip");

    // C is focused (focusOnMap) and is the tail column: nothing lies to
    // its right, so it sits flush right and B fills the rest of the view.
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 2 * COL + COL - OUT.width, { what: "camera at the strip end" });
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, 320, 360), argbToBgra(cB), 4)
      && pixelMatches(pixelAt(p, OUT.width, 960, 360), argbToBgra(cC), 4));

    // Swap the focused C toward the head twice (C | A | B): C becomes the
    // head column, so it sits flush left and the camera scrolls home.
    await c.runtime.invokeNamespace("workspace", "reorder", [cId, "swap-prev"]);
    await c.runtime.invokeNamespace("workspace", "reorder", [cId, "swap-prev"]);
    await settled(() => rectOf(cId).x, (x) => x === 0, { what: "C at the head" });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "camera back at the strip head" });
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, 320, 360), argbToBgra(cC), 4)
      && pixelMatches(pixelAt(p, OUT.width, 960, 360), argbToBgra(cA), 4));

    // Swap C back one (A | C | B): its column (COL..2*COL) is fully
    // visible at the current scroll, and focus-driven reveals are
    // MINIMAL -- the camera stays put rather than re-centering, so the
    // view keeps showing A | C.
    await c.runtime.invokeNamespace("workspace", "reorder", [cId, "swap-next"]);
    await settled(() => rectOf(cId).x, (x) => x === COL, { what: "C in the middle" });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "camera stays at the strip head" });
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, 320, 360), argbToBgra(cA), 4)
      && pixelMatches(pixelAt(p, OUT.width, 960, 360), argbToBgra(cC), 4));
  } finally {
    await c.teardown();
  }
});
