// End-to-end: bundled workspace plugin loaded into a real PluginRuntime
// against a mock CompositorSink + windows broker + seat stub. Asserts the
// SDK round-trips: actions invoked through runtime.invokeNamespace fire the
// expected setOutputStack pushes, state-bag entries, and workspace.* events.

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

// We need the workspace-default spec but it's not in BUNDLED_PLUGINS yet
// (T6 wires it). Build the spec inline so this test can run independently.
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

// Build a runtime + windows broker + bus harness. Returns helpers + the
// runtime; cleanup is via withRuntime's finally guarantee.
async function withWorkspacePlugin(fn) {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const wm = createWm(sink, { width: 800, height: 600 });
  const seatCalls = { focus: [] };
  const seat = {
    applyKeyboardFocus(id) { seatCalls.focus.push(id); },
    dispatchFocusEvent(reason, trigger) {
      seatCalls.focus.push({ kind: 'dispatch', reason, trigger });
    },
  };
  const state = {
    bus, wm, surfaces: new Map(), compositor: sink, seat,
    pendingWindowChanges: undefined, decorationResize: null,
  };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  // Re-publish window.map/unmap from the core bus to the plugin bus (main.ts
  // does this in production).
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  // Capture workspace.* events for assertions.
  const wsEvents = [];
  pluginBus.subscribe('workspace.*', (name, payload) => {
    wsEvents.push({ name, payload });
  });

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
      })]);
    await rt.waitForNamespace('workspace');
    await fn({
      rt, events, sink, wm, pluginBus, bus, wsEvents, seatCalls,
      addWindow(id) {
        wm.addWindow(id, res(id));
        wm.windowHasContent(id);
        bus.emit(WINDOW_EVENT.map, {
          surfaceId: id, rect: { x: 0, y: 0, width: 1, height: 1 },
          appId: null, title: null,
        });
      },
      unmapWindow(id) {
        bus.emit(WINDOW_EVENT.unmap, { surfaceId: id });
      },
      ws() { return rt.invokeNamespace('workspace', 'list', [0]); },
    });
  });
}

// Resolve the workspace API via runtime.invokeNamespace. The list/current
// methods take an optional outputId; we use OUTPUT_DEFAULT=0 throughout.
function call(rt, method, args) {
  return rt.invokeNamespace('workspace', method, args);
}

// ---- bootstrap -------------------------------------------------------------

test('init: workspace 1 exists immediately; list reports it', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    const snaps = await call(rt, 'list', [0]);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0].index, 1);
    assert.equal(snaps[0].outputId, 0);
    assert.deepEqual(snaps[0].members, []);
  });
});

test('init: workspace.created event fired for workspace 1 on init', async () => {
  await withWorkspacePlugin(async ({ wsEvents }) => {
    const created = wsEvents.filter((e) => e.name === 'workspace.created');
    assert.equal(created.length, 1);
    assert.equal(created[0].payload.index, 1);
  });
});

// ---- workspace API via the namespace ---------------------------------------

test('create: returns snapshot with index=2; subsequent list has both', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    const snap = await call(rt, 'create', [{ name: 'web' }]);
    assert.equal(snap.index, 2);
    assert.equal(snap.name, 'web');
    const list = await call(rt, 'list', [0]);
    assert.equal(list.length, 2);
  });
});

test('mapped window goes to workspace 1 and pushes setOutputStack', async () => {
  await withWorkspacePlugin(async ({ rt, sink, addWindow }) => {
    addWindow(101);
    await new Promise((r) => setTimeout(r, 50));
    const snaps = await call(rt, 'list', [0]);
    assert.deepEqual(snaps[0].members, [101]);
    // setOutputStack pushed with the new member.
    assert.ok(sink.outputStackCalls.some((c) =>
      c.outputId === 0 && JSON.stringify(c.ids) === '[101]'),
      `expected [101] push; got ${JSON.stringify(sink.outputStackCalls)}`);
  });
});

test('show: pushes setOutputStack, emits hidden+shown, dispatches focus event', async () => {
  await withWorkspacePlugin(async ({ rt, sink, wsEvents, seatCalls, addWindow }) => {
    addWindow(101);
    addWindow(102);
    await new Promise((r) => setTimeout(r, 50));
    await call(rt, 'create', [{}]);
    sink.outputStackCalls.length = 0;
    wsEvents.length = 0;
    seatCalls.focus.length = 0;

    await call(rt, 'show', [2, 0]);
    // setOutputStack pushed with empty ids (workspace 2 is empty).
    assert.equal(sink.outputStackCalls.length, 1);
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [] });
    // workspace.hidden(ws=1) + workspace.shown(ws=2).
    assert.ok(wsEvents.some((e) => e.name === 'workspace.hidden'
      && e.payload.index === 1));
    assert.ok(wsEvents.some((e) => e.name === 'workspace.shown'
      && e.payload.index === 2));
    // requestFocusDecision routed to seat.dispatchFocusEvent('workspace-changed').
    assert.ok(seatCalls.focus.some((c) =>
      typeof c === 'object' && c.kind === 'dispatch'
      && c.reason === 'workspace-changed'),
      `expected dispatch workspace-changed; got: ${JSON.stringify(seatCalls.focus)}`);
  });
});

test('moveWindow: pushes setOutputStack on the source when source is shown', async () => {
  await withWorkspacePlugin(async ({ rt, sink, addWindow }) => {
    addWindow(101);
    addWindow(102);
    await new Promise((r) => setTimeout(r, 50));
    await call(rt, 'create', [{}]);
    sink.outputStackCalls.length = 0;

    await call(rt, 'moveWindow', [101, 2, 0]);
    // setOutputStack on the shown (workspace 1) without 101.
    assert.equal(sink.outputStackCalls.length, 1);
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [102] });
  });
});

test('moveWindow: workspace.window-moved event fired with the right payload', async () => {
  await withWorkspacePlugin(async ({ rt, wsEvents, addWindow }) => {
    addWindow(101);
    await new Promise((r) => setTimeout(r, 50));
    await call(rt, 'create', [{}]);
    wsEvents.length = 0;

    await call(rt, 'moveWindow', [101, 2, 0]);
    const moved = wsEvents.find((e) => e.name === 'workspace.window-moved');
    assert.ok(moved);
    assert.equal(moved.payload.surfaceId, 101);
    assert.equal(moved.payload.fromIndex, 1);
    assert.equal(moved.payload.toIndex, 2);
  });
});

test('destroy: renumbers; workspace.destroyed + workspace.renumbered emitted', async () => {
  await withWorkspacePlugin(async ({ rt, wsEvents }) => {
    await call(rt, 'create', [{}]);
    await call(rt, 'create', [{}]);
    wsEvents.length = 0;
    // Destroy middle (index=2). The one formerly at 3 becomes 2.
    await call(rt, 'destroy', [2, 0]);
    const destroyed = wsEvents.filter((e) => e.name === 'workspace.destroyed');
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].payload.formerIndex, 2);
    const renum = wsEvents.find((e) => e.name === 'workspace.renumbered');
    assert.ok(renum);
    assert.equal(renum.payload.changes.length, 1);
    assert.equal(renum.payload.changes[0].oldIndex, 3);
    assert.equal(renum.payload.changes[0].newIndex, 2);
  });
});

test('destroy: only workspace -- recreates fresh; preserves members', async () => {
  await withWorkspacePlugin(async ({ rt, wsEvents, addWindow }) => {
    addWindow(101);
    await new Promise((r) => setTimeout(r, 50));
    wsEvents.length = 0;
    await call(rt, 'destroy', [1, 0]);
    // workspace.destroyed + workspace.created for the fresh replacement.
    assert.ok(wsEvents.some((e) => e.name === 'workspace.destroyed'));
    assert.ok(wsEvents.some((e) => e.name === 'workspace.created'
      && e.payload.index === 1));
    const list = await call(rt, 'list', [0]);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].members, [101]);
  });
});

test('setName: assigns + clears via undefined; workspace.renamed events fire', async () => {
  await withWorkspacePlugin(async ({ rt, wsEvents }) => {
    await call(rt, 'setName', [1, 'web', 0]);
    let snap = await call(rt, 'current', [0]);
    assert.equal(snap.name, 'web');
    await call(rt, 'setName', [1, undefined, 0]);
    snap = await call(rt, 'current', [0]);
    assert.equal(snap.name, undefined);
    const renamed = wsEvents.filter((e) => e.name === 'workspace.renamed');
    assert.equal(renamed.length, 2);
    assert.equal(renamed[0].payload.name, 'web');
    assert.equal(renamed[1].payload.name, undefined);
  });
});

test('unmap: removes from workspace; deleteStateBag emitted; setOutputStack pushed', async () => {
  await withWorkspacePlugin(async ({ rt, sink, addWindow, unmapWindow }) => {
    addWindow(101);
    addWindow(102);
    await new Promise((r) => setTimeout(r, 50));
    sink.outputStackCalls.length = 0;

    unmapWindow(101);
    await new Promise((r) => setTimeout(r, 50));
    const list = await call(rt, 'list', [0]);
    assert.deepEqual(list[0].members, [102]);
    // Stack pushed without 101.
    assert.ok(sink.outputStackCalls.some((c) =>
      c.outputId === 0 && JSON.stringify(c.ids) === '[102]'));
  });
});

// ---- actions surface -------------------------------------------------------

test('actions: workspace.* actions are registered + listable', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    const actions = await rt.listActions();
    const names = actions.map((a) => a.name).sort();
    for (const expected of [
      'workspace.create', 'workspace.destroy', 'workspace.show',
      'workspace.move-window', 'workspace.set-name',
      'workspace.list', 'workspace.current',
    ]) {
      assert.ok(names.includes(expected),
        `missing action '${expected}'; have: ${names.join(', ')}`);
    }
  });
});

test('actions: workspace.show via invokeAction triggers the same effects', async () => {
  await withWorkspacePlugin(async ({ rt, sink }) => {
    await call(rt, 'create', [{}]);
    sink.outputStackCalls.length = 0;
    await rt.invokeAction('workspace.show', { index: 2 });
    assert.equal(sink.outputStackCalls.length, 1);
    assert.equal(sink.outputStackCalls[0].outputId, 0);
  });
});

test('actions: workspace.create returns the snapshot', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    const snap = await rt.invokeAction('workspace.create', { name: 'work' });
    assert.equal(snap.index, 2);
    assert.equal(snap.name, 'work');
  });
});

test('actions: malformed params throw', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    await assert.rejects(() => rt.invokeAction('workspace.show', { index: 'x' }),
      /index must be a positive integer/);
    await assert.rejects(() => rt.invokeAction('workspace.move-window', { index: 1 }),
      /surfaceId must be a number/);
  });
});

// ---- name lookup (Phase 7b) ----------------------------------------------

test('workspace.show by name: resolves a named workspace', async () => {
  await withWorkspacePlugin(async ({ rt, sink }) => {
    await rt.invokeAction('workspace.create', { name: 'mail' });
    sink.outputStackCalls.length = 0;
    await rt.invokeAction('workspace.show', { name: 'mail' });
    assert.equal(sink.outputStackCalls.length, 1);
    assert.equal(sink.outputStackCalls[0].outputId, 0);
  });
});

test('workspace.show by name: unknown name rejects', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    await assert.rejects(
      () => rt.invokeAction('workspace.show', { name: 'nope' }),
      /no workspace named 'nope'/);
  });
});

test('workspace.show: both index and name rejects', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    await assert.rejects(
      () => rt.invokeAction('workspace.show', { index: 1, name: 'foo' }),
      /pass either index or name, not both/);
  });
});

test('workspace.show: neither index nor name rejects', async () => {
  await withWorkspacePlugin(async ({ rt }) => {
    await assert.rejects(
      () => rt.invokeAction('workspace.show', {}),
      /missing required field/);
  });
});

test('workspace.move-window by name: moves to the named workspace', async () => {
  await withWorkspacePlugin(async ({ rt, sink, addWindow }) => {
    addWindow(101);
    await new Promise((r) => setTimeout(r, 50));
    await rt.invokeAction('workspace.create', { name: 'mail' });
    sink.outputStackCalls.length = 0;
    await rt.invokeAction('workspace.move-window', { surfaceId: 101, name: 'mail' });
    // Source (default) lost 101 -> emit setOutputStack([]).
    assert.ok(sink.outputStackCalls.some((c) =>
      c.outputId === 0 && Array.isArray(c.ids) && c.ids.length === 0));
    // Workspace 2 ("mail") now has 101.
    const list = await rt.invokeAction('workspace.list', { outputId: 0 });
    assert.deepEqual(list[1].members, [101]);
  });
});
