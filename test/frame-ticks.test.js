// Pure-unit tests for the overlay frame-tick service (surface.onFrame pacing).
// No GPU: a mock compositor records requestPresentForCallback; the tests drive
// dispatchForOutput/idleTick directly and assert one-shot delivery, per-output
// matching, and the idle force-present gating (awaitingFlip / dirty outputs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOverlayFrameTicks } from '../packages/core/dist/plugins/frame-ticks.js';

function rig({ awaiting = new Set(), dirty = new Set(), outputs = [0, 1] } = {}) {
  const forced = [];
  const ticks = createOverlayFrameTicks({
    compositor: {
      isOutputDirty: (o) => dirty.has(o),
      requestPresentForCallback: (id) => forced.push(id),
    },
    awaitingFlip: () => awaiting,
    outputIds: () => outputs,
  });
  return { ticks, forced, awaiting, dirty };
}

test('dispatchForOutput: delivers one-shot to matching output only', () => {
  const { ticks } = rig();
  const got = [];
  ticks.arm(10, 0, (t) => got.push(['a', t]));
  ticks.arm(11, 1, (t) => got.push(['b', t]));

  ticks.dispatchForOutput(0, 111);
  assert.deepEqual(got, [['a', 111]]);
  // One-shot: a second flip does not re-deliver surface 10.
  ticks.dispatchForOutput(0, 222);
  assert.deepEqual(got, [['a', 111]]);
  ticks.dispatchForOutput(1, 333);
  assert.deepEqual(got, [['a', 111], ['b', 333]]);
});

test('dispatchForOutput: null outputId ticks on any output; re-arm replaces', () => {
  const { ticks } = rig();
  const got = [];
  ticks.arm(10, null, () => got.push('first'));
  ticks.arm(10, null, () => got.push('second'));   // replaces
  ticks.dispatchForOutput(1, 1);
  assert.deepEqual(got, ['second']);
});

test('drop discards a pending tick', () => {
  const { ticks } = rig();
  const got = [];
  ticks.arm(10, 0, () => got.push('x'));
  ticks.drop(10);
  ticks.dispatchForOutput(0, 1);
  assert.deepEqual(got, []);
});

test('idleTick: forces a present only when the output is fully idle', () => {
  const { ticks, forced, awaiting, dirty } = rig();
  ticks.arm(10, 0, () => {});

  // Flip in flight: its flip-complete will deliver; no force.
  awaiting.add(0);
  ticks.idleTick();
  assert.deepEqual(forced, []);
  awaiting.clear();

  // Output dirty: a present is coming this pass; no force.
  dirty.add(0);
  ticks.idleTick();
  assert.deepEqual(forced, []);
  dirty.clear();

  // Fully idle: force-present so the flip (and tick) comes.
  ticks.idleTick();
  assert.deepEqual(forced, [10]);
});

test('idleTick: null outputId gates against all outputs', () => {
  const { ticks, forced, awaiting } = rig({ outputs: [0, 1] });
  ticks.arm(10, null, () => {});
  awaiting.add(1);            // any busy output -> a tick is coming; no force
  ticks.idleTick();
  assert.deepEqual(forced, []);
  awaiting.clear();
  ticks.idleTick();
  assert.deepEqual(forced, [10]);
});
