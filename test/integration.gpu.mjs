// Integration tests: drive real libwayland clients against the full stack and
// assert on compositor STATE via state.query() (geometry / stacking / focus).
// No pixel comparison. Requires GPU + host Wayland; auto-skips otherwise.
//
// Run: npm run test:gpu   (node --test 'test/*.gpu.mjs')
// Deliberately NOT in the default `npm test` glob ('test/**/*.test.js'), which
// stays GPU-free; these are gated on a GPU render node + dawn.node (auto-skip if absent).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setupCompositor, canRunGpu, pointerMotion, pointerButton,
  pointerMotionHost, keyHost,
} from "./harness.mjs";

const BTN_LEFT = 0x110;
const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";

test("client maps -> appears in query() with title/app_id; tiled to full output", { skip }, async () => {
  const c = await setupCompositor();
  try {
    // Client requests 300x200 but tiling owns geometry: a single window fills the
    // output regardless of the client's chosen buffer size.
    const { ready } = c.spawnClient(["--size", "300x200", "--title", "term", "--app-id", "foo"]);
    await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "1 window" });
    const w = snap.windows[0];
    assert.equal(w.title, "term");
    assert.equal(w.appId, "foo");
    assert.equal(w.role, "xdg_toplevel");
    assert.equal(w.rect.width, c.dims.width, "single window tile width = output width");
    assert.equal(w.rect.height, c.dims.height, "single window tile height = output height");
    assert.deepEqual(snap.stack, [w.surfaceId]);
  } finally {
    await c.teardown();
  }
});

test("two clients -> both windows; newest is master (front of layout order)", { skip }, async () => {
  const c = await setupCompositor();
  try {
    const a = c.spawnClient(["--title", "a"]); await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "first window" });
    const b = c.spawnClient(["--title", "b"]); await b.ready;
    // Wait for the resize transaction to settle (each client must re-render
    // at its new tile size before the WM commits the new geometry; see
    // wm/index.ts applyLayout transaction path). Without this we'd read
    // stale rects: A still 1280-wide, B already 640-wide.
    const snap = await c.waitFor(c.query,
      (s) => s.windows.length === 2
        && s.windows[0].rect.width + s.windows[1].rect.width === c.dims.width,
      { what: "two tiles settled" });
    assert.equal(snap.stack.length, 2);
    // Master-stack: the most recently mapped window becomes master = front of the
    // layout order (windows[0]).
    assert.equal(snap.windows[0].title, "b", "newest window is master");
    assert.equal(snap.windows[1].title, "a");
    // Tiles do not overlap: master (left) + stack (right) partition the width.
    assert.equal(snap.windows[0].rect.width + snap.windows[1].rect.width, c.dims.width);
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

// Host-path coverage: drive input through the REAL WaylandInputBackend
// normalization (injectHostInput) rather than the pre-normalized sink. This is
// the path the manual input-smoke test exercised (minus the GPU-process host
// wl_seat listener, which needs a real device). Asserting focus via query()
// proves the fixed-point<->logical conversion + backend + seat chain end to end.
test("host input path: motion via injectHostInput drives focus (supersedes input-smoke)", { skip }, async () => {
  const c = await setupCompositor({ focus: { policy: "follow-pointer", focusOnMap: false } });
  try {
    const { ready } = c.spawnClient(["--size", "300x200"]); await ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window" });
    const w = snap.windows[0];
    assert.equal(snap.keyboardFocus, null);

    // Logical coords -> addon encodes to wl_fixed_t -> backend converts back.
    pointerMotionHost(c.addon, w.rect.x + 7, w.rect.y + 9);
    const inside = await c.waitFor(
      c.query, (s) => s.pointerFocus === w.surfaceId && s.keyboardFocus === w.surfaceId,
      { what: "host-path focus inside" });
    assert.equal(inside.pointerFocus, w.surfaceId);

    // Move off; focus clears -- proves leave routing through the real backend.
    pointerMotionHost(c.addon, w.rect.x + w.rect.width + 400, w.rect.y + w.rect.height + 400);
    const outside = await c.waitFor(
      c.query, (s) => s.pointerFocus === null && s.keyboardFocus === null,
      { what: "host-path focus cleared" });
    assert.equal(outside.keyboardFocus, null);
  } finally {
    await c.teardown();
  }
});

test("host input path: keyboard key to focused window does not throw (supersedes input-smoke keys)", { skip }, async () => {
  const c = await setupCompositor({ focus: { policy: "follow-pointer", focusOnMap: true } });
  try {
    const { ready } = c.spawnClient([]); await ready;
    const snap = await c.waitFor(
      c.query, (s) => s.windows.length === 1 && s.keyboardFocus === s.windows[0].surfaceId,
      { what: "kb focus on map" });
    // KEY_A = 30 (evdev). Routed through backend -> seat -> focused client's
    // wl_keyboard. We can't observe client receipt via query(), but this drives
    // the xkb keyUpdate + wl_keyboard.send_key path; assert it completes and
    // focus is unchanged.
    keyHost(c.addon, 30, true);
    keyHost(c.addon, 30, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(c.query().keyboardFocus, snap.keyboardFocus);
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
