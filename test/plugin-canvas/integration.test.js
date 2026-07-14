// End-to-end: the canvas plugin (workspace parity mode) loaded into a real
// PluginRuntime against a mock CompositorSink + windows broker + real WM.
// Asserts the workspace-namespace surface behaves exactly like
// plugin-workspace-default (same verbs, same setOutputStack pushes, same
// workspace.* events) AND that each output's shown workspace is published
// as an explicit layout island (id = the workspace's durable handle,
// rect = null, members = the pushed stack).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../../packages/core/dist/events/window-bus.js';
import { WINDOW_EVENT } from '../../packages/core/dist/events/types.js';
import { createWm } from '../../packages/core/dist/wm/index.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../../packages/core/dist/plugins/windows-broker.js';
import { bundledToResolved } from '../../packages/core/dist/plugins/bundled.js';
import { withRuntime } from '../plugin-helpers.mjs';

const canvasSpec = { name: 'canvas', module: '@overdraw/plugin-canvas' };

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

// Build a runtime + windows broker + bus harness around the canvas plugin.
// The WM runs a capture layout driver so pushed islands are observable via
// the layout snapshots the driver receives.
async function withCanvasPlugin(fn) {
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const layoutSnapshots = [];
  const wm = createWm(sink,
    [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }],
    {
      layoutDriverFactory: (target, snapshot) => ({
        schedule() { layoutSnapshots.push(snapshot()); },
        settled() { return Promise.resolve(); },
      }),
    });
  const seatCalls = { focus: [] };
  const seat = {
    applyKeyboardFocus(id) { seatCalls.focus.push(id); },
    dispatchFocusEvent(reason, trigger) {
      seatCalls.focus.push({ kind: 'dispatch', reason, trigger });
    },
    repickPointer() {},
  };
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink, seat,
    pendingWindowChanges: undefined, decorationResize: null,
  };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  const wsEvents = [];
  pluginBus.subscribe('workspace.*', (name, payload) => {
    wsEvents.push({ name, payload });
  });

  await withRuntime({
    bus: pluginBus,
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error(`unhandled ${method}`);
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    await rt.load([bundledToResolved(canvasSpec, canvasSpec.module,
      {
        output: null, focus: null, hotkeys: undefined, actions: undefined,
        plugins: [], sourcePath: null, canvas: {},
      })]);
    await rt.waitForNamespace('workspace');
    await fn({
      rt, sink, wm, wsEvents, seatCalls, layoutSnapshots,
      islands() { return layoutSnapshots.at(-1)?.islands ?? []; },
      addWindow(id) {
        wm.addWindow(id, res(id));
        wm.windowHasContent(id);
        bus.emit(WINDOW_EVENT.map, {
          surfaceId: id, outputId: 0,
          rect: { x: 0, y: 0, width: 1, height: 1 },
          appId: null, title: null,
        });
      },
      unmapWindow(id) {
        bus.emit(WINDOW_EVENT.unmap, { surfaceId: id });
      },
    });
  });
}

function call(rt, method, args) {
  return rt.invokeNamespace('workspace', method, args);
}

const settle = () => new Promise((r) => setTimeout(r, 50));

// ---- workspace-surface parity ----------------------------------------------

test('canvas: workspace 1 exists at init; list reports it', async () => {
  await withCanvasPlugin(async ({ rt, wsEvents }) => {
    const snaps = await call(rt, 'list', [0]);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].index, 1);
    assert.deepEqual(snaps[0].members, []);
    assert.ok(wsEvents.some((e) => e.name === 'workspace.created'
      && e.payload.index === 1));
  });
});

test('canvas: mapped window joins workspace 1 and pushes setOutputStack', async () => {
  await withCanvasPlugin(async ({ rt, sink, addWindow }) => {
    addWindow(101);
    await settle();
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [101]);
    assert.ok(sink.outputStackCalls.some((c) =>
      c.outputId === 0 && JSON.stringify(c.ids) === '[101]'),
      `expected [101] push; got ${JSON.stringify(sink.outputStackCalls)}`);
  });
});

test('canvas: show pushes the new stack, emits hidden+shown, dispatches focus', async () => {
  await withCanvasPlugin(async ({ rt, sink, wsEvents, seatCalls, addWindow }) => {
    addWindow(101);
    await settle();
    await call(rt, 'create', [{}]);
    sink.outputStackCalls.length = 0;
    wsEvents.length = 0;
    seatCalls.focus.length = 0;

    await call(rt, 'show', [2, 0]);
    assert.deepEqual(sink.outputStackCalls.at(-1), { outputId: 0, ids: [] });
    assert.ok(wsEvents.some((e) => e.name === 'workspace.hidden' && e.payload.index === 1));
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown' && e.payload.index === 2));
    assert.ok(seatCalls.focus.some((f) => f.kind === 'dispatch'));
  });
});

test('canvas: moveWindow relocates membership and restacks', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    addWindow(101);
    addWindow(102);
    await settle();
    await call(rt, 'create', [{}]);
    await call(rt, 'moveWindow', [101, 2, 0]);
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [102]);
    assert.deepEqual(snaps[1].members, [101]);
  });
});

test('canvas: reorder promote reorders the member list', async () => {
  await withCanvasPlugin(async ({ rt, addWindow }) => {
    addWindow(101);
    addWindow(102);   // unshifts to master: order [102, 101]
    await settle();
    const changed = await call(rt, 'reorder', [101, 'promote']);
    assert.equal(changed, true);
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [101, 102]);
  });
});

test('canvas: ensureOutput is idempotent and returns the shown workspace', async () => {
  await withCanvasPlugin(async ({ rt }) => {
    const a = await call(rt, 'ensureOutput', [0]);
    const b = await call(rt, 'ensureOutput', [0]);
    assert.equal(a.handle, b.handle);
    const snaps = await call(rt, 'list', [0]);
    assert.equal(snaps.length, 1);
  });
});

// ---- island publication ------------------------------------------------------

test('canvas: shown workspace is published as an explicit island (id = handle)', async () => {
  await withCanvasPlugin(async ({ rt, islands, addWindow }) => {
    addWindow(101);
    await settle();
    const list = await call(rt, 'list', [0]);
    const shownHandle = list[0].handle;
    const isl = islands();
    assert.equal(isl.length, 1);
    assert.equal(isl[0].id, shownHandle);
    assert.equal(isl[0].outputId, 0);
    assert.equal(isl[0].rect, null);
    assert.deepEqual(isl[0].members, [101]);
  });
});

test('canvas: show swaps the island to the new workspace handle + members', async () => {
  await withCanvasPlugin(async ({ rt, islands, addWindow }) => {
    addWindow(101);
    await settle();
    const created = await call(rt, 'create', [{}]);
    await call(rt, 'show', [2, 0]);
    let isl = islands();
    assert.equal(isl.length, 1);
    assert.equal(isl[0].id, created.handle);
    assert.deepEqual(isl[0].members, []);

    // Move the window over; the island's members track the stack push.
    await call(rt, 'moveWindow', [101, 2, 0]);
    isl = islands();
    assert.equal(isl[0].id, created.handle);
    assert.deepEqual(isl[0].members, [101]);

    // Switch back: island id returns to workspace 1's handle.
    await call(rt, 'show', [1, 0]);
    const list = await call(rt, 'list', [0]);
    isl = islands();
    assert.equal(isl[0].id, list[0].handle);
    assert.deepEqual(isl[0].members, []);
  });
});

test('canvas: island members mirror unmap', async () => {
  await withCanvasPlugin(async ({ islands, addWindow, unmapWindow }) => {
    addWindow(101);
    addWindow(102);
    await settle();
    assert.deepEqual(islands()[0].members, [102, 101]);
    unmapWindow(102);
    await settle();
    assert.deepEqual(islands()[0].members, [101]);
  });
});
