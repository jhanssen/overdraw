// Pure unit tests for the zwlr_layer_surface_v1 geometry (GPU-free). Covers
// anchor placement, size autosize, margin behaviour, exclusive-edge resolution,
// the v5 explicit set_exclusive_edge path, and zone-mode (output vs effective).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  placeLayerSurface,
  resolveExclusiveEdge,
  computeReservedThickness,
  isValidAnchor,
  ANCHOR_TOP, ANCHOR_BOTTOM, ANCHOR_LEFT, ANCHOR_RIGHT, ANCHOR_ALL,
} from "../packages/core/dist/protocols/layer-shell-position.js";

const OUT = { x: 0, y: 0, width: 1920, height: 1080 };
const EFF = { x: 0, y: 30, width: 1920, height: 1050 }; // top:30 reserved
const NO_MARGIN = { top: 0, right: 0, bottom: 0, left: 0 };

function args(over = {}) {
  return {
    outputRect: OUT,
    effectiveRect: EFF,
    width: 0, height: 30,
    anchor: ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT,
    margin: NO_MARGIN,
    exclusiveZone: 0,
    ...over,
  };
}

// ---- anchor placement ----------------------------------------------------

test("anchor top + left + right: spans width, sits at top edge", () => {
  // zone > 0 -> uses outputRect.
  const { rect, error } = placeLayerSurface(args({ exclusiveZone: 30 }));
  assert.equal(error, undefined);
  assert.deepEqual(rect, { x: 0, y: 0, width: 1920, height: 30 });
});

test("anchor top-left corner with explicit size: stays in top-left", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP | ANCHOR_LEFT, width: 200, height: 100, exclusiveZone: -1,
  }));
  assert.deepEqual(rect, { x: 0, y: 0, width: 200, height: 100 });
});

test("no anchor + explicit size: centered on both axes", () => {
  const { rect } = placeLayerSurface(args({
    anchor: 0, width: 400, height: 200, exclusiveZone: -1,
  }));
  assert.equal(rect.x, (1920 - 400) / 2);
  assert.equal(rect.y, (1080 - 200) / 2);
  assert.equal(rect.width, 400);
  assert.equal(rect.height, 200);
});

test("anchor right only: pinned to right, vertically centered", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_RIGHT, width: 50, height: 100, exclusiveZone: -1,
  }));
  assert.equal(rect.x, 1920 - 50);
  assert.equal(rect.y, (1080 - 100) / 2);
  assert.equal(rect.width, 50);
});

test("anchor bottom only: pinned to bottom, horizontally centered", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_BOTTOM, width: 300, height: 40, exclusiveZone: -1,
  }));
  assert.equal(rect.x, (1920 - 300) / 2);
  assert.equal(rect.y, 1080 - 40);
});

// ---- size==0 axis --------------------------------------------------------

test("width=0 without opposite-edge anchors: invalid_size", () => {
  const { error } = placeLayerSurface(args({
    anchor: ANCHOR_TOP, width: 0, height: 30, exclusiveZone: -1,
  }));
  assert.equal(error, "invalid_size");
});

test("width=0 with left+right anchors: spans the base rect width", () => {
  const { rect, error } = placeLayerSurface(args({
    anchor: ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT, width: 0, height: 30,
    exclusiveZone: -1,
  }));
  assert.equal(error, undefined);
  assert.equal(rect.width, 1920);
});

test("height=0 with top+bottom anchors: spans the base rect height", () => {
  const { rect, error } = placeLayerSurface(args({
    anchor: ANCHOR_LEFT | ANCHOR_TOP | ANCHOR_BOTTOM, width: 50, height: 0,
    exclusiveZone: -1,
  }));
  assert.equal(error, undefined);
  assert.equal(rect.height, 1080);
});

test("height=0 without opposite-edge anchors: invalid_size", () => {
  const { error } = placeLayerSurface(args({
    anchor: ANCHOR_LEFT, width: 200, height: 0, exclusiveZone: -1,
  }));
  assert.equal(error, "invalid_size");
});

// ---- margin --------------------------------------------------------------

test("margin on anchored edge pushes inward", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP, width: 200, height: 30,
    margin: { top: 5, right: 0, bottom: 0, left: 0 },
    exclusiveZone: -1,
  }));
  assert.equal(rect.y, 5);
});

test("margin on unanchored edge is ignored", () => {
  // Anchored only to top; bottom margin should have no effect on placement.
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP, width: 200, height: 30,
    margin: { top: 0, right: 0, bottom: 99, left: 0 },
    exclusiveZone: -1,
  }));
  assert.equal(rect.y, 0);
});

test("margin on spanned axis shrinks the spanned dimension", () => {
  // top + left + right anchored; width=0 spans; margins on left/right
  // shrink the surface inward.
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT, width: 0, height: 30,
    margin: { top: 0, right: 10, bottom: 0, left: 20 },
    exclusiveZone: -1,
  }));
  assert.equal(rect.x, 20);
  assert.equal(rect.width, 1920 - 10 - 20);
});

// ---- zone-mode (base rect selection) ------------------------------------

test("zone>0: uses outputRect", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT, exclusiveZone: 30,
  }));
  assert.equal(rect.y, 0);
});

test("zone==0: uses effectiveRect (a notification sits BELOW reserved bar)", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT, exclusiveZone: 0,
  }));
  // EFF.y=30: top-anchored surface lands at y=30, not y=0.
  assert.equal(rect.y, 30);
});

test("zone==-1: uses outputRect (a wallpaper covers the reserved area)", () => {
  const { rect } = placeLayerSurface(args({
    anchor: ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT | ANCHOR_BOTTOM,
    width: 0, height: 0, exclusiveZone: -1,
  }));
  assert.equal(rect.y, 0);
  assert.equal(rect.height, 1080);
});

// ---- exclusive-edge resolution ------------------------------------------

test("resolveExclusiveEdge: single edge -> that edge", () => {
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_TOP, 0), { edge: "top" });
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_BOTTOM, 0), { edge: "bottom" });
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_LEFT, 0), { edge: "left" });
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_RIGHT, 0), { edge: "right" });
});

test("resolveExclusiveEdge: edge + both perpendiculars -> the singleton edge", () => {
  // top + left + right -> top
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_LEFT | ANCHOR_RIGHT, 0),
    { edge: "top" });
  // bottom + left + right -> bottom
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_BOTTOM | ANCHOR_LEFT | ANCHOR_RIGHT, 0),
    { edge: "bottom" });
  // left + top + bottom -> left
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_LEFT | ANCHOR_TOP | ANCHOR_BOTTOM, 0),
    { edge: "left" });
});

test("resolveExclusiveEdge: corner without explicit edge -> null", () => {
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_LEFT, 0), { edge: null });
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_BOTTOM | ANCHOR_RIGHT, 0), { edge: null });
});

test("resolveExclusiveEdge: corner with explicit edge -> that edge (v5)", () => {
  // top + left anchored; explicit top -> top
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_LEFT, ANCHOR_TOP),
    { edge: "top" });
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_LEFT, ANCHOR_LEFT),
    { edge: "left" });
});

test("resolveExclusiveEdge: explicit edge not in anchor set -> invalid_exclusive_edge", () => {
  // top + left anchored; explicit right -> error
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_LEFT, ANCHOR_RIGHT),
    { edge: null, error: "invalid_exclusive_edge" });
});

test("resolveExclusiveEdge: explicit edge with multiple bits -> invalid_exclusive_edge", () => {
  // explicit edge must be a single anchor bit.
  assert.deepEqual(
    resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_LEFT, ANCHOR_TOP | ANCHOR_LEFT),
    { edge: null, error: "invalid_exclusive_edge" });
});

test("resolveExclusiveEdge: all four edges -> null (the all-edges case)", () => {
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_ALL, 0), { edge: null });
});

test("resolveExclusiveEdge: no anchor -> null", () => {
  assert.deepEqual(resolveExclusiveEdge(0, 0), { edge: null });
});

test("resolveExclusiveEdge: two parallel edges -> null", () => {
  // top + bottom = parallel, not a corner; no exclusive effect.
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_TOP | ANCHOR_BOTTOM, 0), { edge: null });
  assert.deepEqual(resolveExclusiveEdge(ANCHOR_LEFT | ANCHOR_RIGHT, 0), { edge: null });
});

// ---- computeReservedThickness -------------------------------------------

test("computeReservedThickness: positive zone -> zone", () => {
  assert.equal(computeReservedThickness(30), 30);
  assert.equal(computeReservedThickness(1), 1);
});

test("computeReservedThickness: zero/negative -> 0", () => {
  assert.equal(computeReservedThickness(0), 0);
  assert.equal(computeReservedThickness(-1), 0);
});

// ---- anchor validity ----------------------------------------------------

test("isValidAnchor accepts 0..0xF, rejects high bits", () => {
  assert.equal(isValidAnchor(0), true);
  assert.equal(isValidAnchor(ANCHOR_ALL), true);
  assert.equal(isValidAnchor(ANCHOR_TOP | ANCHOR_LEFT), true);
  assert.equal(isValidAnchor(0x10), false);
  assert.equal(isValidAnchor(0xFF), false);
});
