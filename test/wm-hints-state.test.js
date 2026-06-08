// Pure-unit tests for the WM's hint/state extensions (core-plugin-api.md §1).
// Uses a mock CompositorSink (same shape as test/wm.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../dist/wm/index.js';

function mockSink() {
  return {
    layouts: [],
    stacks: [],
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setStack(ids) { this.stacks.push(ids); },
    setLayerSurfaces() {},
    setSurfaceTexture() {},
    commitSurfaceBuffer() {},
    commitSurfaceDmabuf() {},
    removeSurface() {},
    takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; },
    afterCurrentFrame() {},
    renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  wm.windowHasContent(id);
}

// --- hints ----------------------------------------------------------------

test('hints: new window starts with all hints false', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  assert.deepEqual(wm.getHints(1),
    { floating: false, fullscreen: false, maximized: false, minimized: false });
});

test('setHint: changes value and returns true', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  assert.equal(wm.setHint(1, 'floating', true), true);
  assert.equal(wm.getHints(1).floating, true);
});

test('setHint: setting to the same value returns false (no change)', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setHint(1, 'fullscreen', true);
  assert.equal(wm.setHint(1, 'fullscreen', true), false);
});

test('setHint: unknown window returns false', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  assert.equal(wm.setHint(999, 'maximized', true), false);
});

test('getHints: unknown window returns null', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  assert.equal(wm.getHints(999), null);
});

test('setHint: each field is independent', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setHint(1, 'floating', true);
  wm.setHint(1, 'maximized', true);
  assert.deepEqual(wm.getHints(1),
    { floating: true, fullscreen: false, maximized: true, minimized: false });
});

// --- state bag ------------------------------------------------------------

test('state: setState stores the value', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setState(1, 'workspace.id', 3);
  assert.equal(wm.getState(1, 'workspace.id'), 3);
});

test('state: setState returns true on first set, false on identical re-set', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  assert.equal(wm.setState(1, 'k', 42), true);
  assert.equal(wm.setState(1, 'k', 42), false);
});

test('state: setState to a different value returns true', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setState(1, 'k', 1);
  assert.equal(wm.setState(1, 'k', 2), true);
});

test('state: getState returns undefined for unset keys', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  assert.equal(wm.getState(1, 'nope'), undefined);
});

test('state: getState returns undefined for unknown windows', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  assert.equal(wm.getState(999, 'k'), undefined);
});

test('state: deleteState removes the value', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setState(1, 'k', 'v');
  assert.equal(wm.deleteState(1, 'k'), true);
  assert.equal(wm.getState(1, 'k'), undefined);
});

test('state: deleteState returns false when key was unset', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  assert.equal(wm.deleteState(1, 'nope'), false);
});

test('state: setting null is distinct from delete (key still present, value null)', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setState(1, 'k', null);
  assert.equal(wm.getState(1, 'k'), null);
  // The state-all snapshot includes the key explicitly.
  assert.deepEqual(wm.getStateAll(1), { k: null });
});

test('state: getStateAll returns all entries; empty when none', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setState(1, 'a', 1);
  wm.setState(1, 'b', 'two');
  wm.setState(1, 'c', { nested: true });
  assert.deepEqual(wm.getStateAll(1), { a: 1, b: 'two', c: { nested: true } });
});

test('state: getStateAll returns {} for unknown windows', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  assert.deepEqual(wm.getStateAll(999), {});
});

// --- snapshots ------------------------------------------------------------

test('getSnapshot: includes hints + state + geometry', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setHint(1, 'floating', true);
  wm.setState(1, 'workspace.id', 5);
  const s = wm.getSnapshot(1);
  assert.equal(s.surfaceId, 1);
  assert.equal(s.hints.floating, true);
  assert.equal(s.hints.fullscreen, false);
  assert.equal(s.state['workspace.id'], 5);
  assert.equal(s.hasContent, true);
  assert.equal(s.contentGated, false);
  // Geometry comes from the layout; just confirm the rect exists.
  assert.equal(typeof s.rect.width, 'number');
  assert.equal(typeof s.outer.width, 'number');
});

test('getSnapshot: returns null for unknown window', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  assert.equal(wm.getSnapshot(999), null);
});

test('listSnapshots: returns one entry per tracked window in WM order', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  addMapped(wm, 2);
  addMapped(wm, 3);
  const all = wm.listSnapshots();
  assert.equal(all.length, 3);
  // Master-front; new windows are unshifted -> 3 is master, then 2, then 1.
  assert.deepEqual(all.map((w) => w.surfaceId), [3, 2, 1]);
});

test('listSnapshots: empty registry returns []', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  assert.deepEqual(wm.listSnapshots(), []);
});

test('snapshot: state map is copied (mutations on the snapshot do not affect WM)', () => {
  const wm = createWm(mockSink(), { width: 800, height: 600 });
  addMapped(wm, 1);
  wm.setState(1, 'k', 'v');
  const s = wm.getSnapshot(1);
  s.state.k = 'changed';
  s.hints.floating = true;
  assert.equal(wm.getState(1, 'k'), 'v');
  assert.equal(wm.getHints(1).floating, false);
});
