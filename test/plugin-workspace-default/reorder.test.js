// Workspace reorder: promote / swap-next / swap-prev mutate the workspace's
// ordered member list. The list IS the per-workspace master-stack order
// the layout-driver consumes; promote moves a surface to master (index 0),
// swap-next/swap-prev exchange with the adjacent member tail-ward /
// master-ward.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  init, applyMap, reorder,
} from '../../packages/plugin-workspace-default/dist/registry.js';

function setup() {
  // applyMap inserts at master (index 0); mapping in order 101 -> 102 -> 103
  // leaves members = [103, 102, 101] (newest is master).
  let state = init('DP-1').state;
  state = applyMap(state, 101, 0, 'DP-1').state;
  state = applyMap(state, 102, 0, 'DP-1').state;
  state = applyMap(state, 103, 0, 'DP-1').state;
  return state;
}

function members(state) {
  return [...state.byHandle.values()][0].members;
}

test('applyMap: new windows become master (index 0)', () => {
  const state = setup();
  assert.deepEqual(members(state), [103, 102, 101]);
});

test('reorder promote: moves a tail-ward surface to master (index 0)', () => {
  let state = setup();
  // members = [103, 102, 101]; promote 101 -> [101, 103, 102].
  const r = reorder(state, 101, 'promote');
  state = r.state;
  assert.equal(r.changed, true);
  assert.deepEqual(members(state), [101, 103, 102]);
});

test('reorder promote: already master is a no-op', () => {
  let state = setup();
  const r = reorder(state, 103, 'promote');
  assert.equal(r.changed, false);
  assert.deepEqual(members(r.state), [103, 102, 101]);
  assert.deepEqual(r.sideEffects, []);
});

test('reorder swap-next: swaps with the next tail-ward member', () => {
  let state = setup();
  // members = [103, 102, 101]; swap-next on 103 -> [102, 103, 101].
  const r = reorder(state, 103, 'swap-next');
  state = r.state;
  assert.equal(r.changed, true);
  assert.deepEqual(members(state), [102, 103, 101]);
});

test('reorder swap-next: tail member is a no-op (no wrap)', () => {
  let state = setup();
  // 101 is at the tail.
  const r = reorder(state, 101, 'swap-next');
  assert.equal(r.changed, false);
  assert.deepEqual(members(r.state), [103, 102, 101]);
});

test('reorder swap-prev: swaps with the previous master-ward member', () => {
  let state = setup();
  // members = [103, 102, 101]; swap-prev on 101 -> [103, 101, 102].
  const r = reorder(state, 101, 'swap-prev');
  state = r.state;
  assert.equal(r.changed, true);
  assert.deepEqual(members(state), [103, 101, 102]);
});

test('reorder swap-prev: master is a no-op (no wrap)', () => {
  let state = setup();
  const r = reorder(state, 103, 'swap-prev');
  assert.equal(r.changed, false);
  assert.deepEqual(members(r.state), [103, 102, 101]);
});

test('reorder: unknown surface throws', () => {
  const state = setup();
  assert.throws(() => reorder(state, 999, 'promote'), /not tracked/);
});

test('reorder on a shown workspace emits a setOutputStack side effect with the new order', () => {
  let state = setup();
  // members = [103, 102, 101]; promote 102 -> [102, 103, 101].
  const r = reorder(state, 102, 'promote');
  const stacks = r.sideEffects.filter((e) => e.kind === 'setOutputStack');
  assert.equal(stacks.length, 1);
  assert.equal(stacks[0].outputId, 0);
  assert.deepEqual(stacks[0].ids, [102, 103, 101]);
});

test('reorder moveToIndex: places the surface at the final index', () => {
  let state = setup();
  // members = [103, 102, 101]; move 103 to index 2 -> [102, 101, 103].
  const r = reorder(state, 103, { moveToIndex: 2 });
  state = r.state;
  assert.equal(r.changed, true);
  assert.deepEqual(members(state), [102, 101, 103]);
});

test('reorder moveToIndex: moving master-ward shifts the others tail-ward', () => {
  let state = setup();
  // members = [103, 102, 101]; move 101 to index 0 -> [101, 103, 102].
  const r = reorder(state, 101, { moveToIndex: 0 });
  state = r.state;
  assert.equal(r.changed, true);
  assert.deepEqual(members(state), [101, 103, 102]);
});

test('reorder moveToIndex: clamps out-of-range and no-ops on same index', () => {
  let state = setup();
  // Out of range clamps to the tail.
  const r1 = reorder(state, 103, { moveToIndex: 99 });
  state = r1.state;
  assert.equal(r1.changed, true);
  assert.deepEqual(members(state), [102, 101, 103]);
  // Already there: no-op, no side effects.
  const r2 = reorder(state, 103, { moveToIndex: 99 });
  assert.equal(r2.changed, false);
  assert.deepEqual(r2.sideEffects, []);
  // Negative clamps to master.
  const r3 = reorder(state, 103, { moveToIndex: -3 });
  assert.equal(r3.changed, true);
  assert.deepEqual(members(r3.state), [103, 102, 101]);
});
