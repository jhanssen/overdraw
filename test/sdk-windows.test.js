// End-to-end test for sdk.windows.* across the Worker boundary. Exercises
// propose / setState / getState / deleteState / get / list and the
// resulting bus events. GPU-free.
//
// We construct a real core-side Wm (with a mock compositor sink) and a real
// windows-broker mounted via the runtime's onRequest hook -- the same path
// main.ts uses, minus the Wayland server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../packages/core/dist/events/window-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { createWm } from '../packages/core/dist/wm/index.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../packages/core/dist/plugins/windows-broker.js';
import { entry, waitFor, withRuntime } from './plugin-helpers.mjs';

function mockSink() {
  const sink = {
    outputStackCalls: [],
    fxCalls: [],
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack(outputId, ids) {
      sink.outputStackCalls.push({ outputId, ids: ids === null ? null : [...ids] });
    },
    setSurfaceOpacity(id, opacity) {
      sink.fxCalls.push({ method: 'opacity', id, opacity });
    },
    setSurfaceTransform(id, t) {
      sink.fxCalls.push({ method: 'transform', id, t: { ...t } });
    },
    setSurfaceOutputMargin(id, m) {
      sink.fxCalls.push({ method: 'margin', id, m: { ...m } });
    },
    setSurfaceTint(id, t) {
      sink.fxCalls.push({ method: 'tint', id, t: { ...t } });
    },
    setSurfaceColorMatrix(id, m) {
      sink.fxCalls.push({
        method: 'color-matrix', id,
        m: m === null ? null : [...m],
      });
    },
  };
  return sink;
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// Build a minimal CompositorState shape that the windows broker uses.
// `sink` is the same compositor passed to createWindowsBroker so the
// protocol-layer rebuild (rebuildStackWithPopups) and the broker's direct
// sink call agree on a single backend; the legacy `compositor: null` works
// only as long as the broker never reaches into state.compositor, which it
// now does (set-output-stack triggers a stack rebuild).
function makeCoreState(wm, bus, sink, seat = null) {
  return {
    bus, wm, pendingWindowChanges: undefined, surfaces: new Map(),
    seat, compositor: sink, decorationResize: null,
  };
}

function trigger(bus, op) {
  bus.emit(WINDOW_EVENT.map,
    { surfaceId: op, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
}

function findLog(events, prefix) {
  return events.find((e) => e.n === 'log' && String(e.d).startsWith(prefix));
}

// Build the test scaffold (Wm with two mapped windows, runtime with broker
// hooked in, driver plugin loaded + retargeted) and run `fn` with it. Always
// cleans up the runtime via withRuntime's finally guarantee. `opts.seat`
// optionally attaches a seat stub for routes that need state.seat (e.g.
// windows.request-focus-decision).
async function withWindowsSetup(targetId, fn, opts = {}) {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  wm.addWindow(100, res(100));
  wm.windowHasContent(100);
  wm.addWindow(targetId, res(targetId));
  wm.windowHasContent(targetId);

  const state = makeCoreState(wm, bus, sink, opts.seat ?? null);
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });

  await withRuntime({
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
    onRequest: (plugin, method, params) => {
      if (method.startsWith('windows.')) {
        const r = broker(plugin, method, params);
        if (r === WINDOWS_NOT_HANDLED) throw new Error('not handled');
        return r;
      }
      throw new Error(`no handler for '${method}'`);
    },
  }, async (rt) => {
    await rt.load([entry('windows-driver.mjs', { name: 'driver' })]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    // Tell the driver which window id to target via a synthesized window.change.
    pluginBus.emit(WINDOW_EVENT.change, {
      surfaceId: targetId, changed: ['title'],
      appId: null, title: `TARGET:${targetId}`, activated: false,
    });
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === `target=${targetId}`));

    await fn({ rt, events, pluginBus, wm, sink, seat: opts.seat });
  });
}

test('propose: exclusive=maximized commits to WM state and is reflected in the snapshot', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, wm }) => {
    assert.equal(wm.getWindowState(7).tiling, 'managed');
    assert.equal(wm.getWindowState(7).sizeMode, 'none');
    trigger(pluginBus, 1);
    await waitFor(() => findLog(events, 'propose-maximized'));
    assert.equal(wm.getWindowState(7).sizeMode, 'maximized');

    trigger(pluginBus, 2);
    await waitFor(() => findLog(events, 'propose-managed'));
    assert.equal(wm.getWindowState(7).sizeMode, 'none');
    assert.equal(wm.getWindowState(7).tiling, 'managed');
  });
});

test('propose: exclusive=fullscreen commits to WM state', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, wm }) => {
    trigger(pluginBus, 3);
    await waitFor(() => findLog(events, 'propose-fullscreen'));
    assert.equal(wm.getWindowState(7).sizeMode, 'fullscreen');
  });
});

test('setState: writes to the state bag; getState reads it back', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, wm }) => {
    trigger(pluginBus, 4);
    await waitFor(() => findLog(events, 'set-state'));
    assert.equal(wm.getState(7, 'workspace.id'), 7);

    trigger(pluginBus, 5);
    await waitFor(() => findLog(events, 'get-state='));
    assert.equal(String(findLog(events, 'get-state=').d), 'get-state=7');
  });
});

test('deleteState: removes the value; subsequent getState returns undefined', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, wm }) => {
    trigger(pluginBus, 4);
    await waitFor(() => findLog(events, 'set-state'));

    trigger(pluginBus, 6);
    await waitFor(() => findLog(events, 'delete-state'));
    assert.equal(wm.getState(7, 'workspace.id'), undefined);

    trigger(pluginBus, 5);
    await waitFor(() => findLog(events, 'get-state='));
    // JSON.stringify(undefined) returns undefined (not a string), so the
    // template literal interpolates the string "undefined".
    const getLog = findLog(events, 'get-state=');
    assert.equal(String(getLog.d), 'get-state=undefined');
  });
});

test('get: returns the window snapshot with windowState + state inlined', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, wm }) => {
    await wm.propose(7, { layoutMode: 'floating' }, 'plugin');
    wm.setState(7, 'k', 'v');

    trigger(pluginBus, 7);
    await waitFor(() => findLog(events, 'get='));
    const log = findLog(events, 'get=');
    const snap = JSON.parse(String(log.d).slice(4));
    assert.equal(snap.surfaceId, 7);
    assert.equal(snap.windowState.layoutMode, 'floating');
    assert.equal(snap.windowState.tiling, 'managed');
    assert.equal(snap.windowState.sizeMode, 'none');
    assert.equal(snap.state.k, 'v');
  });
});

test('list: returns all tracked windows', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus }) => {
    trigger(pluginBus, 8);
    await waitFor(() => findLog(events, 'list-count='));
    // 2 windows: id=100 added first, then targetId=7 (which becomes master).
    // The WM keeps master-front; new windows are unshifted -> 7 is first, then 100.
    assert.equal(String(findLog(events, 'list-count=').d), 'list-count=2 first=7');
  });
});

test('state-bag-changed event: setState emits, deleteState emits with deleted=true', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus }) => {
    // Subscribe to window.state-bag-changed on the plugin bus directly so the
    // test observes the emitted event without needing another fixture.
    const stateEvents = [];
    pluginBus.subscribe('window.state-bag-changed', (name, payload) => {
      stateEvents.push({ name, payload });
    });

    trigger(pluginBus, 4);
    await waitFor(() => findLog(events, 'set-state'));
    await waitFor(() => stateEvents.length >= 1);
    assert.equal(stateEvents[0].payload.surfaceId, 7);
    assert.equal(stateEvents[0].payload.key, 'workspace.id');
    assert.equal(stateEvents[0].payload.value, 7);
    assert.equal(stateEvents[0].payload.deleted, false);

    trigger(pluginBus, 6);
    await waitFor(() => findLog(events, 'delete-state'));
    await waitFor(() => stateEvents.length >= 2);
    assert.equal(stateEvents[1].payload.key, 'workspace.id');
    assert.equal(stateEvents[1].payload.deleted, true);
  });
});

test('setOutputStack: forwards ids to the compositor sink', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 9);
    await waitFor(() => findLog(events, 'set-output-stack'));
    assert.equal(sink.outputStackCalls.length, 1);
    assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [100, 7] });
  });
});

test('setOutputStack: null clears the override', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 9);
    await waitFor(() => findLog(events, 'set-output-stack'));

    trigger(pluginBus, 10);
    await waitFor(() => findLog(events, 'clear-output-stack'));
    assert.equal(sink.outputStackCalls.length, 2);
    assert.deepEqual(sink.outputStackCalls[1], { outputId: 0, ids: null });
  });
});

// Per-surface render-state setters land through the same broker, exercised
// end-to-end through a Worker plugin (sdk.windows.set{Opacity,Transform,
// OutputMargin}) -> windows-broker -> compositor sink.

test('setOpacity: forwards opacity to the compositor sink', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 11);
    await waitFor(() => findLog(events, 'set-opacity'));
    assert.deepEqual(sink.fxCalls[0], { method: 'opacity', id: 7, opacity: 0.5 });
  });
});

test('setTransform: forwards full transform to the compositor sink', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 12);
    await waitFor(() => findLog(events, 'set-transform'));
    assert.deepEqual(sink.fxCalls[0],
      { method: 'transform', id: 7,
        t: { translateX: 10, translateY: 20, scaleX: 2, scaleY: 2 } });
  });
});

test('setOutputMargin: forwards margin to the compositor sink', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 13);
    await waitFor(() => findLog(events, 'set-output-margin'));
    assert.deepEqual(sink.fxCalls[0],
      { method: 'margin', id: 7, m: { top: 4, right: 8, bottom: 12, left: 16 } });
  });
});

test('setTint: forwards tint to the compositor sink', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 14);
    await waitFor(() => findLog(events, 'set-tint'));
    assert.deepEqual(sink.fxCalls[0],
      { method: 'tint', id: 7, t: { r: 0.5, g: 0.6, b: 0.7, a: 1 } });
  });
});

test('setColorMatrix: forwards 16-number array to the compositor sink', async () => {
  await withWindowsSetup(7, async ({ events, pluginBus, sink }) => {
    trigger(pluginBus, 15);
    await waitFor(() => findLog(events, 'set-color-matrix'));
    assert.deepEqual(sink.fxCalls[0], {
      method: 'color-matrix', id: 7,
      m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    });
  });
});

test('requestFocusDecision: forwards reason to seat.dispatchFocusEvent', async () => {
  const dispatchCalls = [];
  const seat = {
    applyKeyboardFocus() {},
    dispatchFocusEvent(reason, trigger) { dispatchCalls.push({ reason, trigger }); },
    repickPointer() {},
  };
  await withWindowsSetup(7, async ({ events, pluginBus }) => {
    trigger(pluginBus, 16);
    await waitFor(() => findLog(events, 'request-focus-decision'));
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].reason, 'workspace-changed');
    assert.equal(dispatchCalls[0].trigger, undefined);
  }, { seat });
});
