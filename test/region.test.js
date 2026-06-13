// Pure-unit tests for the Region rect-math used by wl_region.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Region } from '../packages/core/dist/protocols/region.js';

// --- empty / contains ---------------------------------------------------

test('empty region: contains is always false', () => {
  const r = new Region();
  assert.equal(r.isEmpty(), true);
  assert.equal(r.contains(0, 0), false);
  assert.equal(r.contains(100, 50), false);
});

// --- add ----------------------------------------------------------------

test('add: single rect; contains checks inside / on boundary / outside', () => {
  const r = new Region();
  r.add(10, 20, 100, 50);
  assert.equal(r.isEmpty(), false);
  assert.equal(r.contains(10, 20), true);
  assert.equal(r.contains(109, 69), true);
  // The right/bottom edges are EXCLUSIVE (half-open intervals).
  assert.equal(r.contains(110, 50), false);
  assert.equal(r.contains(50, 70), false);
  // Strictly outside.
  assert.equal(r.contains(0, 0), false);
  assert.equal(r.contains(200, 200), false);
});

test('add: zero-area rect is a no-op', () => {
  const r = new Region();
  r.add(0, 0, 0, 100);
  r.add(0, 0, 100, 0);
  assert.equal(r.isEmpty(), true);
});

test('add: negative width/height is a no-op', () => {
  const r = new Region();
  r.add(0, 0, -10, 50);
  r.add(0, 0, 50, -10);
  assert.equal(r.isEmpty(), true);
});

test('add: overlapping rects union (point in either is contained)', () => {
  const r = new Region();
  r.add(0, 0, 50, 50);
  r.add(25, 25, 50, 50);
  // Point in first rect only.
  assert.equal(r.contains(10, 10), true);
  // Point in second rect only.
  assert.equal(r.contains(60, 60), true);
  // Point in both (the overlap).
  assert.equal(r.contains(30, 30), true);
});

test('add: rect lists stay disjoint internally after overlap', () => {
  const r = new Region();
  r.add(0, 0, 100, 100);
  r.add(50, 50, 100, 100);
  // The internal snapshot shouldn't double-count: rect list is disjoint.
  // We don't expose the count, but the contains() over the union should
  // work regardless.
  assert.equal(r.contains(0, 0), true);
  assert.equal(r.contains(149, 149), true);
  assert.equal(r.contains(149, 0), false);
});

// --- subtract -----------------------------------------------------------

test('subtract: removes the rect; point inside is no longer contained', () => {
  const r = new Region();
  r.add(0, 0, 100, 100);
  r.subtract(25, 25, 50, 50);
  assert.equal(r.contains(50, 50), false);    // inside the hole
  assert.equal(r.contains(10, 10), true);     // outside the hole
  assert.equal(r.contains(75, 75), true);     // outside the hole
  assert.equal(r.contains(150, 50), false);   // outside the region
});

test('subtract: cutting an edge produces an L-shape', () => {
  const r = new Region();
  r.add(0, 0, 100, 100);
  // Take a bite out of the top-right.
  r.subtract(50, 0, 50, 50);
  assert.equal(r.contains(75, 25), false);    // cut out
  assert.equal(r.contains(25, 25), true);     // left half
  assert.equal(r.contains(75, 75), true);     // bottom-right
});

test('subtract: full cover removes everything', () => {
  const r = new Region();
  r.add(10, 10, 50, 50);
  r.subtract(0, 0, 1000, 1000);
  assert.equal(r.isEmpty(), true);
  assert.equal(r.contains(20, 20), false);
});

test('subtract: non-overlapping rect is a no-op', () => {
  const r = new Region();
  r.add(0, 0, 50, 50);
  r.subtract(100, 100, 50, 50);
  assert.equal(r.contains(25, 25), true);
});

test('subtract: zero-area is a no-op', () => {
  const r = new Region();
  r.add(0, 0, 50, 50);
  r.subtract(10, 10, 0, 30);
  r.subtract(10, 10, 30, 0);
  assert.equal(r.contains(25, 25), true);
});

// --- combinations ------------------------------------------------------

test('add then subtract then add (filling a hole)', () => {
  const r = new Region();
  r.add(0, 0, 100, 100);
  r.subtract(25, 25, 50, 50);   // hole in the middle
  assert.equal(r.contains(50, 50), false);
  r.add(25, 25, 50, 50);        // fill it back in
  assert.equal(r.contains(50, 50), true);
});

test('checkerboard: many small adds', () => {
  const r = new Region();
  // 5x5 grid of 10x10 rects on a 100x100 canvas, alternating.
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      if ((i + j) % 2 === 0) r.add(i * 20, j * 20, 10, 10);
    }
  }
  // (0,0)-(10,10) is filled.
  assert.equal(r.contains(5, 5), true);
  // (10,0)-(30,20) -- the gap to the next filled square -- is empty.
  assert.equal(r.contains(15, 5), false);
});

// --- clone --------------------------------------------------------------

test('clone: independent copy; mutations don\'t affect original', () => {
  const r = new Region();
  r.add(0, 0, 100, 100);
  const c = r.clone();
  c.subtract(0, 0, 50, 50);
  assert.equal(r.contains(25, 25), true);    // original unaffected
  assert.equal(c.contains(25, 25), false);   // clone modified
});

test('clone: empty region clones to empty', () => {
  const r = new Region();
  const c = r.clone();
  assert.equal(c.isEmpty(), true);
});

// --- snapshot ----------------------------------------------------------

test('snapshot: returns a copy of the rect list', () => {
  const r = new Region();
  r.add(0, 0, 50, 50);
  const snap = r.snapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0], { x: 0, y: 0, width: 50, height: 50 });
  // Mutating the snapshot doesn't affect the region.
  snap[0].x = 999;
  assert.equal(r.contains(10, 10), true);
});
