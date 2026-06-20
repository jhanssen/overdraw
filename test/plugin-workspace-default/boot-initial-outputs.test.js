// M7 step 5 boot path: workspace plugin seeds liveOutputs from
// config.initialOutputs (a snapshot core passes through at plugin-resolution
// time) and runs an immediate recompute so the ≥1-workspace-per-output
// invariant holds for every output known at boot, including secondaries
// the OutputDescriptor burst enumerated before the plugin runtime spawned.
//
// End-to-end: loads the bundled workspace plugin via a real PluginRuntime
// with synthetic initialOutputs in the config.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../../packages/core/dist/events/window-bus.js';
import { createWm } from '../../packages/core/dist/wm/index.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../../packages/core/dist/plugins/windows-broker.js';
import { withRuntime } from '../plugin-helpers.mjs';

function mockSink() {
  const sink = {
    outputStackCalls: [],
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack(outputId, ids) {
      sink.outputStackCalls.push({ outputId, ids: ids === null ? null : [...ids] });
    },
  };
  return sink;
}

function bootWith(initialOutputs, bootKey = 'DP-1') {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  // Two outputs in the WM, matching the initialOutputs (the WM cares about
  // logical rects; the workspace plugin cares about durable keys).
  const wmOutputs = [
    { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
    { id: 1, rect: { x: 1000, y: 0, width: 1000, height: 600 }, scale: 1 },
  ];
  const wm = createWm(sink, wmOutputs);
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink,
    seat: {
      applyKeyboardFocus() {},
      dispatchFocusEvent() {},
    },
    pendingWindowChanges: undefined, decorationResize: null,
  };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  const wsEvents = [];
  pluginBus.subscribe('workspace.*', (name, payload) => {
    wsEvents.push({ name, payload });
  });
  return { events, pluginBus, bus, sink, wm, state, broker, wsEvents,
    spec: {
      module: '@overdraw/plugin-workspace-default',
      name: 'workspace-default',
      bundled: true,
      restart: 'on-failure', maxRestarts: 3, windowSeconds: 60,
      // The raw config the plugin's init receives. Mirrors what bundled.ts
      // produces via configFrom(runtime).
      raw: {
        fallbackOutputId: -1,
        fallbackOutputName: '__fallback__',
        bootOutputDurableKey: bootKey,
        initialOutputs,
      },
    } };
}

test('boot: initialOutputs with two outputs creates a workspace on each', async () => {
  const ctx = bootWith([
    { outputId: 0, durableKey: 'DP-1' },
    { outputId: 1, durableKey: 'HDMI-1' },
  ]);
  await withRuntime({
    bus: ctx.pluginBus,
    onEvent: (p, n, d) => ctx.events.push({ p, n, d }),
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = ctx.broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    await rt.load([ctx.spec]);
    await rt.waitForNamespace('workspace');
    // Output 0 has the boot workspace; output 1 has a donor-replenishment
    // workspace created by the boot recompute.
    const ws0 = await rt.invokeNamespace('workspace', 'list', [0]);
    const ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws0.length, 1, 'output 0 has its boot workspace');
    assert.equal(ws1.length, 1, 'output 1 has a fresh workspace from recompute');
    // workspace.created emitted for both -- the boot one + the replenishment.
    const created = ctx.wsEvents.filter((e) => e.name === 'workspace.created');
    assert.ok(created.length >= 2, 'workspace.created fired for boot + replenishment');
  });
});

test('boot: replenishment workspace anchors to the secondary output', async () => {
  const ctx = bootWith([
    { outputId: 0, durableKey: 'DP-1' },
    { outputId: 1, durableKey: 'HDMI-1' },
  ]);
  await withRuntime({
    bus: ctx.pluginBus,
    onEvent: () => {},
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = ctx.broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    await rt.load([ctx.spec]);
    await rt.waitForNamespace('workspace');
    const ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    // The replenishment workspace was created with preferredOutputs anchored
    // to HDMI-1, so a future remove+re-add of HDMI-1 still finds it.
    // (We can't read preferredOutputs through the snapshot API, so this
    // test only sanity-checks that the workspace exists at outputId 1 --
    // the registry tests already cover the preferredOutputs invariant.)
    assert.equal(ws1.length, 1);
    assert.equal(ws1[0].outputId, 1);
  });
});

test('boot: empty initialOutputs -> only the boot workspace exists', async () => {
  // Test harness without core context (initialOutputs omitted). The plugin
  // falls back to reg.init's boot workspace on OUTPUT_DEFAULT only.
  const ctx = bootWith([]);
  await withRuntime({
    bus: ctx.pluginBus,
    onEvent: () => {},
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = ctx.broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    await rt.load([ctx.spec]);
    await rt.waitForNamespace('workspace');
    const ws0 = await rt.invokeNamespace('workspace', 'list', [0]);
    const ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws0.length, 1);
    assert.equal(ws1.length, 0, 'no boot recompute; output 1 has no workspace yet');
  });
});
