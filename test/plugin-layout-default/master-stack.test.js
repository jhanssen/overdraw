// Pure-unit tests for the master-stack layout engine. No GPU, no Wayland, no
// addon. masterStackLayout is a deterministic function of (windowCount, output,
// params); these pin the tiling geometry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { masterStackLayout, DEFAULT_LAYOUT } from '../../packages/plugin-layout-default/dist/master-stack.js';

const OUT = { width: 1000, height: 600 };

test('empty: no windows -> no rects', () => {
  assert.deepEqual(masterStackLayout(0, OUT), []);
});

test('single window fills the whole output (no gap)', () => {
  const r = masterStackLayout(1, OUT);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { x: 0, y: 0, width: 1000, height: 600 });
});

test('two windows: master left half, stack right half, full height', () => {
  const r = masterStackLayout(2, OUT, { masterFraction: 0.5, gap: 0 });
  assert.equal(r.length, 2);
  // master: left 50%
  assert.deepEqual(r[0], { x: 0, y: 0, width: 500, height: 600 });
  // stack (one window): right 50%, full height
  assert.deepEqual(r[1], { x: 500, y: 0, width: 500, height: 600 });
});

test('three windows: master left, two equal stack slices on the right', () => {
  const r = masterStackLayout(3, OUT, { masterFraction: 0.5, gap: 0 });
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { x: 0, y: 0, width: 500, height: 600 });
  // stack column x=500 w=500, two equal-height slices (300 each)
  assert.deepEqual(r[1], { x: 500, y: 0, width: 500, height: 300 });
  assert.deepEqual(r[2], { x: 500, y: 300, width: 500, height: 300 });
});

test('stack slices tile the full column height with no crack (rounding -> last slice)', () => {
  // height 601 / 3 stack windows would leave a remainder; last slice absorbs it.
  const out = { width: 1000, height: 601 };
  const r = masterStackLayout(4, out, { masterFraction: 0.5, gap: 0 });
  const stack = r.slice(1);
  // contiguous, no overlap, exactly fills [0, 601)
  assert.equal(stack[0].y, 0);
  for (let i = 1; i < stack.length; i++) {
    assert.equal(stack[i].y, stack[i - 1].y + stack[i - 1].height);
  }
  const last = stack[stack.length - 1];
  assert.equal(last.y + last.height, 601);
});

test('masterFraction controls the split', () => {
  const r = masterStackLayout(2, OUT, { masterFraction: 0.6, gap: 0 });
  assert.equal(r[0].width, 600);
  assert.equal(r[1].x, 600);
  assert.equal(r[1].width, 400);
});

test('masterFraction is clamped to [0.05, 0.95]', () => {
  const lo = masterStackLayout(2, OUT, { masterFraction: 0, gap: 0 });
  assert.ok(lo[0].width >= 1, 'master not collapsed to zero');
  const hi = masterStackLayout(2, OUT, { masterFraction: 1, gap: 0 });
  assert.ok(hi[1].width >= 1, 'stack not collapsed to zero');
});

test('gap insets the outer edge and separates tiles', () => {
  const g = 10;
  const r = masterStackLayout(2, OUT, { masterFraction: 0.5, gap: g });
  // outer gap: usable area starts at (g, g), size (W-2g, H-2g) = (980, 580)
  assert.equal(r[0].x, g);
  assert.equal(r[0].y, g);
  // master width = (usableW - g) * 0.5 = (980 - 10) * 0.5 = 485
  assert.equal(r[0].width, 485);
  assert.equal(r[0].height, 580);
  // stack starts after master + a gap
  assert.equal(r[1].x, g + 485 + g); // 505
  assert.equal(r[1].height, 580);
});

test('all rects are integers', () => {
  for (const n of [1, 2, 3, 5, 7]) {
    for (const r of masterStackLayout(n, OUT, { masterFraction: 0.5, gap: 7 })) {
      assert.equal(r.x, r.x | 0);
      assert.equal(r.y, r.y | 0);
      assert.equal(r.width, r.width | 0);
      assert.equal(r.height, r.height | 0);
    }
  }
});

test('degenerate tiny output: no NaN/Infinity, non-negative sizes', () => {
  for (const n of [1, 2, 4]) {
    for (const r of masterStackLayout(n, { width: 1, height: 1 }, { masterFraction: 0.5, gap: 5 })) {
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
      assert.ok(r.width >= 0 && r.height >= 0);
    }
  }
});

test('DEFAULT_LAYOUT is 0.5 fraction, 0 gap', () => {
  assert.equal(DEFAULT_LAYOUT.masterFraction, 0.5);
  assert.equal(DEFAULT_LAYOUT.gap, 0);
});

// ---- columns (elastic strips) ---------------------------------------------

test('columns: empty -> no rects', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  assert.deepEqual(columnsLayout(0, OUT), []);
});

test('columns: N equal full-height columns, no gap', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const r = columnsLayout(4, OUT);
  assert.equal(r.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(r[i], { x: i * 250, y: 0, width: 250, height: 600 });
  }
});

test('columns: gaps between and around; last column absorbs rounding', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const r = columnsLayout(3, OUT, 10);
  assert.equal(r.length, 3);
  // usable 980 wide; 2 inner gaps -> floor(960/3)=320 per column.
  assert.deepEqual(r[0], { x: 10, y: 10, width: 320, height: 580 });
  assert.deepEqual(r[1], { x: 340, y: 10, width: 320, height: 580 });
  // last absorbs remainder: 10+980 - 670 = 320
  assert.deepEqual(r[2], { x: 670, y: 10, width: 320, height: 580 });
  // columns tile the row exactly
  assert.equal(r[2].x + r[2].width, 10 + 980);
});

test('columns: degenerate tiny output stays finite and non-negative', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  for (const n of [1, 3]) {
    for (const r of columnsLayout(n, { width: 1, height: 1 }, 5)) {
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
      assert.ok(r.width >= 0 && r.height >= 0);
    }
  }
});
