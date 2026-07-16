// Pure-unit tests for the interactive grab geometry (input/grab-math.ts).
// The seat's handleInput converts each motion event's glass deltas to
// world units (glass / camera zoom) and calls computeGrabRect with them;
// integration with the seat is exercised through GPU tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeGrabRect } from '../packages/core/dist/input/grab-math.js';

// --- move math ----------------------------------------------------------

test('move: translates startRect by the world delta', () => {
  const g = {
    kind: 'move', surfaceId: 1,
    startRect: { x: 100, y: 100, width: 200, height: 150 },
  };
  const r = computeGrabRect(g, 150, 100, null);
  assert.deepEqual(r, { x: 250, y: 200, width: 200, height: 150 });
});

test('move: negative delta moves rect up-left', () => {
  const g = {
    kind: 'move', surfaceId: 1,
    startRect: { x: 100, y: 100, width: 200, height: 150 },
  };
  const r = computeGrabRect(g, -50, -75, null);
  assert.deepEqual(r, { x: 50, y: 25, width: 200, height: 150 });
});

test('move: zero delta returns startRect', () => {
  const g = {
    kind: 'move', surfaceId: 1,
    startRect: { x: 50, y: 40, width: 30, height: 20 },
  };
  const r = computeGrabRect(g, 0, 0, null);
  assert.deepEqual(r, { x: 50, y: 40, width: 30, height: 20 });
});

// --- resize math: single edges -----------------------------------------

test('resize right: width grows with positive dx; x unchanged', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'right',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const r = computeGrabRect(g, 100, 50, null);
  assert.deepEqual(r, { x: 0, y: 0, width: 200, height: 100 });
});

test('resize left: x moves with dx; width inversely', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'left',
    startRect: { x: 100, y: 100, width: 200, height: 200 },
  };
  const r = computeGrabRect(g, 50, 0, null);
  assert.deepEqual(r, { x: 150, y: 100, width: 150, height: 200 });
});

test('resize bottom: height grows with positive dy', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const r = computeGrabRect(g, 0, 100, null);
  assert.deepEqual(r, { x: 0, y: 0, width: 100, height: 200 });
});

test('resize top: y moves with dy; height inversely', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'top',
    startRect: { x: 0, y: 100, width: 200, height: 200 },
  };
  const r = computeGrabRect(g, 0, 50, null);
  assert.deepEqual(r, { x: 0, y: 150, width: 200, height: 150 });
});

// --- resize math: corners ----------------------------------------------

test('resize bottom-right: both width and height grow', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom-right',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const r = computeGrabRect(g, 100, 50, null);
  assert.deepEqual(r, { x: 0, y: 0, width: 200, height: 150 });
});

test('resize top-left: x+y move; width+height inversely', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'top-left',
    startRect: { x: 100, y: 100, width: 200, height: 200 },
  };
  const r = computeGrabRect(g, 50, 50, null);
  assert.deepEqual(r, { x: 150, y: 150, width: 150, height: 150 });
});

test('resize top-right: x stays; y moves; width grows; height shrinks', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'top-right',
    startRect: { x: 0, y: 100, width: 100, height: 200 },
  };
  const r = computeGrabRect(g, 50, 50, null);
  assert.deepEqual(r, { x: 0, y: 150, width: 150, height: 150 });
});

test('resize bottom-left: x moves; y stays; width shrinks; height grows', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom-left',
    startRect: { x: 100, y: 0, width: 200, height: 100 },
  };
  const r = computeGrabRect(g, 50, 50, null);
  assert.deepEqual(r, { x: 150, y: 0, width: 150, height: 150 });
});

// --- constraints clamping ----------------------------------------------

test('resize bottom-right: clamps width to minSize', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom-right',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const r = computeGrabRect(g, -100, -50, {
    minSize: { width: 80, height: 60 },
    maxSize: null,
  });
  assert.equal(r.width, 80);
  assert.equal(r.height, 60);
  // x/y untouched on bottom-right clamp.
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
});

test('resize top-left: minSize clamp adjusts anchor so opposite edge stays put', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'top-left',
    startRect: { x: 100, y: 100, width: 100, height: 100 },
  };
  const r = computeGrabRect(g, 200, 200, {
    minSize: { width: 80, height: 60 },
    maxSize: null,
  });
  // The original right edge was at x = 100+100 = 200; after clamp, the
  // right edge should still be 200.
  assert.equal(r.width, 80);
  assert.equal(r.height, 60);
  assert.equal(r.x + r.width, 200);
  assert.equal(r.y + r.height, 200);
});

test('resize bottom-right: clamps width to maxSize', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom-right',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  const r = computeGrabRect(g, 900, 0, {
    minSize: null,
    maxSize: { width: 400, height: 300 },
  });
  assert.equal(r.width, 400);
  // height delta was 0 -> stays 100.
  assert.equal(r.height, 100);
});

test('resize top-left: maxSize clamp adjusts anchor so opposite edge stays put', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'top-left',
    startRect: { x: 100, y: 100, width: 100, height: 100 },
  };
  // Drag far up-left so width would exceed maxSize.
  const r = computeGrabRect(g, -300, -300, {
    minSize: null,
    maxSize: { width: 200, height: 200 },
  });
  // The right edge of startRect was at 200; after the maxSize clamp,
  // the right edge stays at 200.
  assert.equal(r.width, 200);
  assert.equal(r.height, 200);
  assert.equal(r.x + r.width, 200);
  assert.equal(r.y + r.height, 200);
});

test('resize: null constraints means minSize=1, maxSize=Infinity', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom-right',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  // Drag way negative so width would go to 0; with minSize=1 default,
  // it clamps to 1.
  const r = computeGrabRect(g, -300, -300, null);
  assert.equal(r.width, 1);
  assert.equal(r.height, 1);
});

test('resize: missing constraint fields default sanely', () => {
  const g = {
    kind: 'resize', surfaceId: 1, edges: 'bottom-right',
    startRect: { x: 0, y: 0, width: 100, height: 100 },
  };
  // Only minSize set; maxSize defaults to Infinity.
  const r = computeGrabRect(g, 4900, 4900, {
    minSize: { width: 50, height: 50 }, maxSize: null,
  });
  assert.equal(r.width, 5000);
  assert.equal(r.height, 5000);
});
