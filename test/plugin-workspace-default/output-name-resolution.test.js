// Action-layer tests for the workspace plugin's output-name resolution and
// focused-output tracking. The actions take `output: string` (a connector
// name or EDID id); the plugin resolves it against its live-output map.
// The "focused output" default is driven by window.change events with
// `activated: true`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../../packages/core/dist/events/window-bus.js';
import { WINDOW_EVENT } from '../../packages/core/dist/events/types.js';
import { createWm } from '../../packages/core/dist/wm/index.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../../packages/core/dist/plugins/windows-broker.js';
import {
  bundledToResolved, BUNDLED_PLUGINS,
} from '../../packages/core/dist/plugins/bundled.js';
import { withRuntime } from '../plugin-helpers.mjs';

const wsSpec = BUNDLED_PLUGINS.find((p) => p.name === 'workspace-default')
  ?? { name: 'workspace-default', module: '@overdraw/plugin-workspace-default' };

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
function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// Harness with TWO outputs, configurable connector names + EDID ids. Seeds
// the plugin's initialOutputs so both outputs exist from boot.
async function withTwoOutputs(outputsDecl, fn) {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const wmOutputs = outputsDecl.map((o, i) => ({
    id: o.outputId, rect: { x: i * 1920, y: 0, width: 1920, height: 1080 }, scale: 1,
  }));
  const wm = createWm(sink, wmOutputs);
  const seat = {
    applyKeyboardFocus() {},
    dispatchFocusEvent() {},
  };
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink, seat,
    pendingWindowChanges: undefined, decorationResize: null,
  };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));
  bus.on(WINDOW_EVENT.change, (ev) => pluginBus.emit(WINDOW_EVENT.change, ev));

  const wsEvents = [];
  pluginBus.subscribe('workspace.*', (name, payload) => {
    wsEvents.push({ name, payload });
  });

  const initialOutputs = outputsDecl.map((o) => ({
    outputId: o.outputId, name: o.name, edidId: o.edidId,
  }));
  const bootKey = initialOutputs[0]?.edidId || initialOutputs[0]?.name || '';

  await withRuntime({
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    await rt.load([bundledToResolved(wsSpec, wsSpec.module,
      {
        output: null, focus: null, hotkeys: undefined, actions: undefined,
        plugins: [], sourcePath: null,
      },
      { bootOutputDurableKey: bootKey, initialOutputs })]);
    await rt.waitForNamespace('workspace');
    await fn({
      rt, sink, wm, pluginBus, bus, wsEvents,
      addWindow(id, outputId) {
        wm.addWindow(id, res(id));
        wm.windowHasContent(id);
        bus.emit(WINDOW_EVENT.map, {
          surfaceId: id, outputId,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          appId: null, title: null,
        });
      },
      activate(surfaceId) {
        // Drive a window.change with activated: true. The plugin's focus
        // tracking subscribes on the plugin bus.
        pluginBus.emit(WINDOW_EVENT.change, {
          surfaceId, changed: ['activated'], activated: true,
          appId: null, title: null,
        });
      },
    });
  });
}

// ---- output-name resolution -----------------------------------------------

test('workspace.show-at-index resolves output by connector name', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt, sink, wsEvents }) => {
      // Create a workspace on output 1 explicitly via its connector name.
      await rt.invokeAction('workspace.create', { output: 'HDMI-A-1' });
      sink.outputStackCalls.length = 0;
      wsEvents.length = 0;
      // Activate workspace at index 2 on output 1 -- requires resolving
      // 'HDMI-A-1' -> outputId 1.
      await rt.invokeAction('workspace.show-at-index',
        { index: 2, output: 'HDMI-A-1' });
      const shown = wsEvents.find((e) => e.name === 'workspace.shown');
      assert.equal(shown?.payload?.outputId, 1);
    });
});

test('workspace.show-at-index resolves output by EDID id', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: 'MFR-AAAA-1234' },
     { outputId: 1, name: 'HDMI-A-1', edidId: 'MFR-BBBB-5678' }],
    async ({ rt, sink, wsEvents }) => {
      await rt.invokeAction('workspace.create', { output: 'MFR-BBBB-5678' });
      sink.outputStackCalls.length = 0;
      wsEvents.length = 0;
      await rt.invokeAction('workspace.show-at-index',
        { index: 2, output: 'MFR-BBBB-5678' });
      const shown = wsEvents.find((e) => e.name === 'workspace.shown');
      assert.equal(shown?.payload?.outputId, 1);
    });
});

test('actions reject unknown output names with a clear error', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' }],
    async ({ rt }) => {
      await assert.rejects(
        () => rt.invokeAction('workspace.show-at-index',
          { index: 1, output: 'HDMI-DOES-NOT-EXIST' }),
        /no live output matches 'HDMI-DOES-NOT-EXIST'/);
    });
});

// ---- focused-output tracking ----------------------------------------------

test('focused output: actions default to the output of the activated window', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt, addWindow, activate, sink, wsEvents }) => {
      // Map a window on output 1; activate it. The plugin's focus tracker
      // should now report output 1.
      addWindow(101, 1);
      activate(101);
      // Tick the runtime so the window.change emit reaches the plugin.
      await new Promise((r) => setTimeout(r, 30));
      sink.outputStackCalls.length = 0;
      wsEvents.length = 0;
      // workspace.create without `output` should land on output 1.
      const snap = await rt.invokeAction('workspace.create', {});
      assert.equal(snap.outputId, 1,
        `expected workspace created on focused output 1; got ${snap.outputId}`);
    });
});

test('focused output: persists after the activated window unmaps', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt, addWindow, activate, bus }) => {
      addWindow(101, 1);
      activate(101);
      await new Promise((r) => setTimeout(r, 30));
      // Unmap the window. Focused output should still be 1.
      bus.emit(WINDOW_EVENT.unmap, { surfaceId: 101 });
      await new Promise((r) => setTimeout(r, 30));
      const snap = await rt.invokeAction('workspace.create', {});
      assert.equal(snap.outputId, 1);
    });
});

// ---- workspace.list semantic ----------------------------------------------

test('workspace.list with no `output` returns workspaces across every live output', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt }) => {
      const all = await rt.invokeAction('workspace.list', {});
      // Two workspaces total: one boot per output.
      assert.equal(all.length, 2);
      const outputs = new Set(all.map((w) => w.outputId));
      assert.deepEqual([...outputs].sort(), [0, 1]);
    });
});

test('workspace.list with `output` scopes to that output', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt }) => {
      const one = await rt.invokeAction('workspace.list', { output: 'HDMI-A-1' });
      assert.equal(one.length, 1);
      assert.equal(one[0].outputId, 1);
    });
});

// ---- show handle-string resolution across outputs -------------------------

test('workspace.show by handle-string: resolves to the workspace whose durable handle equals the digits', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt, wsEvents }) => {
      // Boot creates handle 1 on output 0 + handle 2 on output 1 (donor
      // replenishment). Create handle 3 on output 1 and show it, so a
      // subsequent show-by-handle-string for "2" produces an observable
      // transition (handle 2 was already shown by boot).
      await rt.invokeAction('workspace.create', { output: 'HDMI-A-1' });
      await rt.invokeAction('workspace.show-at-index',
        { index: 2, output: 'HDMI-A-1' });  // now handle 3 is shown
      wsEvents.length = 0;
      // No user-set name matches "2"; handle-string fallback finds
      // handle 2 (the boot workspace on output 1).
      await rt.invokeAction('workspace.show', { name: '2' });
      const shown = wsEvents.find((e) => e.name === 'workspace.shown');
      assert.equal(shown?.payload?.handle, 2);
      assert.equal(shown?.payload?.outputId, 1);
    });
});

test('workspace.show: name search is per-output when `output` is set', async () => {
  await withTwoOutputs(
    [{ outputId: 0, name: 'DP-1', edidId: '' },
     { outputId: 1, name: 'HDMI-A-1', edidId: '' }],
    async ({ rt }) => {
      await rt.invokeAction('workspace.create', { name: 'mail', output: 'HDMI-A-1' });
      // 'mail' exists only on output 1. Searching output 0 fails.
      await assert.rejects(
        () => rt.invokeAction('workspace.show', { name: 'mail', output: 'DP-1' }),
        /no workspace named 'mail'/);
      // Searching output 1 succeeds.
      await rt.invokeAction('workspace.show', { name: 'mail', output: 'HDMI-A-1' });
    });
});
