// The bundled animations plugin: claims + per-seam behavior + config +
// displacement. Loaded in-thread into a real PluginRuntime; a mock
// onRequest records animations.start/run and the gate/phantom calls, and
// events are driven directly on the plugin bus.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { withRuntime, waitFor, entry } from './plugin-helpers.mjs';

const RECT_A = { x: 0, y: 0, width: 400, height: 300 };
const RECT_B = { x: 100, y: 0, width: 500, height: 300 };
const OUTPUT = { x: 0, y: 0, width: 1920, height: 1080 };

function bundledEntry(raw) {
  return {
    module: '@overdraw/plugin-animations-default',
    name: 'animations-default',
    restart: 'never', maxRestarts: 3, windowSeconds: 60,
    bundled: true,
    raw,
  };
}

// Harness: records every animation spec + windows call, in arrival order.
function makeHarness() {
  const bus = new DynamicBus();
  const calls = [];
  let handle = 0;
  const onRequest = (_plugin, method, params) => {
    if (method === 'animations.start') {
      calls.push({ method, spec: params.spec });
      return { handle: ++handle };
    }
    if (method === 'animations.run') {
      calls.push({ method, spec: params.spec });
      return null;
    }
    if (method === 'animations.settled') return null;
    if (method === 'windows.release-opening-gate'
      || method === 'windows.destroy-phantom') {
      calls.push({ method, id: params.id });
      return null;
    }
    throw new Error(`no handler for '${method}'`);
  };
  const starts = () => calls.filter((c) => c.method === 'animations.start');
  return { bus, calls, onRequest, starts };
}

test('opening: animation primed before the gate releases', async () => {
  const h = makeHarness();
  await withRuntime({ bus: h.bus, onRequest: h.onRequest }, async (rt) => {
    await rt.load([bundledEntry(undefined)]);
    await rt.waitForNamespace('window-opening');
    h.bus.emit('window.opening', {
      surfaceId: 7, tiling: 'managed', outerRect: RECT_A, outputRect: OUTPUT,
    });
    await waitFor(() => h.calls.some((c) => c.method === 'windows.release-opening-gate'));
    const order = h.calls.map((c) => c.method);
    assert.ok(order.indexOf('animations.start') !== -1, 'slide-in started');
    assert.ok(order.indexOf('animations.start') < order.indexOf('windows.release-opening-gate'),
      'start value applied before the gate released');
    const spec = h.starts()[0].spec;
    assert.equal(spec.target.kind, 'window-transform');
    assert.equal(spec.from.translateX, -RECT_A.width, 'left-half tile slides in from the left');
  });
});

test('closing: phantom animates and is destroyed', async () => {
  const h = makeHarness();
  await withRuntime({ bus: h.bus, onRequest: h.onRequest }, async (rt) => {
    await rt.load([bundledEntry(undefined)]);
    await rt.waitForNamespace('window-closing');
    h.bus.emit('window.closing', {
      phantomSurfaceId: 99, tiling: 'floating', rect: RECT_A, outputRect: OUTPUT,
    });
    await waitFor(() => h.calls.some((c) => c.method === 'windows.destroy-phantom'));
    const runs = h.calls.filter((c) => c.method === 'animations.run');
    assert.equal(runs.length, 2, 'floating close = fade + scale');
    assert.equal(h.calls.at(-1).method, 'windows.destroy-phantom');
    assert.equal(h.calls.at(-1).id, 99);
  });
});

test('retile: immediate reasons presnap; held reasons wait for the apply seam', async () => {
  const h = makeHarness();
  await withRuntime({ bus: h.bus, onRequest: h.onRequest }, async (rt) => {
    await rt.load([bundledEntry(undefined)]);
    await rt.waitForNamespace('window-animations');
    await h.bus.emit('window.relayout', {
      surfaceId: 7, oldOuter: RECT_A, newOuter: RECT_B, reason: 'state-changed',
    });
    await waitFor(() => h.starts().length === 1);
    const spec = h.starts()[0].spec;
    assert.equal(spec.compose, 'relative');
    assert.equal(spec.from.translateX, RECT_A.x - RECT_B.x);
    assert.ok(Math.abs(spec.from.scaleX - RECT_A.width / RECT_B.width) < 1e-9);

    // Transaction-held reasons do NOT presnap at relayout time...
    await h.bus.emit('window.relayout', {
      surfaceId: 7, oldOuter: RECT_A, newOuter: RECT_B, reason: 'reorder',
    });
    assert.equal(h.starts().length, 1, 'reorder relayout is not presnapped');
    // ...they presnap when the batch lands.
    await h.bus.emit('stack.relayout-apply', {
      windows: [{ surfaceId: 7, oldOuter: RECT_A, newOuter: RECT_B, tiling: 'managed' }],
    });
    await waitFor(() => h.starts().length === 2);
  });
});

test('layer glide: announce starts toward the asked rect; land re-bases', async () => {
  const h = makeHarness();
  await withRuntime({ bus: h.bus, onRequest: h.onRequest }, async (rt) => {
    await rt.load([bundledEntry({ layer: { duration: 123 } })]);
    await rt.waitForNamespace('window-animations');
    h.bus.emit('layer.resize-announce', {
      surfaceId: 5, namespace: 'panel', fromRect: RECT_A, toRect: RECT_B,
    });
    await waitFor(() => h.starts().length === 1);
    const announce = h.starts()[0].spec;
    assert.equal(announce.compose, 'relative');
    assert.equal(announce.duration, 123, 'config layer duration honored');
    assert.equal(announce.to.translateX, RECT_B.x - RECT_A.x, 'announce targets the asked rect');
    assert.deepEqual(announce.from, { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 },
      'announce starts from the current value (identity offsets)');

    await h.bus.emit('layer.relayout', {
      surfaceId: 5, namespace: 'panel', oldRect: RECT_A, newRect: RECT_B,
    });
    await waitFor(() => h.starts().length === 2);
    const land = h.starts()[1].spec;
    assert.equal(land.from.translateX, RECT_A.x - RECT_B.x, 'land re-bases onto the new rect');
    assert.deepEqual(land.to, { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 });
  });
});

test('enabled:false claims nothing; events pass without animation', async () => {
  const h = makeHarness();
  await withRuntime({ bus: h.bus, onRequest: h.onRequest }, async (rt) => {
    await rt.load([bundledEntry({ enabled: false })]);
    h.bus.emit('window.opening', {
      surfaceId: 7, tiling: 'managed', outerRect: RECT_A, outputRect: OUTPUT,
    });
    await h.bus.emit('layer.resize-announce', {
      surfaceId: 5, namespace: 'panel', fromRect: RECT_A, toRect: RECT_B,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.calls.length, 0, 'no claims, no animations, no gate calls');
  });
});

test('a user claim on window-animations displaces the bundled geometry seams', async () => {
  const h = makeHarness();
  const overrideSaw = [];
  h.bus.subscribe('test.override-saw-announce', (_n, p) => overrideSaw.push(p));
  await withRuntime({ bus: h.bus, onRequest: h.onRequest }, async (rt) => {
    await rt.load([
      bundledEntry(undefined),
      entry('animations-override.mjs', { bundled: true }),
    ]);
    await rt.waitForNamespace('window-animations');
    await h.bus.emit('layer.resize-announce', {
      surfaceId: 5, namespace: 'panel', fromRect: RECT_A, toRect: RECT_B,
    });
    await waitFor(() => overrideSaw.length === 1);
    assert.equal(h.starts().length, 0,
      'displaced bundled plugin registered no geometry handlers');

    // The other namespaces stay with the bundled plugin: opening still
    // animates (displacement is per-namespace).
    h.bus.emit('window.opening', {
      surfaceId: 7, tiling: 'managed', outerRect: RECT_A, outputRect: OUTPUT,
    });
    await waitFor(() => h.starts().length === 1);
    assert.equal(h.starts()[0].spec.target.kind, 'window-transform');
  });
});
