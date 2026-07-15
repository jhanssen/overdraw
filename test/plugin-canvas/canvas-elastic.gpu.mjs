// GPU integration: elastic islands (canvas: { world: true, elastic: true }).
// A workspace's island grows one half-viewport column per managed member
// and tiles as equal columns (the layout provider's columns hint); the
// docked camera scrolls within the strip to keep the focused window
// visible (reorders retile the focused window and the camera follows).

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
    config: { canvas: { world: true, elastic: true } },
  });
  try {
    const cA = 0xff3030c0;   // blue-ish
    const cB = 0xff30c030;   // green-ish
    const cC = 0xffc03030;   // red-ish

    // Three windows on workspace 1. Members are master-front (newest
    // first), so columns land C | B | A across a 3-column strip.
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
    assert.equal(rectOf(cId).x, 0, "newest member leads the strip");
    assert.equal(rectOf(aId).x, 2 * COL, "oldest member at the tail");

    // C is focused (focusOnMap) at the strip's head: no scroll. C and B
    // composite in the viewport; A is off-view right.
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "camera at strip head" });
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, 320, 360), argbToBgra(cC), 4)
      && pixelMatches(pixelAt(p, OUT.width, 960, 360), argbToBgra(cB), 4));

    // Swap the focused window C toward the tail twice: C retiles to the
    // third column and the camera scrolls to keep it visible.
    await c.runtime.invokeNamespace("workspace", "reorder", [cId, "swap-next"]);
    await c.runtime.invokeNamespace("workspace", "reorder", [cId, "swap-next"]);
    await settled(() => rectOf(cId).x, (x) => x === 2 * COL, { what: "C at the tail" });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 2 * COL + COL - OUT.width,   // strip end minus viewport
      { what: "camera scrolled to the strip end" });
    // Members are now B | A | C; the view covers columns 2 and 3 (A | C).
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, 320, 360), argbToBgra(cA), 4)
      && pixelMatches(pixelAt(p, OUT.width, 960, 360), argbToBgra(cC), 4));

    // Promote C back to the strip's head: the camera scrolls home.
    await c.runtime.invokeNamespace("workspace", "reorder", [cId, "promote"]);
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "camera back at the strip head" });
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, 320, 360), argbToBgra(cC), 4));
  } finally {
    await c.teardown();
  }
});
