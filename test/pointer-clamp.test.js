import { test } from "node:test";
import assert from "node:assert/strict";

import {
  insideAny, clampPointerMotion, reseatCursor,
} from "../packages/core/dist/output/pointer-clamp.js";

function r(x, y, w, h) { return { x, y, w, h }; }

// EDGE_EPSILON in the implementation. Boundary tests assert that the
// clamped cursor sits at the rect's exclusive edge minus this epsilon.
const EPS = 1 / 256;

// Helper: assert two doubles are equal modulo a tiny rounding tolerance.
function eq(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
}

function eqPoint(p, x, y, tol = 1e-9) {
  eq(p.x, x, tol);
  eq(p.y, y, tol);
}

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

// --- clampPointerMotion: single output, in-bounds motion ---

test("clamp: motion entirely inside one output passes through unchanged", () => {
  const out = [r(0, 0, 1000, 1000)];
  assert.deepEqual(clampPointerMotion(out, 500, 500, 10, -20),
    { x: 510, y: 480 });
});

test("clamp: motion that lands exactly on an interior pixel is preserved", () => {
  const out = [r(0, 0, 1000, 1000)];
  assert.deepEqual(clampPointerMotion(out, 100.3, 200.7, 5, 5),
    { x: 105.3, y: 205.7 });
});

// --- clampPointerMotion: single output, wall press ---

test("clamp: motion past the right edge snaps just inside the wall", () => {
  // From (50, 50), motion (+200, 0) -> target (250, 50). Snap x to
  // 100 - EPS, y unchanged (already in range).
  const out = [r(0, 0, 100, 100)];
  eqPoint(clampPointerMotion(out, 50, 50, 200, 0), 100 - EPS, 50);
});

test("clamp: motion past the left edge snaps to x=0", () => {
  const out = [r(0, 0, 100, 100)];
  eqPoint(clampPointerMotion(out, 50, 50, -200, 0), 0, 50);
});

test("clamp: motion past the bottom edge snaps just inside that wall", () => {
  const out = [r(0, 0, 100, 100)];
  eqPoint(clampPointerMotion(out, 50, 50, 0, 200), 50, 100 - EPS);
});

test("clamp: repeated outward motion at the wall produces a stable position (no jitter)", () => {
  // Regression for the right-edge flicker. Cursor near the wall, repeated
  // outward deltas should converge to the same (just-inside-edge) position
  // and stay there -- no event-to-event back-and-forth.
  const out = [r(0, 0, 1920, 1080)];
  let p = { x: 1919.7, y: 500 };
  for (let i = 0; i < 50; i++) {
    p = clampPointerMotion(out, p.x, p.y, 5, 0);
  }
  eqPoint(p, 1920 - EPS, 500);
  // And one more outward delta keeps it pinned to the same position.
  const q = clampPointerMotion(out, p.x, p.y, 5, 0);
  eqPoint(q, p.x, p.y);
});

// --- clampPointerMotion: two outputs side by side ---

test("clamp: crossing between two side-by-side outputs is accepted", () => {
  const out = [r(0, 0, 1920, 1080), r(1920, 0, 1920, 1080)];
  assert.deepEqual(clampPointerMotion(out, 1900, 500, 50, 0),
    { x: 1950, y: 500 });
});

test("clamp: motion past the union's right edge snaps to the union's right wall", () => {
  const out = [r(0, 0, 1920, 1080), r(1920, 0, 1920, 1080)];
  eqPoint(clampPointerMotion(out, 3800, 500, 100, 0), 3840 - EPS, 500);
});

// --- clampPointerMotion: mismatched / non-rectangular unions ---

test("clamp: diagonal that lands inside the taller output (overhang) is accepted", () => {
  // Left: 1080p tall. Right: 1440p tall, top-aligned. The strip y in
  // [1080, 1440) is below the left's bottom but inside the right.
  const out = [r(0, 0, 1920, 1080), r(1920, 0, 1920, 1440)];
  // From near left's bottom-right, diagonal into the overhang.
  assert.deepEqual(clampPointerMotion(out, 1900, 1070, 50, 50),
    { x: 1950, y: 1120 });
});

test("clamp: diagonal into a true gap projects to whichever rect is closer", () => {
  // Top: [0, 0, 1920, 1080]. Bottom: [500, 1080, 1920, 1080] (offset right).
  // The strip x in [0, 500) below y=1080 is a gap.
  // From (100, 1070), motion (0, +50) -> target (100, 1120) in the gap.
  // Top's projection: (100, 1079.996...) dist = ~40.
  // Bottom's projection: (500, 1120) dist = 400.
  // Closest is the top -> snap y to just inside top's bottom edge.
  const out = [r(0, 0, 1920, 1080), r(500, 1080, 1920, 1080)];
  eqPoint(clampPointerMotion(out, 100, 1070, 0, 50), 100, 1080 - EPS);
});

test("clamp: diagonal past disjoint monitors projects to the closer rect's corner", () => {
  // Two disjoint monitors. Motion vector lands in the void between them.
  // The algorithm picks whichever rect's closest-projection is nearer
  // (not "stay put"); the visible effect is the cursor slides along the
  // edge of the nearer monitor toward the projection target.
  const out = [r(0, 0, 100, 100), r(500, 500, 100, 100)];
  // From (50, 50) (in A), motion (300, 300) -> target (350, 350).
  // A's projection: (100 - EPS, 100 - EPS) dist ~ 250*250 + 250*250.
  // B's projection: (500, 500) dist ~ 150*150 + 150*150. B wins.
  eqPoint(clampPointerMotion(out, 50, 50, 300, 300), 500, 500);
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
