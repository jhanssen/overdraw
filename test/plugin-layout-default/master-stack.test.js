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

test('DEFAULT_LAYOUT is master-stack mode, 0.5 fractions, 0 gap', () => {
  assert.equal(DEFAULT_LAYOUT.mode, 'master-stack');
  assert.equal(DEFAULT_LAYOUT.masterFraction, 0.5);
  assert.equal(DEFAULT_LAYOUT.column, 0.5);
  assert.equal(DEFAULT_LAYOUT.gap, 0);
});

// ---- columns ---------------------------------------------------------------

test('columns: empty -> no rects', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  assert.deepEqual(columnsLayout([], OUT), []);
});

test('columns: equal weights -> N equal full-height columns, no gap', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const r = columnsLayout([1, 1, 1, 1], OUT);
  assert.equal(r.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(r[i], { x: i * 250, y: 0, width: 250, height: 600 });
  }
});

test('columns: unequal weights split the region proportionally', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const r = columnsLayout([2, 1, 1], OUT);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { x: 0, y: 0, width: 500, height: 600 });
  assert.deepEqual(r[1], { x: 500, y: 0, width: 250, height: 600 });
  // last absorbs the remainder; the row tiles exactly
  assert.deepEqual(r[2], { x: 750, y: 0, width: 250, height: 600 });
});

test('columns: gaps between and around; last column absorbs rounding', async () => {
  const { columnsLayout } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const r = columnsLayout([1, 1, 1], OUT, 10);
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
    for (const r of columnsLayout(Array(n).fill(1), { width: 1, height: 1 }, 5)) {
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
      assert.ok(r.width >= 0 && r.height >= 0);
    }
  }
});

test('columns: a region pre-sized by columnsMeasure fits every column, gaps carved out', async () => {
  const { columnsLayout, columnsMeasure } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const wa = { width: 1000, height: 600 };
  const widthsPx = [500, 500, 750]; // fractions 0.5, 0.5, 0.75 of the workarea
  const m = columnsMeasure(widthsPx, wa);
  // The natural sum; gaps are NOT added around the columns.
  assert.deepEqual(m, { width: 1750, height: 600 });
  const r = columnsLayout(widthsPx, { width: m.width, height: m.height }, 10);
  // Columns keep their 1:1:1.5 proportions, each shaved by its gap share.
  assert.deepEqual(r.map((c) => c.width), [488, 488, 734]);
  // The row tiles the region exactly: no column falls outside it.
  assert.equal(r[2].x + r[2].width, 10 + (1750 - 20));
});

// The invariant that keeps a normal two-window screen fully on-glass.
// Adding the gap bands to the measure instead pushes N columns of 1/N
// (2 x 0.5 being the everyday case) 3 x gap past the viewport, so the
// camera scrolls a strip that plainly ought to fit.
test('columns: N columns at 1/N measure to exactly the workarea -- nothing offscreen', async () => {
  const { columnsLayout, columnsMeasure } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  for (const W of [3440, 2560, 1920, 800]) {
    const wa = { width: W, height: 1440 };
    for (const [n, frac] of [[2, 0.5], [3, 1 / 3], [4, 0.25]]) {
      const widths = Array(n).fill(frac * W);
      const m = columnsMeasure(widths, wa);
      assert.equal(m.width, W,
        `${n} columns of ${frac} on a ${W}px workarea must not exceed the glass`);
      // ...and the tiles land inside it with the gaps taken out of them.
      const r = columnsLayout(widths, { width: m.width, height: m.height }, 10);
      assert.ok(r[n - 1].x + r[n - 1].width <= W, 'last column ends on-screen');
      assert.ok(r[0].x >= 0, 'first column starts on-screen');
    }
  }
});

// ---- columns: width constraints -------------------------------------------
// A column is full-height, so only the width half of a window's min/max is
// expressible: min widens the column past its fraction, max narrows it, and
// the strip's measure follows.

test('columns: a min width widens the column exactly and grows the strip', async () => {
  const { columnsLayout, columnsMeasure } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const wa = { width: 3440, height: 1440 };
  const weights = [0.5, 0.5];
  const px = weights.map((w) => w * wa.width);
  const bounds = [{ min: 2000 }, undefined];

  const m = columnsMeasure(px, wa, 10, bounds);
  assert.equal(m.width, 3735, 'strip grows to hold the floored column');
  const r = columnsLayout(weights, { width: m.width, height: m.height }, 10, bounds);
  assert.equal(r[0].width, 2000, 'the floor is honored exactly, not approximately');
  assert.equal(r[1].width, 1705, 'the unconstrained neighbor keeps its fair share');
});

test('columns: every column min-pinned still gets its full minimum', async () => {
  // The case that forces the measure to reserve each bound's gap
  // allotment: without it the water-fill shaves every column by a gap and
  // no window gets its minimum.
  const { columnsLayout, columnsMeasure } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const wa = { width: 3440, height: 1440 };
  const bounds = [{ min: 2000 }, { min: 2000 }];
  const m = columnsMeasure([1720, 1720], wa, 10, bounds);
  const r = columnsLayout([0.5, 0.5], { width: m.width, height: m.height }, 10, bounds);
  assert.deepEqual(r.map((c) => c.width), [2000, 2000]);
});

test('columns: a max width narrows the column and the neighbor takes the slack', async () => {
  const { columnsLayout, columnsMeasure } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const wa = { width: 3440, height: 1440 };
  const bounds = [{ max: 1000 }, undefined];
  const m = columnsMeasure([1720, 1720], wa, 10, bounds);
  assert.equal(m.width, 3440, 'a narrower column shortens the strip, floored at the glass');
  const r = columnsLayout([0.5, 0.5], { width: m.width, height: m.height }, 10, bounds);
  assert.equal(r[0].width, 1000, 'max honored');
  assert.equal(r[1].width, 2410, 'the slack goes to the neighbor -- no dead space');
  assert.equal(r[1].x + r[1].width, 3430, 'the row still fills the glass');
});

test('columns: a min above a max wins (a client may state both nonsensically)', async () => {
  const { columnsLayout } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const r = columnsLayout([0.5, 0.5], { width: 3735, height: 1440 }, 10,
    [{ min: 2000, max: 1200 }, undefined]);
  assert.equal(r[0].width, 2000);
});

test('columns: a fixed region honors what it can and squeezes what it cannot', async () => {
  const { columnsLayout } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const region = { width: 1000, height: 600 };
  // Satisfiable: 400 fits inside the compressed region, so it is honored.
  const ok = columnsLayout([0.5, 0.5], region, 10, [{ min: 400 }, undefined]);
  assert.ok(ok[0].width >= 400, 'a reachable floor is honored under compression');

  // Impossible: two 800px floors cannot share a 1000px island. The columns
  // squeeze rather than overflow -- an island may not run over its
  // neighbor, so the glass wins and the clients are told the truth.
  const tight = columnsLayout([0.5, 0.5], region, 10, [{ min: 800 }, { min: 800 }]);
  const rightEdge = tight[1].x + tight[1].width;
  assert.ok(rightEdge <= region.width - 10,
    `columns stay inside the island (right edge ${rightEdge})`);
  assert.ok(tight[0].width < 800, 'the unsatisfiable floor is squeezed, not overflowed');
});

test('columns: unconstrained windows are unaffected by a constrained peer', async () => {
  const { columnsLayout } =
    await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const region = { width: 1200, height: 600 };
  const before = columnsLayout([0.5, 0.5, 0.5], region, 10);
  const after = columnsLayout([0.5, 0.5, 0.5], region, 10, [undefined, undefined, undefined]);
  assert.deepEqual(after, before, 'empty bounds change nothing');
});

test('columnsMeasure: empty -> the workarea; narrow columns floor at the workarea', async () => {
  const { columnsMeasure } = await import('../../packages/plugin-layout-default/dist/master-stack.js');
  const wa = { width: 1000, height: 600 };
  assert.deepEqual(columnsMeasure([], wa), { width: 1000, height: 600 });
  // one half-width column: natural 500 < workarea -> floor
  assert.deepEqual(columnsMeasure([500], wa), { width: 1000, height: 600 });
});
