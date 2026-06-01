// Per-window decoration z-binding (BUG 3 fix), unit-tested via computeBaseStack.
// No GPU. A decoration must be spliced directly BELOW its own window's content in
// the draw stack, so the unified order is [decoA, A, decoB, B] -- NOT a flat
// decoration layer ([decoA, decoB, A, B]) which would let an upper window's
// content occlude a lower window's decoration.
//
// This replaces the former pixel/overlap GPU test: under tiling, windows do not
// overlap, so the occlusion is not observable through pixels. The z-binding
// guarantee lives in computeBaseStack's interleave order, which this pins directly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWm } from "../dist/wm/index.js";
import { computeBaseStack } from "../dist/subsurfaces.js";

// Minimal CompositorState for computeBaseStack: it needs `wm` and reads
// `surfaces` (for subsurface subtrees) -- empty here (no subsurfaces). The WM is
// the real createWm; we drive addWindow/windowHasContent + setDecorationSurface.
function makeState() {
  const comp = { setSurfaceLayout() {}, setStack() {} };
  const wm = createWm(comp, { width: 1000, height: 600 });
  // No configure sink / no rebuild hook: pushStack falls back to setStack (unused
  // here; we call computeBaseStack directly).
  const state = { wm, surfaces: new Map() };
  return { state, wm };
}

function addMapped(wm, id) {
  wm.addWindow(id, { resource: { __id: id } });
  wm.windowHasContent(id);
}

test("computeBaseStack: a window with no decoration contributes just its content id", () => {
  const { state, wm } = makeState();
  addMapped(wm, 1);
  assert.deepEqual(computeBaseStack(state), [1]);
});

test("computeBaseStack: a decoration is spliced directly below its own window", () => {
  const { state, wm } = makeState();
  addMapped(wm, 1);
  wm.setDecorationSurface(1, 500);   // deco 500 decorates window 1
  assert.deepEqual(computeBaseStack(state), [500, 1]);
});

test("computeBaseStack: two decorated windows interleave per-window (decoA,A,decoB,B order)", () => {
  const { state, wm } = makeState();
  // Add window 1 (A) then window 2 (B). New window becomes master (front), so
  // the WM order is [2, 1]. computeBaseStack walks that order.
  addMapped(wm, 1);
  addMapped(wm, 2);
  wm.setDecorationSurface(1, 510);   // decoA
  wm.setDecorationSurface(2, 520);   // decoB
  const stack = computeBaseStack(state);
  // Each decoration is immediately before its own window's content.
  assert.deepEqual(stack, [520, 2, 510, 1]);
  // The decisive z-binding invariant: decoB is adjacent to (directly below) B, and
  // decoA adjacent to A -- NOT all decorations grouped below all content.
  const idxDecoB = stack.indexOf(520), idxB = stack.indexOf(2);
  const idxDecoA = stack.indexOf(510), idxA = stack.indexOf(1);
  assert.equal(idxB, idxDecoB + 1, "decoB directly below B");
  assert.equal(idxA, idxDecoA + 1, "decoA directly below A");
  // NOT the flat-layer bug, which would group both decorations first: [510,520,1,2]
  // or [520,510,2,1]. Detect it: a decoration adjacent to the OTHER window's deco.
  assert.notEqual(Math.abs(idxDecoA - idxDecoB), 1, "decorations are not grouped into a flat layer");
});

test("computeBaseStack: a content-gated window is omitted entirely (deco + content)", () => {
  const { state, wm } = makeState();
  addMapped(wm, 1);
  addMapped(wm, 2);
  wm.setDecorationSurface(1, 510);
  wm.setDecorationSurface(2, 520);
  wm.setContentGated(2, true);   // B held out until its decoration's first frame
  // B (and its decoration) are excluded; only A's pair remains.
  assert.deepEqual(computeBaseStack(state), [510, 1]);
});

test("computeBaseStack: clearing a decoration removes it from the stack", () => {
  const { state, wm } = makeState();
  addMapped(wm, 1);
  wm.setDecorationSurface(1, 500);
  assert.deepEqual(computeBaseStack(state), [500, 1]);
  wm.setDecorationSurface(1, null);
  assert.deepEqual(computeBaseStack(state), [1]);
});
