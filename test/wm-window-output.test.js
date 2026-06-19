// Per-window outputId assignment + reassignment.
//
// - addWindow defaults to the WM's primary output.
// - addWindow honors an explicit outputId opt.
// - setWindowOutput moves a window to a different output.
// - setFloatingRect with a rect whose center lands on another output
//   reassigns the window.
// - setOutputs reassigns windows whose output disappeared to the new primary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';

function mockSink() {
  return {
    calls: { setSurfaceLayout: [], setStack: [] },
    setSurfaceLayout(...args) { this.calls.setSurfaceLayout.push(args); },
    setStack(ids) { this.calls.setStack.push([...ids]); },
    commitSurfaceBuffer() { return true; },
    commitSurfaceDmabuf() { return true; },
    removeSurface() {},
    takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; },
  };
}

const TWO_OUTPUTS = [
  { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
  { id: 1, rect: { x: 1000, y: 0, width: 1000, height: 600 }, scale: 1 },
];

function res(id) { return { __surface: id }; }

test('addWindow: defaults to the primary output (lowest id)', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) });
  assert.equal(wm.outputIdOf(101), 0);
  assert.equal(wm.primaryOutputId(), 0);
});

test('addWindow: honors opts.outputId when it is a live output', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) }, { outputId: 1 });
  assert.equal(wm.outputIdOf(101), 1);
});

test('addWindow: unknown opts.outputId collapses to the primary', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) }, { outputId: 99 });
  assert.equal(wm.outputIdOf(101), 0);
});

test('setWindowOutput: moves a window between live outputs', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) });
  wm.setWindowOutput(101, 1);
  assert.equal(wm.outputIdOf(101), 1);
});

test('setWindowOutput: rejects an unknown output id (no change)', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) });
  wm.setWindowOutput(101, 99);
  assert.equal(wm.outputIdOf(101), 0);
});

test('setFloatingRect: a rect whose center is on another output reassigns', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) });
  // Window starts on output 0; drop a floating rect whose center is at x=1500
  // (output 1's middle).
  wm.setFloatingRect(101, { x: 1450, y: 100, width: 100, height: 100 });
  assert.equal(wm.outputIdOf(101), 1);
});

test('setFloatingRect: a rect that straddles outputs picks the dominant by center', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) });
  // Center at x=950 -> still on output 0 (which extends to x=1000 exclusive).
  wm.setFloatingRect(101, { x: 800, y: 100, width: 300, height: 100 });
  assert.equal(wm.outputIdOf(101), 0);
  // Slide right: center at x=1051 -> output 1.
  wm.setFloatingRect(101, { x: 900, y: 100, width: 300, height: 100 });
  assert.equal(wm.outputIdOf(101), 1);
});

test('setOutputs: a window whose output disappeared moves to the new primary', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) }, { outputId: 1 });
  // Output 1 disappears; only output 0 remains.
  wm.setOutputs([TWO_OUTPUTS[0]]);
  assert.equal(wm.outputIdOf(101), 0);
});

test('setOutputs: a window on a still-live output keeps its outputId', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  wm.addWindow(101, { resource: res(101) }, { outputId: 1 });
  wm.addWindow(102, { resource: res(102) }, { outputId: 0 });
  // Re-issue the same outputs (e.g. one of them resized) -- assignments stick.
  wm.setOutputs(TWO_OUTPUTS);
  assert.equal(wm.outputIdOf(101), 1);
  assert.equal(wm.outputIdOf(102), 0);
});

test('createWm: rejects an empty outputs list', () => {
  assert.throws(() => createWm(mockSink(), []), /non-empty/);
});

test('setOutputs: rejects an empty outputs list', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  assert.throws(() => wm.setOutputs([]), /non-empty/);
});

test('outputIdOf: unknown surface returns undefined', () => {
  const wm = createWm(mockSink(), TWO_OUTPUTS);
  assert.equal(wm.outputIdOf(999), undefined);
});
