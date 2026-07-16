// GPU integration: drag-pan (workspace.pan-grab / pan-grab-end + the
// seat's camera-pan grab). While the grab holds, pointer motion pans the
// output's camera 1:1 (content follows the hand; transient writes, no
// client delivery); release settles the camera where it was dragged
// (residency sweep + pointer repick) and free roaming continues there.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setupCompositor, canRunGpu, pixelAt, pixelMatches, settled,
  pointerMotion, pointerButton,
} from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const PITCH = OUT.width + 128;
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

function enteredOf(c, surfaceId) {
  const rec = c.state.surfacesById?.get(surfaceId);
  return rec?.enteredOutputs ? [...rec.enteredOutputs] : [];
}

test("drag-pan: motion pans the camera; release settles + repicks", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, config: { canvas: { world: true } } });
  try {
    const cA = 0xff3030c0;   // blue-ish on ws1 (slot 0)
    const cB = 0xff30c030;   // green-ish on ws2 (slot 1)

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
      (x) => x === 0, { what: "docked at slot 0" });
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 0, { what: "B hidden before the drag" });

    // Park the pointer, start the drag-pan, and drag LEFT by one pitch:
    // the world follows the hand, so the camera pans right onto slot 1.
    pointerMotion(c.addon, 1200, 360);
    await c.runtime.invokeAction("workspace.pan-grab", {});
    assert.equal(c.state.seat.grab?.kind, "camera-pan", "camera-pan grab installed");
    // Two motion steps (deltas accumulate): 1200 -> 500 -> 1200-PITCH.
    pointerMotion(c.addon, 500, 360);
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 700, { what: "camera follows the first step" });
    pointerMotion(c.addon, 1200 - PITCH, 360);
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === PITCH, { what: "camera panned one pitch" });
    // Mid-drag: transient writes -- residency hasn't swept yet.
    assert.deepEqual(enteredOf(c, bId), [], "no residency sweep mid-drag");
    // B composites through the live camera (the union stack rides).
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), argbToBgra(cB), 4));

    // The BUTTON release ends the drag (endOnButtonUp) -- releasing the
    // button while the binding's modifier is still held must stop the
    // pan. The settled write sweeps residency; roaming continues at the
    // dragged position; the shown workspace never changed.
    pointerButton(c.addon, 0x112 /* BTN_MIDDLE */, false);
    await settled(() => c.state.seat.grab, (g) => g === null, { what: "grab ended on button-up" });
    // The binding's releaseAction still fires at chord release; it must
    // be an idempotent no-op against the already-ended grab.
    await c.runtime.invokeAction("workspace.pan-grab-end", {});
    assert.equal(c.state.seat.grab, null, "grab released");
    await settled(() => enteredOf(c, bId),
      (e) => e.length === 1 && e[0] === 0, { what: "B resident after release" });
    await settled(() => enteredOf(c, aId),
      (e) => e.length === 0, { what: "A left after release" });
    assert.equal(c.query().outputs[0].cameraX, PITCH, "camera stays parked");
    const cur = await c.runtime.invokeAction("workspace.current", {});
    assert.equal(cur.index, 1, "drag-pan never touches the shown workspace");

    // Unfit returns home from the dragged position.
    await c.runtime.invokeAction("workspace.unfit", {});
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 0, { what: "unfit re-docks at slot 0" });
    await readUntil(c, (p) => pixelMatches(pixelAt(p, OUT.width, 640, 360), argbToBgra(cA), 4));
  } finally {
    await c.teardown();
  }
});

test("drag-pan: a chain-consumed button release still ends the grab", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, config: { canvas: { world: true } } });
  try {
    const a = c.spawnClient([FILL, "--color", "ff3030c0"]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });

    // A held binding chord consumes the button-up (the release
    // participates in the held instance: button lifts, modifier still
    // down). Stub that exact behavior; the seat's endOnButtonUp must
    // fire regardless -- this is the "keeps panning with Mod held" bug.
    c.state.bindingChain = {
      dispatchPress: () => ({ consume: false }),
      dispatchRelease: () => ({ consume: true }),
    };
    pointerMotion(c.addon, 800, 360);
    await c.runtime.invokeAction("workspace.pan-grab", {});
    assert.equal(c.state.seat.grab?.kind, "camera-pan");
    pointerMotion(c.addon, 400, 360);
    await settled(() => c.query().outputs[0].cameraX,
      (x) => x === 400, { what: "camera panned" });

    pointerButton(c.addon, 0x112 /* BTN_MIDDLE */, false);
    await settled(() => c.state.seat.grab, (g) => g === null,
      { what: "grab ended despite the consumed release" });
    assert.equal(c.query().outputs[0].cameraX, 400, "camera parked where dragged");
  } finally {
    c.state.bindingChain = null;
    await c.teardown();
  }
});

// The hotkey move grab, exercised the way a Mod+LMB drag reaches it while
// fitted: deltas convert glass->world through the fit camera (the window
// tracks the hand 1:1 on glass, not slower), the chain-consumed button
// release still ends the grab (endOnButtonUp -- the chord's modifier is
// still held), and the drop at THAT moment's pointer re-parents the
// window to the island under the cursor and re-tiles it.
test("move-drag while fitted: 1:1 tracking, chain-consumed release drops onto the target island", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, config: { canvas: { world: true } } });
  try {
    const a = c.spawnClient([FILL, "--color", "ff3030c0"]);
    await a.ready;
    const s1 = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    const aId = s1.windows[0].surfaceId;
    await c.runtime.invokeAction("workspace.create", { persistent: true });
    await c.state.wm.settled();

    await c.runtime.invokeAction("workspace.fit", {});
    const cam = await settled(() => c.query().outputs[0],
      (o) => o.cameraZoom < 1, { what: "fit camera engaged" });
    const world = (gx, gy) => ({
      x: cam.cameraX + gx / cam.cameraZoom,
      y: cam.cameraY + gy / cam.cameraZoom,
    });

    // Grab A at its center: pointer to A's glass position, then install
    // the grab exactly as main.ts's window.grab-requested handler does.
    const start = c.state.wm.outerRectOf(aId);
    const g0 = {
      x: Math.round((start.x + start.width / 2 - cam.cameraX) * cam.cameraZoom),
      y: Math.round((start.y + start.height / 2 - cam.cameraY) * cam.cameraZoom),
    };
    pointerMotion(c.addon, g0.x, g0.y);
    await c.state.wm.propose(aId, { tiling: "floating" }, "user-input");
    c.state.seat.beginGrab({
      kind: "move", surfaceId: aId,
      anchorX: g0.x, anchorY: g0.y,
      startRect: start,
      wasManaged: true,
      endOnButtonUp: true,
    });

    // Drag toward ws2's island (slot 1). The window must track the hand
    // 1:1 on glass: world delta = glass delta / zoom.
    const g1 = { x: g0.x + 300, y: g0.y };
    pointerMotion(c.addon, g1.x, g1.y);
    const expectX = start.x + 300 / cam.cameraZoom;
    await settled(() => c.state.wm.outerRectOf(aId),
      (r) => r && Math.abs(r.x - expectX) < 1.5,
      { what: `window follows the hand through the zoom (expect x ${expectX})` });

    // Land the pointer over ws2's island center and release the button
    // with the chord's modifier still held (the chain consumes the
    // release). The grab must end NOW, dropping at this position.
    const w1 = world(g1.x, g1.y);
    const target = { x: PITCH + 640, y: w1.y };
    const g2 = {
      x: Math.round((target.x - cam.cameraX) * cam.cameraZoom),
      y: Math.round((target.y - cam.cameraY) * cam.cameraZoom),
    };
    pointerMotion(c.addon, g2.x, g2.y);
    c.state.bindingChain = {
      dispatchPress: () => ({ consume: false }),
      dispatchRelease: () => ({ consume: true }),
    };
    pointerButton(c.addon, 0x110 /* BTN_LEFT */, false);
    await settled(() => c.state.seat.grab, (g) => g === null,
      { what: "move grab ended despite the consumed release" });

    // The drop re-parented A to workspace 2 and re-tiled it (it was
    // managed before the grab floated it).
    await settled(() => c.runtime.invokeAction("workspace.list", {}),
      (list) => {
        const ws2 = list.find((w) => w.index === 2);
        return !!ws2 && ws2.members.includes(aId);
      }, { what: "A re-parented to workspace 2" });
    await settled(() => c.state.wm.getWindowState(aId),
      (ws) => ws?.tiling === "managed", { what: "A re-tiled on drop" });
  } finally {
    c.state.bindingChain = null;
    await c.teardown();
  }
});
