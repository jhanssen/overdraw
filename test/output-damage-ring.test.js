// Pure-unit tests for OutputDamageRing: the per-scanout-slot composite damage
// bookkeeping behind Layer-2 composite-scissor. Covers first-sight = full,
// per-slot reset, the full-output collapse, and -- the part the GPU path can't
// exercise headlessly -- multi-slot buffer-age accumulation (a slot left
// unrendered for several frames repaints all damage since it last rendered).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OutputDamageRing } from '../packages/core/dist/gpu/output-damage-ring.js';

const A = 1n, B = 2n, C = 3n;

function ring(w = 100, h = 100) {
  const r = new OutputDamageRing();
  r.setBounds(w, h);
  return r;
}

test('first sight of a slot = full; reset after take', () => {
  const r = ring();
  assert.deepEqual(r.take(A), { mode: 'full' }, 'never-seen slot repaints fully');
  // Now tracked + empty: a take with no damage is still full (safe).
  assert.deepEqual(r.take(A), { mode: 'full' }, 'empty slot -> full (safe)');
});

test('damage to a tracked slot yields its bounding box, then resets', () => {
  const r = ring();
  r.take(A);                       // track A (empty)
  r.damageRect(10, 20, 30, 40);
  assert.deepEqual(r.take(A), { mode: 'partial', box: { x: 10, y: 20, w: 30, h: 40 } });
  assert.deepEqual(r.take(A), { mode: 'full' }, 'consumed: empty again -> full');
});

test('bounding box spans multiple disjoint rects', () => {
  const r = ring();
  r.take(A);
  r.damageRect(10, 10, 10, 10);
  r.damageRect(70, 80, 10, 10);
  assert.deepEqual(r.take(A), { mode: 'partial', box: { x: 10, y: 10, w: 70, h: 80 } });
});

test('multi-slot buffer-age: each slot repaints all damage since IT last rendered', () => {
  const r = ring();
  // Track both slots (first sight each).
  assert.deepEqual(r.take(A), { mode: 'full' });
  assert.deepEqual(r.take(B), { mode: 'full' });

  r.damageRect(10, 10, 20, 20);    // damage #1 -> both A and B
  // A renders now: sees damage #1, resets.
  assert.deepEqual(r.take(A), { mode: 'partial', box: { x: 10, y: 10, w: 20, h: 20 } });

  r.damageRect(50, 50, 10, 10);    // damage #2 -> both A and B
  // B renders now: it has NOT rendered since before damage #1, so it must
  // repaint BOTH #1 and #2 (buffer age = 2).
  assert.deepEqual(r.take(B), { mode: 'partial', box: { x: 10, y: 10, w: 50, h: 50 } });

  // A renders again: it reset after #1, so it only owes #2.
  assert.deepEqual(r.take(A), { mode: 'partial', box: { x: 50, y: 50, w: 10, h: 10 } });
});

test('full() forces every slot to repaint fully', () => {
  const r = ring();
  r.take(A); r.take(B);
  r.damageRect(5, 5, 5, 5);
  r.full();
  assert.deepEqual(r.take(A), { mode: 'full' });
  assert.deepEqual(r.take(B), { mode: 'full' });
});

test('a box covering the whole output collapses to full', () => {
  const r = ring(80, 60);
  r.take(A);
  r.damageRect(0, 0, 80, 60);
  assert.deepEqual(r.take(A), { mode: 'full' }, 'whole-output damage -> cheaper clear path');
});

test('damage is clipped to output bounds', () => {
  const r = ring(64, 64);
  r.take(A);
  r.damageRect(50, 50, 100, 100);  // overhangs
  assert.deepEqual(r.take(A), { mode: 'partial', box: { x: 50, y: 50, w: 14, h: 14 } });
});

test('damage with no tracked slots is dropped (no full-output leak on first acquire)', () => {
  const r = ring();
  r.damageRect(10, 10, 10, 10);    // no slots tracked yet -> ignored
  // First acquire is full regardless (the slot has never been rendered).
  assert.deepEqual(r.take(A), { mode: 'full' });
  // And nothing carried over: the dropped damage does not reappear.
  assert.deepEqual(r.take(A), { mode: 'full' });
});
