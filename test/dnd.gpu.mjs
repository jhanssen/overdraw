// Drag-and-drop end-to-end: a source client starts a drag on a pointer button
// press over its window; the harness moves the pointer onto a target window and
// releases; the target receives the dropped payload (copy action) and the bytes
// round-trip. Exercises the full DnD vertical: start_drag -> seat pointer grab ->
// data_device enter/motion/leave -> action negotiation -> drop -> receive/finish.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, pointerMotion, pointerButton,
         settled, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const DND = buildBin("dnd-test-client");
const MIME = "text/plain;charset=utf-8";
const PAYLOAD = "overdraw-dnd-drop-99";
const BTN_LEFT = 0x110;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const center = (r) => ({ x: r.x + (r.width >> 1), y: r.y + (r.height >> 1) });

test("drag-and-drop: source drag dropped on target transfers the payload", { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 1000, height: 700 } });
  try {
    // Map source then target; both are toplevels placed by the WM cascade.
    const source = c.spawnClient(["--source", MIME, PAYLOAD],
      { bin: DND, readyMarker: "[dnd-client] source mapped" });
    await source.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "source window" });
    const target = c.spawnClient(["--target", MIME],
      { bin: DND, readyMarker: "[dnd-client] target mapped" });
    await target.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "target window" });

    // Wait for the retile to LAND, not just be computed: the source keeps
    // its old (full-region) drawn rect inside the resize-tx hold until it
    // re-renders or the hold times out. Dropping while the rects still
    // overlap would hit whichever window is on top at that point, not
    // necessarily the target.
    const disjoint = (a, b) =>
      a.x + a.width <= b.x || b.x + b.width <= a.x
      || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const snap = await c.waitFor(c.query, (s) => {
      const src = s.windows.find((w) => w.title === "dnd-source");
      const tgt = s.windows.find((w) => w.title === "dnd-target");
      return src && tgt && disjoint(src.rect, tgt.rect);
    }, { what: "windows tiled side by side" });

    const srcWin = snap.windows.find((w) => w.title === "dnd-source");
    const tgtWin = snap.windows.find((w) => w.title === "dnd-target");
    assert.ok(srcWin && tgtWin, "both windows present");
    const sp = center(srcWin.rect), tp = center(tgtWin.rect);

    // Move the pointer over the source (so it gets wl_pointer.enter + a serial),
    // then press -> the source calls start_drag.
    pointerMotion(c.addon, sp.x, sp.y);
    await sleep(30);
    pointerButton(c.addon, BTN_LEFT, true);
    await source.waitForLine(/drag-started/, { what: "drag started" });

    // Drag over the target: motion enters the target's data_device; release drops.
    pointerMotion(c.addon, tp.x, tp.y);
    await sleep(30);
    pointerButton(c.addon, BTN_LEFT, false);

    const out = await target.waitForLine(/\[dnd-client\] dropped: /, { what: "drop", timeoutMs: 5000 });
    const got = out.match(/\[dnd-client\] dropped: (.*)/)[1].trim();
    assert.equal(got, PAYLOAD, `DnD payload transfers on drop; got "${got}"`);
  } finally {
    await c.teardown();
  }
});

// Drag-icon stacking: the icon draws on top of the window under the pointer,
// and the full draw stack (including the target's subsurface) survives both
// the drag and the drop. The stack goes through its single owner
// (rebuildStackWithPopups + state.dragIconId); a windows-only stack push
// would blank the subsurface during the drag and leave it blanked after.
test("drag icon draws on top and subsurfaces survive the drag", { skip }, async () => {
  const c = await setupCompositor({ headless: { width: 1000, height: 700 } });
  try {
    const source = c.spawnClient(["--source", MIME, PAYLOAD, "--icon", "--stay"],
      { bin: DND, readyMarker: "[dnd-client] source mapped" });
    await source.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "source window" });
    const target = c.spawnClient(["--target", MIME, "--sub", "--stay"],
      { bin: DND, readyMarker: "[dnd-client] target mapped" });
    await target.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "target window" });

    const disjoint = (a, b) =>
      a.x + a.width <= b.x || b.x + b.width <= a.x
      || a.y + a.height <= b.y || b.y + b.height <= a.y;
    const snap = await c.waitFor(c.query, (s) => {
      const src = s.windows.find((w) => w.title === "dnd-source");
      const tgt = s.windows.find((w) => w.title === "dnd-target");
      return src && tgt && disjoint(src.rect, tgt.rect);
    }, { what: "windows tiled side by side" });
    const srcWin = snap.windows.find((w) => w.title === "dnd-source");
    const tgtWin = snap.windows.find((w) => w.title === "dnd-target");
    const sp = center(srcWin.rect), tp = center(tgtWin.rect);

    // BGRA colors the client draws (ARGB8888 little-endian -> BGRA bytes).
    const ICON = [255, 0, 255, 255];   // 0xFFFF00FF magenta
    const SUB  = [224, 32, 32, 255];   // 0xFF2020E0 blue
    // The subsurface sits at parent-relative (10,10), 30x30; sample inside it.
    const subX = tgtWin.rect.x + 10 + 15, subY = tgtWin.rect.y + 10 + 15;

    // The subsurface is composited before any drag starts.
    await settled(c.frameReadback, (px) =>
      px && pixelMatches(pixelAt(px, 1000, subX, subY), SUB, 4),
      { what: "target subsurface visible pre-drag" });

    pointerMotion(c.addon, sp.x, sp.y);
    await sleep(30);
    pointerButton(c.addon, BTN_LEFT, true);
    await source.waitForLine(/drag-started/, { what: "drag started" });

    // Drag over the target: the icon (40x40, top-left at the pointer) draws
    // above the target, and the subsurface keeps drawing.
    pointerMotion(c.addon, tp.x, tp.y);
    await settled(c.frameReadback, (px) =>
      px && pixelMatches(pixelAt(px, 1000, tp.x + 12, tp.y + 12), ICON, 4),
      { what: "drag icon composited over the target" });
    const during = await c.frameReadback();
    assert.ok(pixelMatches(pixelAt(during, 1000, subX, subY), SUB, 4),
      "subsurface still composited while the drag icon shows");

    // Drop: payload round-trips, the icon disappears, the subsurface remains.
    pointerButton(c.addon, BTN_LEFT, false);
    const out = await target.waitForLine(/\[dnd-client\] dropped: /, { what: "drop", timeoutMs: 5000 });
    assert.equal(out.match(/\[dnd-client\] dropped: (.*)/)[1].trim(), PAYLOAD);
    await settled(c.frameReadback, (px) =>
      px && !pixelMatches(pixelAt(px, 1000, tp.x + 12, tp.y + 12), ICON, 4),
      { what: "drag icon gone after drop" });
    const after = await c.frameReadback();
    assert.ok(pixelMatches(pixelAt(after, 1000, subX, subY), SUB, 4),
      "subsurface still composited after the drop");
  } finally {
    await c.teardown();
  }
});
