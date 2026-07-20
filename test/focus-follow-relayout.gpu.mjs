// Follow-pointer focus across a relayout. When a reorder (promote / swap)
// moves a different window under a STATIONARY pointer, the seat re-derives
// pointer focus once the resize transaction applies the new tiles: the
// window now under the cursor gets wl_pointer enter (hover state) without
// any device motion. Keyboard focus is policy: the repick dispatches
// "pointer-repick", which the default follow-pointer policy IGNORES (the
// world moved, not the pointer -- keyboard focus stays with the window the
// user had), and focus: { followRepick: true } opts back into refocusing
// whatever lands under the cursor.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, loadDawn, pointerMotion, waitFor } from "./harness.mjs";
import { masterStackLayout } from "../packages/plugin-layout-default/dist/master-stack.js";

const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)"
  : (!loadDawn() ? "dawn.node not built" : false);

const LAYOUT = { masterFraction: 0.5, gap: 0 };

// Shared flow: two tiled windows, pointer parked on the master tile (which
// hover-focuses it), then the stack window is promoted so the tiles swap
// under the stationary pointer. Returns ids + a settled post-swap snapshot
// (pointer focus moved to the promoted window = the repick ran).
async function promoteUnderStationaryPointer(c) {
  const out = { width: c.dims.width, height: c.dims.height };
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
  const snap = c.query();
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
  // stays put, so the promoted window ends up under the cursor. The
  // repick's wl_pointer enter (pointerFocus) signals the swap applied.
  await c.runtime.invokeNamespace("workspace", "reorder", [stackId, "promote"]);
  const after = await waitFor(c.query,
    (s) => s.pointerFocus === stackId,
    { what: "wl_pointer focus follows the window now under the cursor", timeoutMs: 4000 });
  const promoted = after.windows.find((w) => w.surfaceId === stackId);
  assert.deepEqual(promoted.rect, tiles[0], "promoted window occupies the master tile");
  return { masterId, stackId };
}

test("reorder under a stationary pointer: hover state follows, keyboard focus stays", { skip }, async () => {
  // focusOnMap:false so pointer-driven focus is the only focus source.
  const c = await setupCompositor({
    layout: LAYOUT,
    focus: { policy: "follow-pointer", focusOnMap: false },
  });
  try {
    const { masterId } = await promoteUnderStationaryPointer(c);
    // The repick refreshed hover state (asserted in the helper), but the
    // default policy ignores pointer-repick: keyboard focus stays with
    // the window the user had, which now occupies the stack tile.
    assert.equal(c.query().keyboardFocus, masterId,
      "keyboard focus must stay with the previously focused window");
  } finally {
    await c.teardown();
  }
});

test("reorder under a stationary pointer: followRepick refocuses the window now under it", { skip }, async () => {
  const c = await setupCompositor({
    layout: LAYOUT,
    focus: { policy: "follow-pointer", focusOnMap: false, followRepick: true },
  });
  try {
    const { stackId } = await promoteUnderStationaryPointer(c);
    await waitFor(c.query, (s) => s.keyboardFocus === stackId,
      { what: "keyboard focus follows the window now under the pointer", timeoutMs: 4000 });
  } finally {
    await c.teardown();
  }
});
