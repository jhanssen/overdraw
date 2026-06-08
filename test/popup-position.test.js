// Pure unit tests for the xdg_positioner constraint solver (GPU-free). Covers
// anchor/gravity placement, offset, and flip/slide/resize constraint adjustment.

import { test } from "node:test";
import assert from "node:assert/strict";

import { solvePopupPosition } from "../packages/core/dist/popup-position.js";

// enum values
const ANCHOR = { none: 0, top: 1, bottom: 2, left: 3, right: 4, top_left: 5, bottom_left: 6, top_right: 7, bottom_right: 8 };
const GRAV = ANCHOR; // same numbering
const CA = { none: 0, slide_x: 1, slide_y: 2, flip_x: 4, flip_y: 8, resize_x: 16, resize_y: 32 };

function pos(over = {}) {
  return {
    width: 100, height: 50,
    anchorRect: { x: 10, y: 10, width: 20, height: 20 },
    anchor: ANCHOR.bottom_left, gravity: GRAV.bottom_right,
    constraintAdjustment: CA.none, offsetX: 0, offsetY: 0,
    ...over,
  };
}

test("dropdown: anchor bottom-left, gravity bottom-right -> below-left of anchor rect", () => {
  // anchor rect (10,10,20,20); bottom_left anchor point = (10, 30); gravity
  // bottom_right => popup top-left at the anchor point.
  const r = solvePopupPosition(pos(), 0, 0, 1000, 1000);
  assert.equal(r.x, 10);
  assert.equal(r.y, 30);
  assert.equal(r.width, 100);
  assert.equal(r.height, 50);
});

test("offset shifts the result", () => {
  const r = solvePopupPosition(pos({ offsetX: 5, offsetY: 7 }), 0, 0, 1000, 1000);
  assert.equal(r.x, 15);
  assert.equal(r.y, 37);
});

test("gravity top-left places popup up-left of the anchor point", () => {
  // anchor top_left point = (10,10); gravity top_left => top-left at (10-100,10-50).
  const r = solvePopupPosition(pos({ anchor: ANCHOR.top_left, gravity: GRAV.top_left }), 0, 0, 1000, 1000);
  assert.equal(r.x, 10 - 100);
  assert.equal(r.y, 10 - 50);
});

test("flip_y: would overflow bottom -> flips above the anchor", () => {
  // Parent near the bottom of the output: anchor point bottom => popup below
  // would clip; flip_y mirrors to gravity top => popup goes above.
  // parentY=960, output 1000 tall. anchor rect (10,10,20,20) -> bottom anchor at
  // parent-rel y=30; below would be 30..80 -> output 990..1040 (clips). Flip ->
  // anchor top (y=10), gravity top => top-left y = 10-50 = -40 (parent-rel) =>
  // output 920..970 (fits).
  const r = solvePopupPosition(
    pos({ anchor: ANCHOR.bottom_left, gravity: GRAV.bottom_right, constraintAdjustment: CA.flip_y }),
    0, 960, 1000, 1000);
  // flipped: anchor top_left (10,10), gravity top_right -> y = 10 - 50 = -40.
  assert.equal(r.y, -40);
});

test("slide_x: overflow right edge slides left to fit", () => {
  // Popup width 100 anchored so it would extend past the right edge; slide_x
  // clamps x so x+w == maxX.
  const r = solvePopupPosition(
    pos({ anchorRect: { x: 950, y: 10, width: 20, height: 20 }, constraintAdjustment: CA.slide_x }),
    0, 0, 1000, 1000);
  // raw x = 950 (bottom_left anchor), x+100=1050 > 1000 -> slide to 900.
  assert.equal(r.x, 900);
  assert.equal(r.width, 100);
});

test("resize_x: overflow with only resize_x clamps width", () => {
  const r = solvePopupPosition(
    pos({ anchorRect: { x: 950, y: 10, width: 20, height: 20 }, constraintAdjustment: CA.resize_x }),
    0, 0, 1000, 1000);
  // raw x=950, no slide -> width clamped to 1000-950 = 50.
  assert.equal(r.x, 950);
  assert.equal(r.width, 50);
});

test("no adjustment: overflow is left as-is (off-screen allowed)", () => {
  const r = solvePopupPosition(
    pos({ anchorRect: { x: 950, y: 10, width: 20, height: 20 }, constraintAdjustment: CA.none }),
    0, 0, 1000, 1000);
  assert.equal(r.x, 950);
  assert.equal(r.width, 100); // unchanged
});

test("result is parent-relative (parentX/Y only affect constraint bounds)", () => {
  // Same positioner, no constraints: result identical regardless of parent pos.
  const a = solvePopupPosition(pos(), 0, 0, 10000, 10000);
  const b = solvePopupPosition(pos(), 500, 500, 10000, 10000);
  assert.deepEqual(a, b);
});
