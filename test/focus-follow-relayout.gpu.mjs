// Follow-pointer focus across a relayout. When a reorder (promote / swap)
// moves a different window under a STATIONARY pointer, the seat must re-derive
// pointer focus once the resize transaction applies the new tiles: the window
// now under the cursor gets wl_pointer enter and, under follow-pointer,
// keyboard focus -- without any device motion. Regression test for keyboard
// focus staying on the swapped-away window until the mouse next moved.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, loadDawn, pointerMotion, waitFor } from "./harness.mjs";
import { masterStackLayout } from "../packages/plugin-layout-default/dist/master-stack.js";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);

const LAYOUT = { masterFraction: 0.5, gap: 0 };

test("reorder under a stationary pointer refocuses the window now under it", { skip }, async () => {
  // focusOnMap:false so pointer-driven focus is the only focus source.
  const c = await setupCompositor({
    layout: LAYOUT,
    focus: { policy: "follow-pointer", focusOnMap: false },
  });
  const out = { width: c.dims.width, height: c.dims.height };
  try {
    const h1 = c.spawnClient(["--app-id", "w1", "--title", "w1"]);
    await h1.ready;
    const h2 = c.spawnClient(["--app-id", "w2", "--title", "w2"]);
    await h2.ready;

    // Wait for both windows to settle into the two master-stack tiles.
    // Retiling routes through the resize transaction; the harness-client
    // doesn't re-render on configure, so the broker's deadline drives the
    // apply and rects lag the spawn.
    const tiles = masterStackLayout(2, out, LAYOUT);
    const settled = (s) =>
      s.windows.length === 2
      && s.windows.every((w, i) =>
        w.rect.x === tiles[i].x && w.rect.y === tiles[i].y
        && w.rect.width === tiles[i].width && w.rect.height === tiles[i].height);
    await waitFor(c.query, settled, { what: "2 windows tiled", timeoutMs: 4000 });

    // windows[0] is the master (left tile), windows[1] the stack (right tile).
    let snap = c.query();
    const masterId = snap.windows[0].surfaceId;
    const stackId = snap.windows[1].surfaceId;

    // Park the pointer in the middle of the master tile; follow-pointer
    // gives the master keyboard focus.
    const px = tiles[0].x + (tiles[0].width >> 1);
    const py = tiles[0].y + (tiles[0].height >> 1);
    pointerMotion(c.addon, px, py);
    await waitFor(c.query, (s) => s.keyboardFocus === masterId,
      { what: "master focused after hover" });

    // Promote the stack window to master (same route the layout.promote /
    // swap actions take): the two windows trade tiles while the pointer
    // stays put, so the promoted window ends up under the cursor.
    await c.runtime.invokeNamespace("workspace", "reorder", [stackId, "promote"]);

    // Once the resize transaction applies the swap, the seat must repick:
    // pointer focus AND (follow-pointer) keyboard focus move to the window
    // now occupying the master tile -- with zero pointer motion in between.
    snap = await waitFor(c.query,
      (s) => s.keyboardFocus === stackId,
      { what: "focus follows the window now under the pointer", timeoutMs: 4000 });
    assert.equal(snap.pointerFocus, stackId,
      "wl_pointer focus must move to the window now under the cursor");
    const promoted = snap.windows.find((w) => w.surfaceId === stackId);
    assert.deepEqual(promoted.rect, tiles[0], "promoted window occupies the master tile");
  } finally {
    await c.teardown();
  }
});
