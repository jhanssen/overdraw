// Pure-unit tests for the window placement stub. No GPU, no Wayland, no addon.
// placeWindow is a deterministic function of the WM state (window count +
// output size); these tests pin its current cascade behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeWindow } from '../dist/wm/placement.js';

const CASCADE_STEP = 80;

function wm(windowCount, output = { width: 1920, height: 1080 }) {
  return { output, windows: new Array(windowCount).fill(null) };
}

test('placeWindow: first window at origin, size 0 (use content size)', () => {
  const r = placeWindow(wm(0));
  assert.deepEqual(r, { x: 0, y: 0, width: 0, height: 0 });
});

test('placeWindow: each window cascades down-right by CASCADE_STEP', () => {
  assert.deepEqual(placeWindow(wm(1)), { x: CASCADE_STEP, y: CASCADE_STEP, width: 0, height: 0 });
  assert.deepEqual(placeWindow(wm(2)), { x: 2 * CASCADE_STEP, y: 2 * CASCADE_STEP, width: 0, height: 0 });
});

test('placeWindow: wraps within output bounds (modulo width-100 / height-100)', () => {
  const out = { width: 500, height: 400 };
  // n*step % (width-100): with width 500 -> mod 400; height 400 -> mod 300.
  const n = 6; // 6*80 = 480
  const r = placeWindow(wm(n, out));
  assert.equal(r.x, 480 % 400); // 80
  assert.equal(r.y, 480 % 300); // 180
});

test('placeWindow: returns integer coordinates', () => {
  const r = placeWindow(wm(3));
  assert.equal(r.x, r.x | 0);
  assert.equal(r.y, r.y | 0);
});

test('placeWindow: degenerate tiny output does not produce NaN/Infinity', () => {
  const r = placeWindow(wm(2, { width: 1, height: 1 }));
  assert.ok(Number.isFinite(r.x));
  assert.ok(Number.isFinite(r.y));
});
