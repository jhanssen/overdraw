// Pure-unit tests for the windows broker's request-focus-decision route.
// The broker validates the FocusReason and forwards to seat.dispatchFocusEvent;
// the seat (constructed under installProtocols) is the source of pointer +
// keyboard-focus state for the dispatched FocusInputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowsBroker } from '../packages/core/dist/plugins/windows-broker.js';
import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../packages/core/dist/events/window-bus.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
  };
}

// Records dispatchFocusEvent calls. applyKeyboardFocus stub satisfies the
// SeatState shape; the broker only invokes dispatchFocusEvent here.
function makeSeat() {
  const calls = [];
  return {
    calls,
    seat: {
      applyKeyboardFocus() {},
      dispatchFocusEvent(reason, trigger) { calls.push({ reason, trigger }); },
    },
  };
}

function brokerWithSeat(seat) {
  const sink = mockSink();
  const wm = createWm(sink, { width: 800, height: 600 });
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const state = { bus, wm, surfaces: new Map(), compositor: sink, seat };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  return broker;
}

test('request-focus-decision: forwards reason to seat.dispatchFocusEvent', () => {
  const { seat, calls } = makeSeat();
  const broker = brokerWithSeat(seat);
  broker('p', 'windows.request-focus-decision', { reason: 'workspace-changed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reason, 'workspace-changed');
  assert.equal(calls[0].trigger, undefined);
});

test('request-focus-decision: forwards trigger when present', () => {
  const { seat, calls } = makeSeat();
  const broker = brokerWithSeat(seat);
  broker('p', 'windows.request-focus-decision', { reason: 'window-mapped', trigger: 7 });
  assert.deepEqual(calls[0], { reason: 'window-mapped', trigger: 7 });
});

test('request-focus-decision: accepts every FocusReason in the canonical set', () => {
  const { seat, calls } = makeSeat();
  const broker = brokerWithSeat(seat);
  const reasons = [
    'pointer-enter', 'pointer-leave', 'pointer-button',
    'window-mapped', 'window-unmapped', 'window-raised',
    'workspace-changed', 'explicit',
  ];
  for (const r of reasons) broker('p', 'windows.request-focus-decision', { reason: r });
  assert.deepEqual(calls.map((c) => c.reason), reasons);
});

test('request-focus-decision: unknown reason throws malformed payload', () => {
  const broker = brokerWithSeat(makeSeat().seat);
  assert.throws(() => broker('p', 'windows.request-focus-decision', { reason: 'nope' }),
    /malformed payload/);
});

test('request-focus-decision: non-string reason throws malformed payload', () => {
  const broker = brokerWithSeat(makeSeat().seat);
  assert.throws(() => broker('p', 'windows.request-focus-decision', { reason: 42 }),
    /malformed payload/);
});

test('request-focus-decision: missing reason throws malformed payload', () => {
  const broker = brokerWithSeat(makeSeat().seat);
  assert.throws(() => broker('p', 'windows.request-focus-decision', {}),
    /malformed payload/);
});

test('request-focus-decision: non-number trigger throws malformed payload', () => {
  const broker = brokerWithSeat(makeSeat().seat);
  assert.throws(() => broker('p', 'windows.request-focus-decision',
    { reason: 'explicit', trigger: 'oops' }),
    /malformed payload/);
});

test('request-focus-decision: no seat bound -> silent no-op', () => {
  // state.seat is null until installProtocols runs; the broker should
  // tolerate this (same pattern as windows.focus).
  const sink = mockSink();
  const wm = createWm(sink, { width: 800, height: 600 });
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const state = { bus, wm, surfaces: new Map(), compositor: sink, seat: null };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  assert.equal(broker('p', 'windows.request-focus-decision', { reason: 'explicit' }), null);
});
