// GPU integration: workspace.fit / workspace.unfit (canvas world mode).
// fit zooms the output's camera out to frame a consecutive workspace
// range: the framed workspaces' members all composite (scaled) and become
// resident, while registry truth (shown workspace) stays put. unfit zooms
// back in to the shown slot and re-hides the rest.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const PITCH = OUT.width + 128;  // slot pitch = output width + SLOT_GUTTER

// Fit camera over slots 0..1: bounds 0..(PITCH + width), centered,
// letterboxed vertically.
const BOUNDS_W = PITCH + OUT.width;
const ZOOM = OUT.width / BOUNDS_W;
const CAM_X = BOUNDS_W / 2 - (OUT.width / ZOOM) / 2;                 // ~0
const CAM_Y = (OUT.height - OUT.height / ZOOM) / 2;                  // < 0

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

// Glass position of a world point under the fit camera.
function glass(wx, wy) {
  return [Math.round((wx - CAM_X) * ZOOM), Math.round((wy - CAM_Y) * ZOOM)];
}

test("world mode: fit frames both workspaces; unfit zooms back", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, config: { canvas: { world: true } } });
  try {
    const cA = 0xff3030c0;   // blue-ish
    const cB = 0xff30c030;   // green-ish
    const bgraA = argbToBgra(cA);
    const bgraB = argbToBgra(cB);

    // A on workspace 1 (slot 0); B on workspace 2 (slot 1); back on 1.
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    const s1 = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    const aId = s1.windows[0].surfaceId;
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.show-at-index", { index: 2 });
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]);
    await b.ready;
    const s2 = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "B mapped" });
    const bId = s2.windows.find((w) => w.surfaceId !== aId).surfaceId;
    await c.runtime.invokeAction("workspace.show-at-index", { index: 1 });
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "camera docked at slot 0" });
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 0, { what: "B hidden before fit" });

    // Fit the whole row: camera zooms out + letterboxes, both windows
    // composite at their scaled slot positions with void between them,
    // both become resident, and the shown workspace is still 1.
    await c.runtime.invokeAction("workspace.fit", {});
    await settled(() => c.query().outputs[0],
      (o) => Math.abs(o.cameraZoom - ZOOM) < 1e-9
        && Math.abs(o.cameraX - CAM_X) < 1e-6
        && Math.abs(o.cameraY - CAM_Y) < 1e-6,
      { what: "fit camera settled" });
    const [ax, ay] = glass(OUT.width / 2, OUT.height / 2);           // A's slot center
    const [bx, by] = glass(PITCH + OUT.width / 2, OUT.height / 2);   // B's slot center
    await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, ax, ay), bgraA, 8)
      && pixelMatches(pixelAt(p, OUT.width, bx, by), bgraB, 8)
      && pixelMatches(pixelAt(p, OUT.width, 640, 8), BLACK, 4));     // letterbox void
    await settled(() => enteredOf(c, aId),
      (e) => e.length === 1 && e[0] === 0, { what: "A resident while fitted" });
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 1 && e[0] === 0, { what: "B resident while fitted" });
    const cur = await c.runtime.invokeAction("workspace.current", {});
    assert.equal(cur.index, 1, "fit leaves the shown workspace alone");

    // Unfit: camera back to the shown slot at zoom 1, B re-hides.
    await c.runtime.invokeAction("workspace.unfit", {});
    await settled(() => c.query().outputs[0],
      (o) => o.cameraZoom === 1 && o.cameraX === 0 && o.cameraY === 0,
      { what: "camera re-docked at slot 0" });
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), bgraA, 4));
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 0, { what: "B left after unfit" });
    const stack = c.state.outputToplevelStacks?.get(0) ?? [];
    assert.deepEqual([...stack], [aId], "stack collapsed to the shown workspace");
  } finally {
    await c.teardown();
  }
});
