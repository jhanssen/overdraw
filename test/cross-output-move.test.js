// Pure-unit tests for installCrossOutputMove.
//
// The handler freezes the moving surface synchronously (via a broker
// hold) and drives wl_surface.enter/leave + preferred_scale on the
// target output. The hold's readiness is gated on the WM resize-tx
// joining it; once joined, the WM tx's predicate (acked + ready buffer
// at new logical size) is the actual apply gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createSurfaceTransactionBroker }
  from '../packages/core/dist/surface-transaction.js';
import { installCrossOutputMove }
  from '../packages/core/dist/protocols/cross-output-move.js';

function makeFakeSink() {
  let cb = null;
  const calls = [];
  return {
    calls,
    freezeSurface(id) { calls.push(['freeze', id]); },
    thawSurface(id) { calls.push(['thaw', id]); },
    setFrozenReadyHandler(c) { cb = c; },
    fireReady(id) { cb?.(id); },
    surfaceOutputs(_id) { return [1]; },
  };
}

function makeFakeAddon() { return { clientId(_r) { return 1; } }; }

function makeFakeState(addonResource, opts = {}) {
  const wlEnter = [];
  const wlLeave = [];
  const wlOutputResources = new Map([
    [1, new Set([{ destroyed: false, _id: 1 }])],
    [2, new Set([{ destroyed: false, _id: 2 }])],
  ]);
  const scales = opts.scales ?? { 1: 1.75, 2: 1.5 };
  const outputs = new Map();
  for (const [k, scale] of Object.entries(scales)) {
    outputs.set(Number(k), {
      id: Number(k),
      name: `out-${k}`,
      rect: { x: 0, y: 0, width: 1920, height: 1080 },
      scale,
    });
  }
  const fractionalScaleResources = new Map();
  const fractionalSent = [];
  if (opts.useFractional !== false) {
    fractionalScaleResources.set(
      { destroyed: false, _kind: 'wp_fractional_scale_v1' },
      addonResource);
  }
  return {
    events: {
      wl_surface: {
        send_enter(s, o) { wlEnter.push({ s, o }); },
        send_leave(s, o) { wlLeave.push({ s, o }); },
      },
      wp_fractional_scale_v1: {
        send_preferred_scale(_r, v) { fractionalSent.push(v); },
      },
    },
    wlOutputResources,
    fractionalScaleResources,
    outputs,
    surfacesById: new Map([
      [42, {
        id: 42, resource: addonResource,
        mapped: true, hasContent: true,
        enteredOutputs: new Set([1]),
      }],
    ]),
    wlEnter, wlLeave, fractionalSent,
  };
}

test('cross-output: scale change + fractional client freezes + drives residency', () => {
  const sink = makeFakeSink();
  const broker = createSurfaceTransactionBroker(sink);
  const surfRes = { destroyed: false };
  const state = makeFakeState(surfRes);
  state.surfaceTx = broker;
  state.compositor = sink;
  const bus = new DynamicBus();
  installCrossOutputMove(state, makeFakeAddon(), bus);

  bus.emit('workspace.window-moved', {
    surfaceId: 42, fromOutputId: 1, toOutputId: 2,
  });

  assert.ok(broker.has(42), 'hold registered');
  assert.deepEqual(broker.tagsFor(42), ['cross-output']);
  assert.deepEqual(sink.calls.filter((c) => c[1] === 42), [['freeze', 42]]);
  // Residency drove enter/leave + preferred_scale.
  assert.equal(state.wlEnter.length, 1);
  assert.equal(state.wlLeave.length, 1);
  assert.deepEqual(state.fractionalSent, [180]); // 1.5 * 120
});

test('cross-output hold releases when wm-tx joins and is ready', () => {
  const sink = makeFakeSink();
  const broker = createSurfaceTransactionBroker(sink);
  const surfRes = { destroyed: false };
  const state = makeFakeState(surfRes);
  state.surfaceTx = broker;
  state.compositor = sink;
  const bus = new DynamicBus();
  installCrossOutputMove(state, makeFakeAddon(), bus);

  bus.emit('workspace.window-moved', {
    surfaceId: 42, fromOutputId: 1, toOutputId: 2,
  });
  assert.ok(broker.has(42), 'hold persists pre-wm-tx');

  let wmReady = false;
  let wmApplied = false;
  broker.begin(42, {
    tag: 'wm-tx', batchKey: 'wm-tx',
    ready: () => wmReady,
    onApply: () => { wmApplied = true; },
  });
  // wm-tx joined but not yet ready -> batch still waits.
  assert.ok(broker.has(42));
  // No second freezeSurface (merge into existing hold).
  assert.equal(sink.calls.filter((c) => c[0] === 'freeze').length, 1);

  wmReady = true;
  broker.evaluate();
  assert.equal(wmApplied, true, 'wm tx applied');
  assert.ok(!broker.has(42));
});

test('cross-output: same-scale move is a no-op', () => {
  const sink = makeFakeSink();
  const broker = createSurfaceTransactionBroker(sink);
  const surfRes = { destroyed: false };
  const state = makeFakeState(surfRes, { scales: { 1: 1.5, 2: 1.5 } });
  state.surfaceTx = broker;
  state.compositor = sink;
  const bus = new DynamicBus();
  installCrossOutputMove(state, makeFakeAddon(), bus);

  bus.emit('workspace.window-moved', {
    surfaceId: 42, fromOutputId: 1, toOutputId: 2,
  });
  assert.equal(broker.size(), 0);
  assert.equal(sink.calls.length, 0);
});

test('cross-output: non-fractional client is a no-op', () => {
  const sink = makeFakeSink();
  const broker = createSurfaceTransactionBroker(sink);
  const surfRes = { destroyed: false };
  const state = makeFakeState(surfRes, { useFractional: false });
  state.surfaceTx = broker;
  state.compositor = sink;
  const bus = new DynamicBus();
  installCrossOutputMove(state, makeFakeAddon(), bus);

  bus.emit('workspace.window-moved', {
    surfaceId: 42, fromOutputId: 1, toOutputId: 2,
  });
  assert.equal(broker.size(), 0);
});

test('cross-output: unmapped or no-content surface is ignored', () => {
  const sink = makeFakeSink();
  const broker = createSurfaceTransactionBroker(sink);
  const surfRes = { destroyed: false };
  const state = makeFakeState(surfRes);
  state.surfacesById.get(42).hasContent = false;
  state.surfaceTx = broker;
  state.compositor = sink;
  const bus = new DynamicBus();
  installCrossOutputMove(state, makeFakeAddon(), bus);

  bus.emit('workspace.window-moved', {
    surfaceId: 42, fromOutputId: 1, toOutputId: 2,
  });
  assert.equal(broker.size(), 0);
});
