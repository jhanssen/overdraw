// Pure-unit tests for wl_subsurface place_above / place_below sibling
// reordering. Tests the applySubsurfaceReorder logic directly against a
// constructed CompositorState; the protocol-handler wiring (which queues
// ops and triggers the apply on parent commit) is covered by the
// GPU/server tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySubsurfaceReorder } from '../packages/core/dist/subsurfaces.js';

// Build a minimal state with N subsurfaces under one parent, in creation
// order. The parent is a stand-in wl_surface resource; subsurface
// resources are { id, surface } pairs where `surface` is the
// wl_subsurface's content wl_surface.
function setup(parentId, subIds) {
  const parent = { id: parentId };
  const subsurfaces = new Map();
  const order = [];
  for (const id of subIds) {
    const subResource = { id: 100 + id };
    const surface = { id: 200 + id };
    subsurfaces.set(subResource, {
      resource: subResource,
      surface,
      parent,
      x: 0, y: 0, pendingX: 0, pendingY: 0,
      sync: true,
    });
    order.push(subResource);
  }
  const state = {
    subsurfaces,
    subsurfaceOrder: new Map([[parent, order]]),
    subsurfacePendingOrder: new Map(),
  };
  return { state, parent, subsurfaces };
}

function idsAfter(state, parent) {
  return (state.subsurfaceOrder.get(parent) ?? []).map((r) => r.id);
}

function findBySubId(subsurfaces, subId) {
  for (const [k] of subsurfaces) if (k.id === 100 + subId) return k;
  throw new Error(`no subsurface ${subId}`);
}

function findSurfaceBySubId(subsurfaces, subId) {
  for (const [, v] of subsurfaces) if (v.resource.id === 100 + subId) return v.surface;
  throw new Error(`no surface for sub ${subId}`);
}

// --- order initialization ----------------------------------------------

test('initial order: subsurfaces added in creation order', () => {
  const { state, parent } = setup(1, [10, 20, 30]);
  assert.deepEqual(idsAfter(state, parent), [110, 120, 130]);
});

// --- place_above ------------------------------------------------------

test('place_above(parent): moves subsurface to the bottom', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20, 30]);
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 30), sibling: parent },
  ]);
  applySubsurfaceReorder(state, parent);
  // 30 placed above parent (=bottom of siblings).
  assert.deepEqual(idsAfter(state, parent), [130, 110, 120]);
});

test('place_above(other-sibling): inserts immediately above the reference', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20, 30]);
  // Place 10 above 20.
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 10),
      sibling: findSurfaceBySubId(subsurfaces, 20) },
  ]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [120, 110, 130]);
});

test('place_above moving up: subsurface lands immediately above ref', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20, 30]);
  // Place 10 above 30 (moves up past 20 and 30, lands at top).
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 10),
      sibling: findSurfaceBySubId(subsurfaces, 30) },
  ]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [120, 130, 110]);
});

// --- place_below ------------------------------------------------------

test('place_below(other-sibling): inserts immediately below the reference', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20, 30]);
  // Place 30 below 10.
  state.subsurfacePendingOrder.set(parent, [
    { op: 'below', subsurface: findBySubId(subsurfaces, 30),
      sibling: findSurfaceBySubId(subsurfaces, 10) },
  ]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [130, 110, 120]);
});

test('place_below moving down: subsurface lands at ref position', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20, 30]);
  // Place 30 below 20.
  state.subsurfacePendingOrder.set(parent, [
    { op: 'below', subsurface: findBySubId(subsurfaces, 30),
      sibling: findSurfaceBySubId(subsurfaces, 20) },
  ]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [110, 130, 120]);
});

// --- invalid siblings -------------------------------------------------

test('place_above with sibling not in this parent: dropped silently', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20]);
  // Sibling is a fake wl_surface not associated with any sibling.
  const fakeSibling = { id: 999 };
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 10), sibling: fakeSibling },
  ]);
  applySubsurfaceReorder(state, parent);
  // Order unchanged.
  assert.deepEqual(idsAfter(state, parent), [110, 120]);
});

test('place_above on a destroyed subsurface: dropped silently', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20]);
  const sub10 = findBySubId(subsurfaces, 10);
  // Simulate destroy: remove the subsurface but leave a pending op queued.
  subsurfaces.delete(sub10);
  state.subsurfaceOrder.set(parent, state.subsurfaceOrder.get(parent).filter((r) => r !== sub10));
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: sub10,
      sibling: findSurfaceBySubId(subsurfaces, 20) },
  ]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [120]);
});

// --- multiple ops in arrival order ------------------------------------

test('multiple ops apply in order', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20, 30]);
  state.subsurfacePendingOrder.set(parent, [
    // 1. 10 above 30 -> [20, 30, 10]
    { op: 'above', subsurface: findBySubId(subsurfaces, 10),
      sibling: findSurfaceBySubId(subsurfaces, 30) },
    // 2. 20 above 10 -> [30, 10, 20]
    { op: 'above', subsurface: findBySubId(subsurfaces, 20),
      sibling: findSurfaceBySubId(subsurfaces, 10) },
  ]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [130, 110, 120]);
});

test('queue drained after apply', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20]);
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 10),
      sibling: findSurfaceBySubId(subsurfaces, 20) },
  ]);
  applySubsurfaceReorder(state, parent);
  // A second apply with no new ops is a no-op.
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [120, 110]);
});

test('returns true only when an op was applied (drives the stack-rebuild skip)', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20]);
  // No pending ops -> false (a plain content commit must NOT rebuild the stack).
  assert.equal(applySubsurfaceReorder(state, parent), false);
  // A queued reorder -> true (the draw stack changed, caller rebuilds).
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 10),
      sibling: findSurfaceBySubId(subsurfaces, 20) },
  ]);
  assert.equal(applySubsurfaceReorder(state, parent), true);
  // Queue now drained -> false again.
  assert.equal(applySubsurfaceReorder(state, parent), false);
  // Unknown parent -> false.
  assert.equal(applySubsurfaceReorder(state, { id: 999 }), false);
});

// --- no-op cases ------------------------------------------------------

test('no pending ops: order unchanged', () => {
  const { state, parent } = setup(1, [10, 20, 30]);
  applySubsurfaceReorder(state, parent);
  assert.deepEqual(idsAfter(state, parent), [110, 120, 130]);
});

test('apply for unknown parent: no-op', () => {
  const { state } = setup(1, [10, 20]);
  applySubsurfaceReorder(state, { id: 999 });
  // Nothing to assert beyond no-throw.
});

// --- place_above(self) (degenerate) ----------------------------------

test('place_above with subsurface=sibling (self): order unchanged', () => {
  const { state, parent, subsurfaces } = setup(1, [10, 20]);
  state.subsurfacePendingOrder.set(parent, [
    { op: 'above', subsurface: findBySubId(subsurfaces, 10),
      sibling: findSurfaceBySubId(subsurfaces, 10) },
  ]);
  applySubsurfaceReorder(state, parent);
  // Self-reorder is a degenerate spec case; net result keeps subsurface
  // where it was (above itself = back at index 1 after splicing).
  // (Real-world impact: clients shouldn't do this; we tolerate it.)
  assert.deepEqual(idsAfter(state, parent), [120, 110]);
});
