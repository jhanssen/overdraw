// Pure-unit tests for the windows broker's measure-island handling: the
// seam an island source uses to size an elastic island from the active
// layout provider's natural size (canvas-design.md §5). Verifies the
// payload reaches the provider as MeasureInputs, that a provider without
// measure() (or one that throws) degrades to null rather than an error,
// and that malformed payloads reject.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowsBroker } from '../packages/core/dist/plugins/windows-broker.js';
import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../packages/core/dist/events/window-bus.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setLayerSurfaces() {}, setStack() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
  };
}

// `invokeLayout` omitted entirely -> the no-provider configuration.
function makeBroker(invokeLayout) {
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const state = {
    bus, wm, pendingWindowChanges: undefined, surfaces: new Map(), seat: null,
    compositor: sink, decorationResize: null,
  };
  const broker = createWindowsBroker({
    wm, compositor: sink, state, pluginBus, bus,
    ...(invokeLayout ? { invokeLayout } : {}),
  });
  return { broker };
}

const PAYLOAD = {
  islandId: 7,
  windows: [101, 102],
  workarea: { width: 800, height: 600 },
  layout: { mode: 'columns', column: 0.75 },
};

test('measure-island: forwards MeasureInputs to the layout provider', async () => {
  const calls = [];
  const { broker } = makeBroker((method, args) => {
    calls.push({ method, args });
    return Promise.resolve({ width: 1800, height: 600 });
  });
  const r = await broker('canvas', 'windows.measure-island', PAYLOAD);
  assert.deepEqual(r, { width: 1800, height: 600 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'measure');
  assert.deepEqual(calls[0].args, [{
    windows: [{ id: 101 }, { id: 102 }],
    workarea: { width: 800, height: 600 },
    island: { id: 7, layout: { mode: 'columns', column: 0.75 } },
  }]);
});

test('measure-island: an absent layout hint is omitted, not sent as undefined', async () => {
  const calls = [];
  const { broker } = makeBroker((method, args) => {
    calls.push(args[0]);
    return Promise.resolve({ width: 800, height: 600 });
  });
  const { layout, ...noHint } = PAYLOAD;
  void layout;
  await broker('canvas', 'windows.measure-island', noHint);
  assert.deepEqual(calls[0].island, { id: 7 });
  assert.ok(!('layout' in calls[0].island));
});

test('measure-island: no layout invoker -> null (islands stay workarea-sized)', async () => {
  const { broker } = makeBroker(null);
  assert.equal(await broker('canvas', 'windows.measure-island', PAYLOAD), null);
});

test('measure-island: a provider without measure() resolves null, not an error', async () => {
  // The runtime rejects when the active provider has no such method.
  const { broker } = makeBroker(() => Promise.reject(new Error('no method measure')));
  assert.equal(await broker('canvas', 'windows.measure-island', PAYLOAD), null);
});

test('measure-island: a malformed provider result resolves null', async () => {
  for (const bad of [null, undefined, {}, { width: 'wide', height: 600 }]) {
    const { broker } = makeBroker(() => Promise.resolve(bad));
    assert.equal(await broker('canvas', 'windows.measure-island', PAYLOAD), null,
      `bad result ${JSON.stringify(bad)} -> null`);
  }
});

test('measure-island: malformed payloads reject', async () => {
  const { broker } = makeBroker(() => Promise.resolve({ width: 1, height: 1 }));
  const bad = [
    [null, /malformed/],
    [{ ...PAYLOAD, islandId: 'seven' }, /islandId/],
    [{ ...PAYLOAD, windows: [1, 'two'] }, /windows/],
    [{ ...PAYLOAD, windows: 'all' }, /windows/],
    [{ ...PAYLOAD, workarea: undefined }, /workarea/],
    [{ ...PAYLOAD, workarea: { width: 800 } }, /workarea/],
    [{ ...PAYLOAD, layout: 'columns' }, /layout/],
  ];
  for (const [payload, re] of bad) {
    await assert.rejects(
      async () => broker('canvas', 'windows.measure-island', payload), re,
      `payload ${JSON.stringify(payload)} rejects`);
  }
});
