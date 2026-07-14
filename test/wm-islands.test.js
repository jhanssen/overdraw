// wm.setIslands: explicit islands override the implicit per-output
// derivation in the layout snapshot, null reverts, and unchanged pushes
// are no-ops (no relayout scheduled).
//
// GPU-free: real WM with a capture layout driver.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';

function mockSink() {
  return { setSurfaceLayout() {}, setStack() {} };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

function captureDriver() {
  const snapshots = [];
  const factory = (target, snapshot) => ({
    schedule() { snapshots.push(snapshot()); },
    settled() { return Promise.resolve(); },
  });
  return { snapshots, factory };
}

const OUTPUT = [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }];

test('explicit islands replace the implicit derivation; null reverts', () => {
  const cap = captureDriver();
  const wm = createWm(mockSink(), OUTPUT, { layoutDriverFactory: cap.factory });
  wm.addWindow(1, res(1));
  wm.windowHasContent(1);

  const implicit = cap.snapshots.at(-1).islands;
  assert.equal(implicit.length, 1);
  assert.equal(implicit[0].id, 0);       // implicit id = outputId
  assert.equal(implicit[0].rect, null);

  const explicit = [{
    id: 42, outputId: 0,
    rect: { x: 10, y: 10, width: 300, height: 300 }, members: [1],
  }];
  assert.equal(wm.setIslands(explicit), true);
  const snap = cap.snapshots.at(-1).islands;
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, 42);
  assert.deepEqual(snap[0].rect, explicit[0].rect);
  assert.deepEqual(snap[0].members, [1]);

  assert.equal(wm.setIslands(null), true);
  assert.equal(cap.snapshots.at(-1).islands[0].id, 0);  // implicit again
});

test('unchanged islands are a no-op (no relayout scheduled)', () => {
  const cap = captureDriver();
  const wm = createWm(mockSink(), OUTPUT, { layoutDriverFactory: cap.factory });
  const islands = [{ id: 7, outputId: 0, rect: null, members: [3, 4] }];
  assert.equal(wm.setIslands(islands), true);
  const count = cap.snapshots.length;
  // Same content, fresh arrays/objects: must not schedule again.
  assert.equal(wm.setIslands(
    [{ id: 7, outputId: 0, rect: null, members: [3, 4] }]), false);
  assert.equal(cap.snapshots.length, count);
  // Member-order change IS a change.
  assert.equal(wm.setIslands(
    [{ id: 7, outputId: 0, rect: null, members: [4, 3] }]), true);
  assert.equal(cap.snapshots.length, count + 1);
});
