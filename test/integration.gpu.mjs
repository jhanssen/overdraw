// Integration tests: drive real libwayland clients against the full stack and
// assert on compositor STATE via state.query() (geometry / stacking / focus).
// No pixel comparison. Requires GPU + host Wayland; auto-skips otherwise.
//
// Run: npm run test:gpu   (node --test 'test/*.gpu.mjs')
// Deliberately NOT in the default `npm test` glob ('test/**/*.test.js'), which
// stays GPU-free; these are gated on a GPU + WAYLAND_DISPLAY (auto-skip if unset).

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pointerMotion, pointerButton } from "./harness.mjs";

const BTN_LEFT = 0x110;
const skip = canRunGpu() ? false : "needs GPU + host Wayland (WAYLAND_DISPLAY unset)";

test("client maps -> appears in query() with title/app_id/size", { skip }, async () => {
  const c = await setupCompositor();
  try {
    const { ready } = c.spawnClient(["--size", "300x200", "--title", "term", "--app-id", "foo"]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "1 window" });
    const w = snap.windows[0];
    assert.equal(w.title, "term");
    assert.equal(w.appId, "foo");
    assert.equal(w.role, "xdg_toplevel");
    assert.equal(w.rect.width, 300);
    assert.equal(w.rect.height, 200);
    assert.deepEqual(snap.stack, [w.surfaceId]);
  } finally {
    await c.teardown();
  }
});

test("two clients -> both windows, stack back-to-front in map order", { skip }, async () => {
  const c = await setupCompositor();
  try {
    const a = c.spawnClient(["--title", "a"]); await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "first window" });
    const b = c.spawnClient(["--title", "b"]); await b.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "second window" });
    assert.equal(snap.stack.length, 2);
    // Second-mapped is on top (last in back-to-front stack).
    const top = snap.windows[snap.stack.length - 1];
    assert.equal(top.title, "b");
  } finally {
    await c.teardown();
  }
});

test("focus-on-map: a freshly-mapped window takes keyboard focus", { skip }, async () => {
  const c = await setupCompositor({ focus: { policy: "follow-pointer", focusOnMap: true } });
  try {
    const { ready } = c.spawnClient([]); await ready;
    const snap = await c.waitFor(
      c.query, (s) => s.windows.length === 1 && s.keyboardFocus === s.windows[0].surfaceId,
      { what: "kb focus on map" });
    assert.equal(snap.keyboardFocus, snap.windows[0].surfaceId);
  } finally {
    await c.teardown();
  }
});

test("follow-pointer: motion over window sets pointer + keyboard focus; off clears", { skip }, async () => {
  const c = await setupCompositor({ focus: { policy: "follow-pointer", focusOnMap: false } });
  try {
    const { ready } = c.spawnClient(["--size", "300x200"]); await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });
    const w = snap.windows[0];
    // No focusOnMap, so no focus yet.
    assert.equal(snap.keyboardFocus, null);

    // Move into the window's rect.
    pointerMotion(c.addon, w.rect.x + 5, w.rect.y + 5);
    const inside = await c.waitFor(
      c.query, (s) => s.pointerFocus === w.surfaceId && s.keyboardFocus === w.surfaceId,
      { what: "focus inside" });
    assert.equal(inside.pointerFocus, w.surfaceId);
    assert.equal(inside.keyboardFocus, w.surfaceId);

    // Move far outside -> both cleared.
    pointerMotion(c.addon, w.rect.x + w.rect.width + 500, w.rect.y + w.rect.height + 500);
    const outside = await c.waitFor(
      c.query, (s) => s.pointerFocus === null && s.keyboardFocus === null,
      { what: "focus cleared" });
    assert.equal(outside.pointerFocus, null);
    assert.equal(outside.keyboardFocus, null);
  } finally {
    await c.teardown();
  }
});

test("click-to-focus: kb focus changes on button press, persists when pointer leaves", { skip }, async () => {
  const c = await setupCompositor({ focus: { policy: "click-to-focus", focusOnMap: false } });
  try {
    const { ready } = c.spawnClient(["--size", "300x200"]); await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });
    const w = snap.windows[0];
    assert.equal(snap.keyboardFocus, null);

    // Motion alone does NOT set keyboard focus under click-to-focus.
    pointerMotion(c.addon, w.rect.x + 5, w.rect.y + 5);
    const moved = await c.waitFor(c.query, (s) => s.pointerFocus === w.surfaceId, { what: "pointer focus" });
    assert.equal(moved.keyboardFocus, null, "no kb focus from motion under click-to-focus");

    // Press -> kb focus.
    pointerButton(c.addon, BTN_LEFT, true);
    const clicked = await c.waitFor(c.query, (s) => s.keyboardFocus === w.surfaceId, { what: "kb focus on click" });
    assert.equal(clicked.keyboardFocus, w.surfaceId);
    pointerButton(c.addon, BTN_LEFT, false);

    // Pointer leaves -> kb focus persists (click-to-focus).
    pointerMotion(c.addon, w.rect.x + w.rect.width + 500, w.rect.y + w.rect.height + 500);
    const left = await c.waitFor(c.query, (s) => s.pointerFocus === null, { what: "pointer cleared" });
    assert.equal(left.keyboardFocus, w.surfaceId, "kb focus persists after pointer leaves");
  } finally {
    await c.teardown();
  }
});
