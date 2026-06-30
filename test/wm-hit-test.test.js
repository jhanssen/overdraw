// Pure-unit tests for wm.windowAt with the optional `accept` predicate
// (used by the seat's input-region-aware pick).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

async function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  await wm.settled();
  wm.windowHasContent(id);
}

test('windowAt: hits the rect when no predicate', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  assert.equal(wm.windowAt(500, 300)?.surfaceId, 1);
  assert.equal(wm.windowAt(2000, 2000), null);
});

test('windowAt: predicate accepting always returns the topmost', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  const r = wm.windowAt(500, 300, () => true);
  assert.equal(r?.surfaceId, 1);
});

test('windowAt: predicate rejecting falls through (single window) -> null', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  const r = wm.windowAt(500, 300, () => false);
  assert.equal(r, null);
});

test('windowAt: predicate rejecting front window falls through to back', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  // With two windows in master-stack, tiles don't overlap. To exercise
  // the fallthrough we need overlap; floating windows give us that.
  await addMapped(wm, 1);
  await addMapped(wm, 2);   // 2 is master (front), 1 is stack
  // Float window 2 over the area where window 1 is (the stack column).
  await wm.propose(2, { tiling: 'floating' }, 'user-input');
  wm.setFloatingRect(2, { x: 500, y: 0, width: 400, height: 400 });
  await wm.settled();
  // A point in the overlap: front (2) rejects, falls through to back (1).
  const r = wm.windowAt(600, 200, (win) => win.surfaceId !== 2);
  assert.equal(r?.surfaceId, 1);
});

test('windowAt: floating dialog over its parent wins the hit (z, not list order)', async () => {
  const placed = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
    outputContent: () => new Map(placed.length ? [[0, [...placed]]] : []),
  });
  // Parent fills the output.
  wm.addWindow(1, res(1));
  placed.push(1);
  await wm.settled();
  wm.windowHasContent(1);
  await wm.settled();
  // A transient child floats over the parent. It maps AFTER the parent, so the
  // plugin's membership list is [1, 2] (parent first); only win.z puts the
  // dialog on top. Hit-testing by list order would (wrongly) return the parent.
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1 }, 'client-request');
  placed.push(2);
  wm.windowHasContent(2, { width: 400, height: 300 });
  await wm.settled();
  assert.equal(wm.getWindowState(2)?.tiling, 'floating', 'parented window floats');
  // (500,300) is inside the centered dialog (300..700 x 150..450) AND inside
  // the parent (fills the output). The dialog wins: its z is above the parent.
  assert.equal(wm.windowAt(500, 300)?.surfaceId, 2,
    'dialog over its parent receives the hit, not the parent');
});

test('windowAt: predicate receives surface-local coords', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  let seen = null;
  wm.windowAt(250, 100, (_win, lx, ly) => {
    seen = { lx, ly };
    return true;
  });
  // Window 1 fills the output starting at (0,0), so surface-local = output-space.
  assert.deepEqual(seen, { lx: 250, ly: 100 });
});

test('windowAt: predicate sees translated coords when window is at non-origin rect', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  wm.setFloatingRect(1, { x: 100, y: 50, width: 400, height: 300 });
  await wm.settled();
  let seen = null;
  wm.windowAt(250, 200, (_win, lx, ly) => {
    seen = { lx, ly };
    return true;
  });
  // 250 - 100 = 150; 200 - 50 = 150.
  assert.deepEqual(seen, { lx: 150, ly: 150 });
});
