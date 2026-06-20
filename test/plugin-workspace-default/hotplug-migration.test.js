// M7 step 5 runtime hotplug: workspace plugin's bus subscribers drive
// recomputeOutputs on output.added / output.pre-remove / output.removed.
// End-to-end through the plugin runtime + plugin bus, modeling the
// exact event payloads main.ts / hotplug.ts emit in production.

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

function harness(initialOutputs, bootKey = 'DP-1') {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  // Match the initial outputs in the WM.
  const wmOutputs = initialOutputs.length > 0
    ? initialOutputs.map((o, i) => ({
        id: o.outputId,
        rect: { x: i * 1000, y: 0, width: 1000, height: 600 }, scale: 1,
      }))
    : [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];
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
      raw: {
        fallbackOutputId: -1,
        fallbackOutputName: '__fallback__',
        bootOutputDurableKey: bootKey,
        initialOutputs,
      },
    } };
}

async function withPlugin(ctx, fn) {
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
    await fn(rt);
  });
}

test('hotplug add: output.added triggers recompute creating a workspace on the new output', async () => {
  const ctx = harness([{ outputId: 0, durableKey: 'DP-1' }]);
  await withPlugin(ctx, async (rt) => {
    // Before add: only one workspace on output 0.
    let ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws1.length, 0);

    // Simulate the hotplug add. main.ts / hotplug.ts would emit this.
    ctx.pluginBus.emit('output.added', {
      outputId: 1, name: 'HDMI-1', edidId: 'HDMI-1-edid',
      width: 1920, height: 1080, scale: 1, refreshMhz: 60000,
    });
    // The plugin subscribes synchronously; the recompute runs inline.
    // But applyEffects is async and uses await; wait a tick.
    await new Promise((r) => setTimeout(r, 5));

    ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws1.length, 1, 'output 1 has a fresh workspace from recompute');

    // workspace.created fired for the new workspace.
    const created = ctx.wsEvents.filter(
      (e) => e.name === 'workspace.created' && e.payload.outputId === 1);
    assert.ok(created.length >= 1);
  });
});

test('hotplug remove: workspace evacuates to the surviving output', async () => {
  const ctx = harness([
    { outputId: 0, durableKey: 'DP-1' },
    { outputId: 1, durableKey: 'HDMI-1' },
  ]);
  await withPlugin(ctx, async (rt) => {
    // Output 1 has a replenishment workspace from the boot recompute.
    let ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws1.length, 1);

    // Unplug HDMI-1. main.ts emits pre-remove THEN (via hotplug.ts) removed.
    ctx.pluginBus.emit('output.pre-remove', {
      outputId: 1, name: 'HDMI-1', edidId: 'HDMI-1-edid',
    });
    ctx.pluginBus.emit('output.removed', {
      outputId: 1, name: 'HDMI-1', edidId: 'HDMI-1-edid',
    });
    await new Promise((r) => setTimeout(r, 5));

    // The workspace formerly on output 1 evacuated to output 0.
    ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws1.length, 0, 'no workspaces on the unplugged output');
    const ws0 = await rt.invokeNamespace('workspace', 'list', [0]);
    assert.equal(ws0.length, 2, 'both workspaces now live on output 0');

    // workspace.migrated emitted for the evacuated workspace.
    const migrated = ctx.wsEvents.filter((e) => e.name === 'workspace.migrated');
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].payload.fromOutputId, 1);
    assert.equal(migrated[0].payload.toOutputId, 0);
  });
});

test('hotplug remove+add round trip: workspace returns to its original output', async () => {
  // The harness's initialOutputs durable keys MUST match what subsequent
  // hotplug events report (the plugin prefers edidId when non-empty -- if
  // boot says 'HDMI-1' but hotplug says 'HDMI-1-edid', reclaim fails).
  const ctx = harness([
    { outputId: 0, durableKey: 'DP-1-edid' },
    { outputId: 1, durableKey: 'HDMI-1-edid' },
  ], 'DP-1-edid');
  await withPlugin(ctx, async (rt) => {
    // Find the workspace on HDMI-1 (the replenishment one).
    let ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    const hdmiHandle = ws1[0].handle;

    // Unplug + replug. Bus payloads carry edidId='HDMI-1-edid' which is
    // what the plugin uses as the durable key (preferred over name).
    ctx.pluginBus.emit('output.pre-remove', { outputId: 1, name: 'HDMI-1', edidId: 'HDMI-1-edid' });
    ctx.pluginBus.emit('output.removed', { outputId: 1, name: 'HDMI-1', edidId: 'HDMI-1-edid' });
    await new Promise((r) => setTimeout(r, 5));
    ctx.pluginBus.emit('output.added', {
      outputId: 1, name: 'HDMI-1', edidId: 'HDMI-1-edid',
      width: 1920, height: 1080, scale: 1, refreshMhz: 60000,
    });
    await new Promise((r) => setTimeout(r, 5));

    // The HDMI-1 workspace is back on output 1.
    ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    assert.equal(ws1.length, 1);
    assert.equal(ws1[0].handle, hdmiHandle, 'same workspace handle reclaimed to HDMI-1');
  });
});

test('hotplug remove+add: edidId is the durable key (preferred over name)', async () => {
  // Boot with one output whose durable key is its edidId.
  const ctx = harness([{ outputId: 0, durableKey: 'MFR-0001-12345678' }],
                      'MFR-0001-12345678');
  await withPlugin(ctx, async (rt) => {
    // Add a second monitor.
    ctx.pluginBus.emit('output.added', {
      outputId: 1, name: 'HDMI-1', edidId: 'OTHER-AAAA-87654321',
      width: 1920, height: 1080, scale: 1, refreshMhz: 60000,
    });
    await new Promise((r) => setTimeout(r, 5));
    let ws1 = await rt.invokeNamespace('workspace', 'list', [1]);
    const hdmiHandle = ws1[0].handle;

    // Unplug it.
    ctx.pluginBus.emit('output.pre-remove', { outputId: 1, name: 'HDMI-1', edidId: 'OTHER-AAAA-87654321' });
    ctx.pluginBus.emit('output.removed', { outputId: 1, name: 'HDMI-1', edidId: 'OTHER-AAAA-87654321' });
    await new Promise((r) => setTimeout(r, 5));

    // Replug, but on a DIFFERENT port: same edidId, different name AND
    // different dense outputId. Reclaim should still happen via edidId.
    ctx.pluginBus.emit('output.added', {
      outputId: 42, name: 'DP-3', edidId: 'OTHER-AAAA-87654321',
      width: 1920, height: 1080, scale: 1, refreshMhz: 60000,
    });
    await new Promise((r) => setTimeout(r, 5));

    const ws42 = await rt.invokeNamespace('workspace', 'list', [42]);
    assert.equal(ws42.length, 1);
    assert.equal(ws42[0].handle, hdmiHandle,
      'workspace reclaimed via edidId despite port + name change');
  });
});
