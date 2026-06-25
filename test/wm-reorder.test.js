// Pure-unit tests for the WM's focusOrder() + reorder() primitives (the
// engine behind the focus.next/prev and layout.promote/swap-* actions). No
// GPU/Wayland: a mock compositor records setStack; the inline master-stack
// driver settles layout synchronously.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockCompositor() {
  const stacks = [];
  return {
    setSurfaceLayout() {},
    setStack(ids) { stacks.push([...ids]); },
    _stacks: stacks,
  };
}

const rec = (id) => ({ resource: { __id: id } });
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

function setup() {
  const comp = mockCompositor();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  return { wm, comp };
}

// Add a window and make it drawable (focusOrder/reorder only count windows
// with content).
async function addMapped(wm, id) {
  wm.addWindow(id, rec(id));
  await wm.settled();
  wm.windowHasContent(id);
}

const order = (wm) => wm.state.windows.map((w) => w.surfaceId);

test('focusOrder: lists mapped toplevels in stack order; skips contentless', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);            // 2 becomes master (front)
  wm.addWindow(3, rec(3));           // added but no content yet
  await wm.settled();
  assert.deepEqual(wm.focusOrder(), [2, 1]);
  wm.windowHasContent(3);
  // addWindow unshifts, so 3 is now at the front of the array.
  assert.deepEqual(wm.focusOrder(), [3, 2, 1]);
});

test('focusOrder: skips invisible windows (visible=false)', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await wm.propose(1, { visible: false }, 'user-input');
  assert.deepEqual(wm.focusOrder(), [2]);
});

test('reorder promote: moves a stack window to the master slot', async () => {
  const { wm, comp } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);           // order: [3, 2, 1]
  assert.deepEqual(order(wm), [3, 2, 1]);
  const stacksBefore = comp._stacks.length;
  assert.equal(wm.reorder(1, 'promote'), true);
  assert.deepEqual(order(wm), [1, 3, 2]);
  await wm.settled();
  // A restack was pushed reflecting the new order.
  assert.ok(comp._stacks.length > stacksBefore);
  assert.deepEqual(comp._stacks.at(-1), [1, 3, 2]);
});

test('reorder promote: already master is a no-op', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);           // order: [2, 1]
  assert.equal(wm.reorder(2, 'promote'), false);
  assert.deepEqual(order(wm), [2, 1]);
});

test('reorder swap-next / swap-prev: exchange with the stack neighbour', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);           // order: [3, 2, 1]
  assert.equal(wm.reorder(3, 'swap-next'), true);
  assert.deepEqual(order(wm), [2, 3, 1]);
  assert.equal(wm.reorder(3, 'swap-prev'), true);
  assert.deepEqual(order(wm), [3, 2, 1]);
});

test('reorder swap: no wrap at the ends', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);           // order: [2, 1]
  assert.equal(wm.reorder(2, 'swap-prev'), false);  // already at head
  assert.equal(wm.reorder(1, 'swap-next'), false);  // already at tail
  assert.deepEqual(order(wm), [2, 1]);
});

test('reorder: unknown surface is a no-op', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  assert.equal(wm.reorder(99, 'promote'), false);
  assert.equal(wm.reorder(99, 'swap-next'), false);
});

test('reorder swap skips a contentless window between two tiles', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  wm.addWindow(3, rec(3));          // contentless; sits at array front
  await wm.settled();
  // Array: [3(no content), 2, 1]; focusable: [2, 1].
  assert.deepEqual(wm.focusOrder(), [2, 1]);
  // swap-next on 2 swaps with 1 (the next focusable), not the contentless 3.
  assert.equal(wm.reorder(2, 'swap-next'), true);
  assert.deepEqual(order(wm), [3, 1, 2]);
});
