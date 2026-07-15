// GPU integration: canvas world mode (canvas: { world: true }). Workspaces
// live at world slots along the output's row; `show` docks the camera
// instantly; windows tile at their slot's world rect and composite through
// the camera; hidden-workspace members reside nowhere (stack-gated
// residency) while keeping their world rects.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const PITCH = OUT.width + 128;  // slot pitch = output width + SLOT_GUTTER
const FILL = "--fill-configured";

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
const BLACK = [0, 0, 0, 255];

async function readUntil(c, pred, { timeoutMs = 3000 } = {}) {
  return await settled(() => c.frameReadback(),
    (px) => px && pred(px),
    { timeoutMs, intervalMs: 16, what: "frame readback" });
}

function enteredOf(c, surfaceId) {
  const rec = c.state.surfacesById?.get(surfaceId);
  return rec?.enteredOutputs ? [...rec.enteredOutputs] : [];
}

test("world mode: workspaces at slots, camera docks on show", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, config: { canvas: { world: true } } });
  try {
    const cA = 0xff3030c0;   // blue-ish
    const cB = 0xff30c030;   // green-ish
    const bgraA = argbToBgra(cA);
    const bgraB = argbToBgra(cB);

    // A maps onto workspace 1 = slot 0 (world x = 0); identity camera.
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    const s1 = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    const aId = s1.windows[0].surfaceId;
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), bgraA, 4));
    assert.equal(c.query().outputs[0].cameraX, 0);

    // Create workspace 2 and show it: the camera docks one pitch over onto
    // an empty slot; A is hidden (resides nowhere) but keeps its world rect.
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.show-at-index", { index: 2 });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === PITCH, { what: "camera docked at slot 1" });
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), BLACK, 4));
    await settled(() => enteredOf(c, aId),
      (e) => e.length === 0, { what: "A left all outputs while hidden" });
    assert.equal(c.query().windows.find((w) => w.surfaceId === aId).rect.x, 0,
      "A keeps its slot-0 world rect while hidden");

    // B maps onto the SHOWN workspace 2: tiled at slot 1's world rect,
    // composited through the docked camera.
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]);
    await b.ready;
    const s2 = await c.waitFor(c.query,
      (s) => s.windows.length === 2
        && s.windows.some((w) => w.surfaceId !== aId && w.rect.x === PITCH
          && w.rect.width === OUT.width),
      { what: "B tiled at slot 1's world rect" });
    const bId = s2.windows.find((w) => w.surfaceId !== aId).surfaceId;
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), bgraB, 4));
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 1 && e[0] === 0, { what: "B resident on output 0" });

    // Back to workspace 1: camera returns to the row origin, A composites
    // and re-enters, B hides.
    await c.runtime.invokeAction("workspace.show-at-index", { index: 1 });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "camera docked back at slot 0" });
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), bgraA, 4));
    await settled(() => enteredOf(c, aId),
      (e) => e.length === 1 && e[0] === 0, { what: "A re-entered on show" });
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 0, { what: "B left while hidden" });
  } finally {
    await c.teardown();
  }
});
