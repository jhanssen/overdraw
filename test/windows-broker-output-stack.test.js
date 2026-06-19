// Pure-unit tests for the windows broker's set-output-stack handling.
// Verifies the broker calls the compositor sink with the right args and
// rejects malformed payloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowsBroker } from '../packages/core/dist/plugins/windows-broker.js';
import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../packages/core/dist/events/window-bus.js';

function mockSink() {
  const calls = [];
  return {
    calls,
    setSurfaceLayout() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setStack(ids) { this.calls.push({ method: 'setStack', ids }); },
    setOutputStack(outputId, ids) {
      this.calls.push({ method: 'setOutputStack', outputId, ids });
    },
  };
}

function makeState(wm, bus, sink) {
  return { bus, wm, pendingWindowChanges: undefined, surfaces: new Map(), seat: null,
    compositor: sink, decorationResize: null };
}

function makeBroker() {
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const broker = createWindowsBroker({
    wm, compositor: sink, state: makeState(wm, bus, sink), pluginBus, bus,
  });
  return { broker, sink, wm };
}

// The broker's set-output-stack stores the toplevel-order filter and triggers
// rebuildStackWithPopups, which expands each filter into the full draw list
// ([toplevel, ...subsurface subtree, ...popups]) and pushes via
// setOutputStack. With no WM windows the expansion is empty.
test('set-output-stack: pushes expanded toplevel order to the sink', () => {
  const { broker, sink, wm } = makeBroker();
  // Stub the WM with three toplevels so the expansion contains them.
  const fakeSurfaceRec = (id) => ({ resource: { id } });
  wm.addWindow(1, fakeSurfaceRec(1));
  wm.addWindow(2, fakeSurfaceRec(2));
  wm.addWindow(3, fakeSurfaceRec(3));
  for (const id of [1, 2, 3]) wm.windowHasContent(id);
  sink.calls.length = 0;  // ignore stack pushes from addWindow/windowHasContent
  broker('test-plugin', 'windows.set-output-stack', { outputId: 0, ids: [3, 1, 2] });
  // rebuildStackWithPopups pushes the GLOBAL stack via setStack, then the
  // per-output expansion via setOutputStack. We assert the per-output call
  // reflects the requested toplevel order (no subsurfaces in this fixture).
  const out = sink.calls.find((c) => c.method === 'setOutputStack');
  assert.ok(out, 'setOutputStack was called');
  assert.equal(out.outputId, 0);
  assert.deepEqual(out.ids, [3, 1, 2]);
});

test('set-output-stack: null ids clears the override', () => {
  const { broker, sink } = makeBroker();
  broker('test-plugin', 'windows.set-output-stack', { outputId: 0, ids: null });
  // The broker clears directly via setOutputStack(outputId, null) and then
  // calls rebuildStackWithPopups; the clear call must have happened.
  const cleared = sink.calls.find((c) =>
    c.method === 'setOutputStack' && c.outputId === 0 && c.ids === null);
  assert.ok(cleared, `expected a setOutputStack(0, null) call; got ${JSON.stringify(sink.calls)}`);
});

test('set-output-stack: empty ids array is a valid filter (composes nothing)', () => {
  const { broker, sink } = makeBroker();
  broker('test-plugin', 'windows.set-output-stack', { outputId: 0, ids: [] });
  const out = sink.calls.find((c) =>
    c.method === 'setOutputStack' && c.outputId === 0);
  assert.ok(out, 'setOutputStack was called');
  assert.deepEqual(out.ids, []);
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

// ---- windows.focus (explicit-override path; core-plugin-api.md §1) ---------

// A minimal seat stub: records applyKeyboardFocus calls.
function brokerWithSeat() {
  const seatCalls = [];
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const state = makeState(wm, bus, sink);
  state.seat = { applyKeyboardFocus: (id) => seatCalls.push(id) };
  const broker = createWindowsBroker({
    wm, compositor: sink, state, pluginBus, bus,
  });
  return { broker, seatCalls };
}

test('windows.focus: forwards id to seat.applyKeyboardFocus', () => {
  const { broker, seatCalls } = brokerWithSeat();
  broker('p', 'windows.focus', { id: 42 });
  assert.deepEqual(seatCalls, [42]);
});

test('windows.focus: null clears focus via the seat', () => {
  const { broker, seatCalls } = brokerWithSeat();
  broker('p', 'windows.focus', { id: null });
  assert.deepEqual(seatCalls, [null]);
});

test('windows.focus: missing id throws malformed payload', () => {
  const { broker } = brokerWithSeat();
  assert.throws(() => broker('p', 'windows.focus', {}), /malformed payload/);
});

test('windows.focus: non-number, non-null id throws', () => {
  const { broker } = brokerWithSeat();
  assert.throws(() => broker('p', 'windows.focus', { id: 'oops' }),
    /malformed payload/);
});

test('windows.focus: no seat bound -> silent no-op', () => {
  // state.seat is null until installProtocols runs; the broker should
  // tolerate this (some lifecycle stage where the seat doesn't exist).
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const broker = createWindowsBroker({
    wm, compositor: sink, state: makeState(wm, bus, sink), pluginBus, bus,
  });
  // No throw; returns null.
  assert.equal(broker('p', 'windows.focus', { id: 42 }), null);
});

// ---- set-output-stack (cont.) ----------------------------------------------

test('set-output-stack: missing compositor.setOutputStack rejects', () => {
  // Use a sink without setOutputStack (the protocol marks it optional).
  const sinkNoOut = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setOutputStack
  };
  const wm = createWm(sinkNoOut, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const broker = createWindowsBroker({
    wm, compositor: sinkNoOut, state: makeState(wm, bus, sinkNoOut), pluginBus, bus,
  });
  assert.throws(() => broker('p', 'windows.set-output-stack', { outputId: 0, ids: [1] }),
    /not supported/);
});
