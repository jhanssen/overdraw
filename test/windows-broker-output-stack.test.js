// Pure-unit tests for the windows broker's set-output-stack handling.
// Verifies the broker calls the compositor sink with the right args and
// rejects malformed payloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowsBroker } from '../dist/plugins/windows-broker.js';
import { createWm } from '../dist/wm/index.js';
import { DynamicBus } from '../dist/events/dynamic-bus.js';
import { createCompositorBus } from '../dist/events/window-bus.js';

function mockSink() {
  const calls = [];
  return {
    calls,
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack(outputId, ids) {
      this.calls.push({ method: 'setOutputStack', outputId, ids });
    },
  };
}

function makeState(wm, bus) {
  return { bus, wm, pendingWindowChanges: undefined, surfaces: new Map(), seat: null,
    compositor: null, decorationResize: null };
}

function makeBroker() {
  const sink = mockSink();
  const wm = createWm(sink, { width: 800, height: 600 });
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const broker = createWindowsBroker({
    wm, compositor: sink, state: makeState(wm, bus), pluginBus, bus,
  });
  return { broker, sink, wm };
}

test('set-output-stack: passes outputId + ids to the compositor sink', () => {
  const { broker, sink } = makeBroker();
  broker('test-plugin', 'windows.set-output-stack', { outputId: 0, ids: [1, 2, 3] });
  assert.equal(sink.calls.length, 1);
  assert.deepEqual(sink.calls[0], { method: 'setOutputStack', outputId: 0, ids: [1, 2, 3] });
});

test('set-output-stack: null ids clears the override', () => {
  const { broker, sink } = makeBroker();
  broker('test-plugin', 'windows.set-output-stack', { outputId: 0, ids: null });
  assert.deepEqual(sink.calls[0], { method: 'setOutputStack', outputId: 0, ids: null });
});

test('set-output-stack: empty ids array is valid (composes nothing)', () => {
  const { broker, sink } = makeBroker();
  broker('test-plugin', 'windows.set-output-stack', { outputId: 0, ids: [] });
  assert.deepEqual(sink.calls[0], { method: 'setOutputStack', outputId: 0, ids: [] });
});

test('set-output-stack: missing outputId throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-output-stack', { ids: [1] }),
    /malformed payload/);
});

test('set-output-stack: non-number outputId throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-output-stack', { outputId: 'x', ids: [1] }),
    /malformed payload/);
});

test('set-output-stack: non-array ids (not null) throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-output-stack', { outputId: 0, ids: 'nope' }),
    /malformed payload/);
});

test('set-output-stack: array with non-numbers throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-output-stack', { outputId: 0, ids: [1, 'two'] }),
    /malformed payload/);
});

test('set-output-stack: missing compositor.setOutputStack rejects', () => {
  // Use a sink without setOutputStack (the protocol marks it optional).
  const sinkNoOut = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setOutputStack
  };
  const wm = createWm(sinkNoOut, { width: 800, height: 600 });
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const broker = createWindowsBroker({
    wm, compositor: sinkNoOut, state: makeState(wm, bus), pluginBus, bus,
  });
  assert.throws(() => broker('p', 'windows.set-output-stack', { outputId: 0, ids: [1] }),
    /not supported/);
});
