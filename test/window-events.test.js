// Core -> plugin window-state event channel (the first core->plugin event push).
// GPU-free. Two tiers:
//   1. window-observer.ts in isolation: dispatch routes/validates window.* payloads
//      to onMap/onUnmap handlers and drops malformed ones.
//   2. end-to-end through a REAL Worker: a fixture plugin registers
//      sdk.window.onMap/onUnmap; the runtime broadcasts events; the plugin logs the
//      payload it received (observed via onEvent). Proves the full
//      core -> Endpoint.emit -> Worker handleEvents -> observer -> sdk callback path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { createWindowObserver } from '../dist/plugins/window-observer.js';
import { WINDOW_EVENT } from '../dist/events/types.js';
import { TypedBus } from '../dist/events/bus.js';
import { PluginRuntime } from '../dist/plugins/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, 'fixtures', 'plugins');
const fixture = (f) => pathToFileURL(join(FIX, f)).href;

const FAST = { pingIntervalMs: 50, maxMissedPongs: 2, shutdownTimeoutMs: 300, heapMb: 32 };

function entry(file, over = {}) {
  return {
    module: fixture(file), name: over.name ?? file.replace(/\.mjs$/, ''),
    restart: over.restart ?? 'never', maxRestarts: over.maxRestarts ?? 3,
    windowSeconds: over.windowSeconds ?? 60, raw: {},
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

// --- tier 0: the typed bus in isolation ------------------------------------

test('bus: emit fans out to all subscribers in registration order', () => {
  const bus = new TypedBus();
  const order = [];
  bus.on('e', () => order.push('a'));
  bus.on('e', () => order.push('b'));
  bus.emit('e', null);
  assert.deepEqual(order, ['a', 'b']);
});

test('bus: on() returns an unsubscribe that stops delivery', () => {
  const bus = new TypedBus();
  let n = 0;
  const off = bus.on('e', () => { n++; });
  bus.emit('e', 1);
  off();
  bus.emit('e', 1);
  assert.equal(n, 1);
});

test('bus: a throwing listener is isolated; others still run + emitter survives', () => {
  const errs = [];
  const bus = new TypedBus((msg) => errs.push(msg));
  let reached = false;
  bus.on('e', () => { throw new Error('boom'); });
  bus.on('e', () => { reached = true; });
  bus.emit('e', 1);            // must not throw
  assert.equal(reached, true);
  assert.equal(errs.length, 1);
});

test('bus: emit to an event with no listeners is a no-op', () => {
  const bus = new TypedBus();
  assert.doesNotThrow(() => bus.emit('nobody', 1));
});

test('bus: clear() removes listeners', () => {
  const bus = new TypedBus();
  let n = 0;
  bus.on('e', () => { n++; });
  bus.clear('e');
  bus.emit('e', 1);
  assert.equal(n, 0);
});

// --- tier 1: window-observer dispatch in isolation -------------------------

test('observer dispatch routes window.map to onMap handlers', () => {
  const { observer, dispatch } = createWindowObserver();
  const got = [];
  observer.onMap((ev) => got.push(ev));
  const ev = { surfaceId: 7, rect: { x: 1, y: 2, width: 3, height: 4 }, appId: 'a', title: 't' };
  const consumed = dispatch(WINDOW_EVENT.map, ev);
  assert.equal(consumed, true);
  assert.deepEqual(got, [ev]);
});

test('observer dispatch routes window.unmap to onUnmap handlers', () => {
  const { observer, dispatch } = createWindowObserver();
  const got = [];
  observer.onUnmap((ev) => got.push(ev));
  assert.equal(dispatch(WINDOW_EVENT.unmap, { surfaceId: 9 }), true);
  assert.deepEqual(got, [{ surfaceId: 9 }]);
});

test('observer dispatch supports multiple handlers and null app_id/title', () => {
  const { observer, dispatch } = createWindowObserver();
  const a = [], b = [];
  observer.onMap((ev) => a.push(ev));
  observer.onMap((ev) => b.push(ev));
  const ev = { surfaceId: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, appId: null, title: null };
  dispatch(WINDOW_EVENT.map, ev);
  assert.deepEqual(a, [ev]);
  assert.deepEqual(b, [ev]);
});

test('observer dispatch routes window.change to onChange handlers', () => {
  const { observer, dispatch } = createWindowObserver();
  const got = [];
  observer.onChange((ev) => got.push(ev));
  const ev = { surfaceId: 3, changed: ['title', 'activated'], appId: 'a', title: 'New', activated: true };
  assert.equal(dispatch(WINDOW_EVENT.change, ev), true);
  assert.deepEqual(got, [ev]);
});

test('observer dispatch drops unknown change fields but keeps valid ones', () => {
  const { observer, dispatch } = createWindowObserver();
  const got = [];
  observer.onChange((ev) => got.push(ev));
  dispatch(WINDOW_EVENT.change, { surfaceId: 1, changed: ['title', 'bogus'], appId: null, title: 't', activated: false });
  assert.deepEqual(got[0].changed, ['title']);   // 'bogus' filtered out
});

test('observer dispatch ignores unknown event names', () => {
  const { observer, dispatch } = createWindowObserver();
  let fired = false;
  observer.onMap(() => { fired = true; });
  assert.equal(dispatch('something.else', { surfaceId: 1 }), false);
  assert.equal(fired, false);
});

test('observer dispatch drops malformed payloads (validated, not blindly cast)', () => {
  const { observer, dispatch } = createWindowObserver();
  const got = [];
  observer.onMap((ev) => got.push(ev));
  // returns true (it IS a window.map event name) but the payload is invalid, so
  // no handler is invoked.
  assert.equal(dispatch(WINDOW_EVENT.map, { surfaceId: 'nope' }), true);
  assert.equal(dispatch(WINDOW_EVENT.map, { surfaceId: 1 }), true); // missing rect
  assert.equal(dispatch(WINDOW_EVENT.map, null), true);
  assert.equal(got.length, 0);
});

// --- tier 2: end-to-end through a real Worker ------------------------------

test('core broadcast delivers window.map/unmap to a live plugin', async () => {
  const events = [];
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([entry('window-observer.mjs')]);
  assert.equal(rt.states()[0].state, 'live');

  // The plugin logs "ready" once init runs; wait for it so its handlers are set.
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));

  const mapEv = { surfaceId: 42, rect: { x: 5, y: 6, width: 100, height: 60 }, appId: 'foo', title: 'Foo' };
  const changeEv = { surfaceId: 42, changed: ['title'], appId: 'foo', title: 'Renamed', activated: true };
  rt.broadcast(WINDOW_EVENT.map, mapEv);
  rt.broadcast(WINDOW_EVENT.change, changeEv);
  rt.emit('window-observer', WINDOW_EVENT.unmap, { surfaceId: 42 });

  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('MAP ')));
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('CHANGE ')));
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('UNMAP ')));

  const mapLog = events.find((e) => e.n === 'log' && String(e.d).startsWith('MAP '));
  const changeLog = events.find((e) => e.n === 'log' && String(e.d).startsWith('CHANGE '));
  const unmapLog = events.find((e) => e.n === 'log' && String(e.d).startsWith('UNMAP '));
  assert.deepEqual(JSON.parse(String(mapLog.d).slice(4)), mapEv);
  assert.deepEqual(JSON.parse(String(changeLog.d).slice(7)), changeEv);
  assert.deepEqual(JSON.parse(String(unmapLog.d).slice(6)), { surfaceId: 42 });

  await rt.stop();
});
