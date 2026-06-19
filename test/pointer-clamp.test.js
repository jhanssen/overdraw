import { test } from "node:test";
import assert from "node:assert/strict";

import {
  insideAny, clampPointerMotion, reseatCursor,
} from "../packages/core/dist/output/pointer-clamp.js";

function r(x, y, w, h) { return { x, y, w, h }; }

// --- insideAny ---

test("insideAny: outside the only rect", () => {
  assert.equal(insideAny([r(0, 0, 100, 100)], 200, 50), false);
});

test("insideAny: inside one rect of many", () => {
  const outs = [r(0, 0, 100, 100), r(200, 0, 100, 100)];
  assert.equal(insideAny(outs, 250, 50), true);
});

test("insideAny: right and bottom edges are exclusive", () => {
  const o = [r(0, 0, 100, 100)];
  assert.equal(insideAny(o, 99, 99), true);
  assert.equal(insideAny(o, 100, 50), false);
  assert.equal(insideAny(o, 50, 100), false);
});

test("insideAny: empty layout is always outside", () => {
  assert.equal(insideAny([], 0, 0), false);
});

// --- clampPointerMotion: single output ---

test("clamp: motion entirely inside one output", () => {
  const out = [r(0, 0, 1000, 1000)];
  assert.deepEqual(clampPointerMotion(out, 500, 500, 10, -20),
    { x: 510, y: 480 });
});

test("clamp: motion past the right edge clamps to the right edge", () => {
  const out = [r(0, 0, 100, 100)];
  // From (50, 50), move (200, 0). Target (250, 50) is outside.
  // X-slide fails (no output covers x=250). Y-slide: keep ty=50; output covers
  // y=50; refX=250 is past the right edge so x snaps to 99.
  assert.deepEqual(clampPointerMotion(out, 50, 50, 200, 0),
    { x: 99, y: 50 });
});

test("clamp: motion past the left edge clamps to the left edge", () => {
  const out = [r(0, 0, 100, 100)];
  assert.deepEqual(clampPointerMotion(out, 50, 50, -200, 0),
    { x: 0, y: 50 });
});

test("clamp: motion past the bottom edge clamps to the bottom edge", () => {
  const out = [r(0, 0, 100, 100)];
  // Target (50, 250). X-slide: keep tx=50; output covers x=50; refY=250 snaps to 99.
  assert.deepEqual(clampPointerMotion(out, 50, 50, 0, 200),
    { x: 50, y: 99 });
});

// --- clampPointerMotion: two outputs side by side ---

test("clamp: crossing between two side-by-side outputs is accepted", () => {
  // 0: x in [0, 1920); 1: x in [1920, 3840). Both 1080 tall.
  const out = [r(0, 0, 1920, 1080), r(1920, 0, 1920, 1080)];
  // Move from output 0 to output 1.
  assert.deepEqual(clampPointerMotion(out, 1900, 500, 50, 0),
    { x: 1950, y: 500 });
});

test("clamp: motion past the right edge of the union clamps to the union's right edge", () => {
  const out = [r(0, 0, 1920, 1080), r(1920, 0, 1920, 1080)];
  // From (3800, 500), move (100, 0) -> target (3900, 500). X-slide: no output
  // covers x=3900. Y-slide: keep ty=500; the right output covers y=500 with
  // x-range [1920, 3840); refX=3900 snaps to 3839.
  assert.deepEqual(clampPointerMotion(out, 3800, 500, 100, 0),
    { x: 3839, y: 500 });
});

// --- clampPointerMotion: mismatched-height side by side (the L-shape case) ---

test("clamp: diagonal into a gap slides along the edge", () => {
  // Left: 1080p tall. Right: 1440p tall, top-aligned, the lower strip below
  // the 1080's bottom is outside the left output but inside the right.
  // Layout: left [0, 1920) x [0, 1080); right [1920, 3840) x [0, 1440).
  // From cursor at (1900, 1070) (near left's bottom-right corner), move
  // diagonally down-right (50, 50) -> target (1950, 1120).
  // Target inside? x=1950 inside right [1920, 3840), y=1120 inside right [0, 1440) -> YES.
  // So the diagonal is accepted (target is inside the right output's tall column).
  const out = [r(0, 0, 1920, 1080), r(1920, 0, 1920, 1440)];
  assert.deepEqual(clampPointerMotion(out, 1900, 1070, 50, 50),
    { x: 1950, y: 1120 });
});

test("clamp: diagonal into a true gap (stacked monitors with horizontal offset) slides", () => {
  // Top monitor: [0, 0, 1920, 1080]. Bottom monitor: [500, 1080, 1920, 1080]
  // (offset right). The strip x in [0, 500) below y=1080 is a gap.
  // From (100, 1070), move (0, 50) -> target (100, 1120) in the gap.
  // X-slide: keep target X=100. Outputs covering x=100: only top (y range
  // [0, 1080)). refY=1070, snap into [0, 1079]. -> (100, 1079).
  // Y-slide: keep target Y=1120. Outputs covering y=1120: only bottom (x range
  // [500, 2420)). refX=100, snap into [500, 2419]. -> (500, 1120).
  // X-slide returns first and wins.
  const out = [r(0, 0, 1920, 1080), r(500, 1080, 1920, 1080)];
  const got = clampPointerMotion(out, 100, 1070, 0, 50);
  assert.deepEqual(got, { x: 100, y: 1079 });
});

test("clamp: diagonal that misses both axes' slides stays put", () => {
  // Two disjoint monitors with both axes mismatched. Cursor in monitor A,
  // motion vector goes into a region not covered by either monitor on either
  // axis-aligned slide.
  const out = [r(0, 0, 100, 100), r(500, 500, 100, 100)];
  // From (50, 50) (in A), move (300, 300) -> target (350, 350). Outside both.
  // X-slide: keep x=350. No output covers x=350. Fails.
  // Y-slide: keep y=350. No output covers y=350. Fails.
  // Stay at (50, 50).
  assert.deepEqual(clampPointerMotion(out, 50, 50, 300, 300),
    { x: 50, y: 50 });
});

// --- empty layout ---

test("clamp: empty layout leaves the cursor at the old position", () => {
  assert.deepEqual(clampPointerMotion([], 100, 200, 50, 50),
    { x: 100, y: 200 });
});

// --- reseatCursor ---

test("reseat: center of the first rect", () => {
  assert.deepEqual(reseatCursor([r(0, 0, 100, 200), r(100, 0, 50, 50)]),
    { x: 50, y: 100 });
});

test("reseat: empty layout returns (0, 0)", () => {
  assert.deepEqual(reseatCursor([]), { x: 0, y: 0 });
});
