// Pure-unit tests for the window manager (src/wm). The WM is layout-policy-
// agnostic post-Phase 2; these tests inject an inline master-stack driver to
// keep asserting on tile rects (the master-stack algorithm itself is tested
// in test/plugin-layout-default/).
//
// No GPU/Wayland: a mock compositor records setSurfaceLayout/setStack and a
// mock configure sink records configure(surfaceId, w, h) calls. Covers the
// proactive lifecycle (addWindow inserts + schedules layout; windowHasContent
// makes drawable), unmap reflow, subtractive decoration insets, and windowAt
// hit-testing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockCompositor() {
  const layouts = [];
  const stacks = [];
  return {
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
    setStack(ids) { stacks.push([...ids]); },
    _layouts: layouts,
    _stacks: stacks,
  };
}

const rec = (id) => ({ resource: { __id: id } });
const OUT = { width: 1000, height: 600 };

// Build a WM with a configure-sink recorder + the inline master-stack driver.
function setup(out = OUT) {
  const comp = mockCompositor();
  const configures = [];
  const sink = (id, w, h) => configures.push({ id, w, h });
  const wm = createWm(comp, out, {
    configure: sink,
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  return { wm, comp, configures };
}

// Add a window AND wait for the layout to settle. The common path for tests
// that want a drawable window at its assigned rect.
async function addMapped(wm, id) {
  wm.addWindow(id, rec(id));
  await wm.settled();
  return wm.windowHasContent(id);
}

test('addWindow: single window fills the output and is configured to that size', async () => {
  const { wm, configures } = setup();
  wm.addWindow(1, rec(1));
  await wm.settled();
  // Configured proactively (before content) to the full-output content size.
  assert.deepEqual(configures.at(-1), { id: 1, w: 1000, h: 600 });
  // The WM record now reflects the master-stack rect.
  assert.deepEqual(wm.state.windows[0].rect, { x: 0, y: 0, width: 1000, height: 600 });
});

test('windowHasContent: makes the window drawable and pushes layout + stack', async () => {
  const { wm, comp } = setup();
  wm.addWindow(1, rec(1));
  await wm.settled();
  // No layout-stack push yet (window has no content): only configure went out.
  const layoutsBefore = comp._layouts.length;
  const r = wm.windowHasContent(1);
  assert.deepEqual(r, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(comp._layouts.at(-1), { id: 1, x: 0, y: 0, w: 1000, h: 600 });
  assert.equal(comp._layouts.length, layoutsBefore + 1);
  assert.deepEqual(comp._stacks.at(-1), [1]);
});

test('addWindow: second window becomes master; both reconfigured to half', async () => {
  const { wm, configures } = setup();
  await addMapped(wm, 1);            // single -> full output
  configures.length = 0;             // clear; observe the reflow
  wm.addWindow(2, rec(2));           // new window becomes master (front)
  await wm.settled();
  // master-stack(2): master left half, stack (the old window) right half.
  // Order is [2 (master), 1 (stack)].
  assert.deepEqual(wm.state.windows.map((w) => w.surfaceId), [2, 1]);
  // Both windows get a new content size (1000x600 -> 500x600), so both reconfigured.
  const byId = Object.fromEntries(configures.map((c) => [c.id, c]));
  assert.deepEqual(byId[2], { id: 2, w: 500, h: 600 });
  assert.deepEqual(byId[1], { id: 1, w: 500, h: 600 });
});

test('addWindow: master/stack rects match the layout (3 windows)', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  // order [3, 2, 1]: 3 master, 2 & 1 stack (top-to-bottom).
  const w = (id) => wm.state.windows.find((x) => x.surfaceId === id);
  assert.deepEqual(w(3).rect, { x: 0, y: 0, width: 500, height: 600 });
  assert.deepEqual(w(2).rect, { x: 500, y: 0, width: 500, height: 300 });
  assert.deepEqual(w(1).rect, { x: 500, y: 300, width: 500, height: 300 });
});

test('addWindow: idempotent for an already-added surface', async () => {
  const { wm } = setup();
  wm.addWindow(1, rec(1));
  await wm.settled();
  const n = wm.state.windows.length;
  wm.addWindow(1, rec(1));
  await wm.settled();
  assert.equal(wm.state.windows.length, n);
});

test('stack: only windows with content are drawn, in list order', async () => {
  const { wm, comp } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  // window 3 added but no content yet -> not in the stack.
  wm.addWindow(3, rec(3));
  await wm.settled();
  // order is [3,2,1] but 3 is contentless; stack should be [2,1].
  assert.deepEqual(comp._stacks.at(-1), [2, 1]);
});

test('unmapWindow: removes + reflows + reconfigures the survivors', async () => {
  const { wm, configures } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);   // order [2,1], both 500x600
  configures.length = 0;
  wm.unmapWindow(2);
  await wm.settled();
  // one window left -> back to full output; survivor reconfigured.
  assert.deepEqual(wm.state.windows.map((w) => w.surfaceId), [1]);
  assert.deepEqual(configures.at(-1), { id: 1, w: 1000, h: 600 });
});

test('unmapWindow: unknown id is a no-op', async () => {
  const { wm, comp } = setup();
  await addMapped(wm, 1);
  const before = comp._stacks.length;
  wm.unmapWindow(999);
  await wm.settled();
  assert.equal(comp._stacks.length, before);
});

test('windowAt: hits the content rect; topmost (front) wins overlap', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);   // [2 master left half, 1 stack right half]
  // master (2) occupies x in [0,500); a point there hits 2.
  assert.equal(wm.windowAt(10, 10)?.surfaceId, 2);
  // stack (1) occupies x in [500,1000); a point there hits 1.
  assert.equal(wm.windowAt(600, 10)?.surfaceId, 1);
});

test('windowAt: miss outside any window returns null', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);   // fills 1000x600
  assert.equal(wm.windowAt(2000, 2000), null);
});

test('setInsets: SUBTRACTIVE -> content shrinks inside the fixed outer tile', async () => {
  const { wm, comp, configures } = setup();
  await addMapped(wm, 1);   // outer = content = (0,0,1000,600)
  configures.length = 0;
  const g = wm.setInsets(1, { top: 30, right: 5, bottom: 5, left: 5 });
  assert.ok(g);
  assert.deepEqual(g.insets, { top: 30, right: 5, bottom: 5, left: 5 });
  // outer tile unchanged (decoration's region); content shrunk inside it.
  assert.deepEqual(g.outerRect, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(g.contentRect, { x: 5, y: 30, width: 990, height: 565 });
  // WM state content rect updated to the shrunk rect.
  assert.deepEqual(wm.state.windows[0].rect, { x: 5, y: 30, width: 990, height: 565 });
  // client reconfigured to the shrunk content size, and layout repositioned.
  assert.deepEqual(configures.at(-1), { id: 1, w: 990, h: 565 });
  assert.deepEqual(comp._layouts.at(-1), { id: 1, x: 5, y: 30, w: 990, h: 565 });
});

test('setInsets: decoration stays on-screen at outer tile even for a (0,0) window', async () => {
  // The bug this fixes: an outer-anchored tile means the decoration band is INSIDE
  // the on-screen tile, never at negative coordinates.
  const { wm } = setup();
  await addMapped(wm, 1);
  wm.setInsets(1, { top: 40, right: 0, bottom: 0, left: 0 });
  const outer = wm.outerRectOf(1);
  assert.ok(outer.x >= 0 && outer.y >= 0, 'outer tile is on-screen');
  assert.equal(outer.y, 0, 'decoration top band starts at y=0, not -40');
});

test('setInsets: clamps negative insets to zero', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  const g = wm.setInsets(1, { top: -10, right: 0, bottom: 0, left: 0 });
  assert.equal(g.insets.top, 0);
  assert.deepEqual(g.contentRect, { x: 0, y: 0, width: 1000, height: 600 });
});

test('setInsets: unknown surface -> undefined', () => {
  const { wm } = setup();
  assert.equal(wm.setInsets(99, { top: 1, right: 1, bottom: 1, left: 1 }), undefined);
});

test('setInsets: replace -> second call sets new insets (not cumulative)', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  wm.setInsets(1, { top: 50, right: 0, bottom: 0, left: 0 });
  const g = wm.setInsets(1, { top: 10, right: 0, bottom: 0, left: 0 });
  assert.equal(g.insets.top, 10, 'replaced, not added');
  assert.deepEqual(g.contentRect, { x: 0, y: 10, width: 1000, height: 590 });
});

test('outerRectOf: returns the outer tile; unknown -> undefined', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  assert.deepEqual(wm.outerRectOf(1), { x: 0, y: 0, width: 1000, height: 600 });
  wm.setInsets(1, { top: 10, right: 0, bottom: 0, left: 0 });
  // outer tile unchanged by insets (content shrinks, outer is the tile).
  assert.deepEqual(wm.outerRectOf(1), { x: 0, y: 0, width: 1000, height: 600 });
  assert.equal(wm.outerRectOf(99), undefined);
});
