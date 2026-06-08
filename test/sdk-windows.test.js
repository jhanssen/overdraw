// End-to-end test for sdk.windows.* across the Worker boundary. Exercises
// setFloating/setFullscreen/setState/getState/deleteState/get/list and the
// resulting bus events. GPU-free.
//
// We construct a real core-side Wm (with a mock compositor sink) and a real
// windows-broker mounted via the runtime's onRequest hook -- the same path
// main.ts uses, minus the Wayland server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { DynamicBus } from '../dist/events/dynamic-bus.js';
import { createCompositorBus } from '../dist/events/window-bus.js';
import { WINDOW_EVENT } from '../dist/events/types.js';
import { PluginRuntime } from '../dist/plugins/index.js';
import { createWm } from '../dist/wm/index.js';
import { createWindowsBroker, NOT_HANDLED as WINDOWS_NOT_HANDLED }
  from '../dist/plugins/windows-broker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'plugins');
const fixture = (f) => pathToFileURL(join(FIX, f)).href;

const FAST = { pingIntervalMs: 50, maxMissedPongs: 2, shutdownTimeoutMs: 300, heapMb: 32 };

function entry(file, over = {}) {
  return {
    module: fixture(file), name: over.name ?? file.replace(/\.mjs$/, ''),
    restart: over.restart ?? 'never', maxRestarts: over.maxRestarts ?? 3,
    windowSeconds: over.windowSeconds ?? 60,
    bundled: over.bundled ?? false,
    raw: over.raw ?? {},
  };
}

async function waitFor(pred, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    if (pred()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

// Build a minimal CompositorState shape that the windows broker uses
// (markWindowChanged only reads state.bus + pendingWindowChanges; the broker
// reads state.wm via deps).
function makeCoreState(wm, bus) {
  return {
    bus, wm,
    pendingWindowChanges: undefined,
    surfaces: new Map(),
    seat: null,
    compositor: null,   // not used by the broker
    decorationResize: null,
  };
}

function trigger(bus, op) {
  bus.emit(WINDOW_EVENT.map,
    { surfaceId: op, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
}

function findLog(events, prefix) {
  return events.find((e) => e.n === 'log' && String(e.d).startsWith(prefix));
}

// Build the test scaffold: a Wm with two mapped windows + a runtime with the
// windows broker hooked into onRequest. The driver plugin's target is set via
// a window.change event with title='TARGET:<id>'.
async function setupRuntime(targetId) {
  const events = [];
  const pluginBus = new DynamicBus();
  const bus = createCompositorBus();
  const sink = mockSink();
  const wm = createWm(sink, { width: 800, height: 600 });
  wm.addWindow(100, res(100));
  wm.windowHasContent(100);
  wm.addWindow(targetId, res(targetId));
  wm.windowHasContent(targetId);

  const state = makeCoreState(wm, bus);
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });

  const rt = new PluginRuntime({
    ...FAST, log: () => {},
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
  });
  await rt.load([entry('windows-driver.mjs', { name: 'driver' })]);
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // Tell the driver which window id to target via a synthesized window.change.
  pluginBus.emit(WINDOW_EVENT.change, {
    surfaceId: targetId, changed: ['title'],
    appId: null, title: `TARGET:${targetId}`, activated: false,
    floating: false, fullscreen: false, maximized: false, minimized: false,
  });
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === `target=${targetId}`));
  return { rt, events, pluginBus, wm, sink };
}

test('setFloating: toggles WM hint state and the snapshot reflects it', async () => {
  const { rt, events, pluginBus, wm } = await setupRuntime(7);

  assert.equal(wm.getHints(7).floating, false);
  trigger(pluginBus, 1);   // setFloating(7, true)
  await waitFor(() => findLog(events, 'set-floating-true'));
  assert.equal(wm.getHints(7).floating, true);

  trigger(pluginBus, 2);   // setFloating(7, false)
  await waitFor(() => findLog(events, 'set-floating-false'));
  assert.equal(wm.getHints(7).floating, false);

  await rt.stop();
});

test('setFullscreen: toggles WM hint state', async () => {
  const { rt, events, pluginBus, wm } = await setupRuntime(7);
  trigger(pluginBus, 3);
  await waitFor(() => findLog(events, 'set-fullscreen-true'));
  assert.equal(wm.getHints(7).fullscreen, true);
  await rt.stop();
});

test('setState: writes to the state bag; getState reads it back', async () => {
  const { rt, events, pluginBus, wm } = await setupRuntime(7);

  trigger(pluginBus, 4);   // setState(7, 'workspace.id', 7)
  await waitFor(() => findLog(events, 'set-state'));
  assert.equal(wm.getState(7, 'workspace.id'), 7);

  trigger(pluginBus, 5);   // getState(7, 'workspace.id') -> log
  await waitFor(() => findLog(events, 'get-state='));
  assert.equal(String(findLog(events, 'get-state=').d), 'get-state=7');

  await rt.stop();
});

test('deleteState: removes the value; subsequent getState returns undefined', async () => {
  const { rt, events, pluginBus, wm } = await setupRuntime(7);

  trigger(pluginBus, 4);
  await waitFor(() => findLog(events, 'set-state'));

  trigger(pluginBus, 6);   // deleteState
  await waitFor(() => findLog(events, 'delete-state'));
  assert.equal(wm.getState(7, 'workspace.id'), undefined);

  // Re-check via the proxy: getState should return undefined now. Only one
  // op=5 in this test, so wait for the first matching log.
  trigger(pluginBus, 5);
  await waitFor(() => findLog(events, 'get-state='));
  // JSON.stringify(undefined) returns undefined (not a string), so the
  // template literal interpolates the string "undefined".
  const getLog = findLog(events, 'get-state=');
  assert.equal(String(getLog.d), 'get-state=undefined');

  await rt.stop();
});

test('get: returns the window snapshot with hints + state inlined', async () => {
  const { rt, events, pluginBus, wm } = await setupRuntime(7);
  wm.setHint(7, 'floating', true);
  wm.setState(7, 'k', 'v');

  trigger(pluginBus, 7);
  await waitFor(() => findLog(events, 'get='));
  const log = findLog(events, 'get=');
  const snap = JSON.parse(String(log.d).slice(4));
  assert.equal(snap.surfaceId, 7);
  assert.equal(snap.hints.floating, true);
  assert.equal(snap.state.k, 'v');

  await rt.stop();
});

test('list: returns all tracked windows', async () => {
  const { rt, events, pluginBus } = await setupRuntime(7);

  trigger(pluginBus, 8);
  await waitFor(() => findLog(events, 'list-count='));
  // 2 windows: id=100 added first, then targetId=7 (which becomes master).
  // The WM keeps master-front; new windows are unshifted -> 7 is first, then 100.
  assert.equal(String(findLog(events, 'list-count=').d), 'list-count=2 first=7');

  await rt.stop();
});

test('state-changed event: setState emits, deleteState emits with deleted=true', async () => {
  const { rt, events, pluginBus } = await setupRuntime(7);

  // Subscribe to window.state-changed on the plugin bus directly so the test
  // observes the emitted event without needing another fixture.
  const stateEvents = [];
  pluginBus.subscribe('window.state-changed', (name, payload) => {
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

  await rt.stop();
});

test('setOutputStack: forwards ids to the compositor sink', async () => {
  const { rt, events, pluginBus, sink } = await setupRuntime(7);

  trigger(pluginBus, 9);   // setOutputStack(0, [100, 7])
  await waitFor(() => findLog(events, 'set-output-stack'));
  assert.equal(sink.outputStackCalls.length, 1);
  assert.deepEqual(sink.outputStackCalls[0], { outputId: 0, ids: [100, 7] });

  await rt.stop();
});

test('setOutputStack: null clears the override', async () => {
  const { rt, events, pluginBus, sink } = await setupRuntime(7);

  trigger(pluginBus, 9);    // set the override
  await waitFor(() => findLog(events, 'set-output-stack'));

  trigger(pluginBus, 10);   // clear it
  await waitFor(() => findLog(events, 'clear-output-stack'));
  assert.equal(sink.outputStackCalls.length, 2);
  assert.deepEqual(sink.outputStackCalls[1], { outputId: 0, ids: null });

  await rt.stop();
});
