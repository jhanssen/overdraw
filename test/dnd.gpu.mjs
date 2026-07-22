// Drag-and-drop end-to-end: a source client starts a drag on a pointer button
// press over its window; the harness moves the pointer onto a target window and
// releases; the target receives the dropped payload (copy action) and the bytes
// round-trip. Exercises the full DnD vertical: start_drag -> seat pointer grab ->
// data_device enter/motion/leave -> action negotiation -> drop -> receive/finish.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupCompositor, canRunGpu, buildBin, pointerMotion, pointerButton } from "./harness.mjs";

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
