// Core -> plugin window-state event channel. GPU-free. Three tiers:
//   0. the typed bus (TypedBus) in isolation: registration-order fan-out,
//      throwing-listener isolation, clear().
//   1. window-observer.ts in isolation: wired against a fake PluginEvents,
//      routes validated window.* payloads to onMap/onUnmap/onChange handlers
//      and drops malformed ones.
//   2. end-to-end through a REAL Worker: a fixture plugin registers
//      sdk.window.onMap/onUnmap; the dynamic bus emits events; the plugin logs
//      the payload it received (observed via onEvent). Proves the full
//      core bus -> runtime delivery -> Endpoint.emit -> Worker dispatcher ->
//      observer -> sdk callback path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowObserver } from '../packages/core/dist/plugins/window-observer.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { TypedBus } from '../packages/core/dist/events/bus.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { entry, waitFor, withRuntime } from './plugin-helpers.mjs';

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

// --- tier 1: window-observer in isolation (against a fake PluginEvents) ----
//
// The observer subscribes to 'window.*' on the PluginEvents handle the
// bootstrap normally provides. Here we provide a tiny in-process equivalent
// so the observer can be exercised without a Worker.

function fakeEvents() {
  // pattern -> Set<cb>. Only the patterns the observer actually subscribes to
  // are supported (currently 'window.*'); other patterns would also work via
  // the same mechanism.
  const patternSubs = new Map();
  return {
    handle: {
      subscribe(pattern, cb) {
        const set = patternSubs.get(pattern) ?? new Set();
        set.add(cb);
        patternSubs.set(pattern, set);
        return { off: () => { set.delete(cb); } };
      },
      emit() { /* not used in these tests */ },
    },
    // Deliver an event to subscribers whose pattern matches `name`. Supports
    // prefix-glob 'X.*' and exact match — enough for the observer's needs.
    deliver(name, payload) {
      for (const [pattern, subs] of patternSubs.entries()) {
        const match = pattern.endsWith('.*')
          ? name.startsWith(pattern.slice(0, -1))
          : pattern === name;
        if (!match) continue;
        for (const cb of subs) cb(name, payload);
      }
    },
  };
}

test('observer routes window.map to onMap handlers', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  const got = [];
  observer.onMap((ev) => got.push(ev));
  const ev = { surfaceId: 7, outputId: 0, rect: { x: 1, y: 2, width: 3, height: 4 }, appId: 'a', title: 't' };
  fe.deliver(WINDOW_EVENT.map, ev);
  assert.deepEqual(got, [ev]);
});

test('observer routes window.unmap to onUnmap handlers', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  const got = [];
  observer.onUnmap((ev) => got.push(ev));
  fe.deliver(WINDOW_EVENT.unmap, { surfaceId: 9 });
  assert.deepEqual(got, [{ surfaceId: 9 }]);
});

test('observer supports multiple handlers and null app_id/title', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  const a = [], b = [];
  observer.onMap((ev) => a.push(ev));
  observer.onMap((ev) => b.push(ev));
  const ev = { surfaceId: 1, outputId: 0, rect: { x: 0, y: 0, width: 10, height: 10 }, appId: null, title: null };
  fe.deliver(WINDOW_EVENT.map, ev);
  assert.deepEqual(a, [ev]);
  assert.deepEqual(b, [ev]);
});

test('observer routes window.change to onChange handlers', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  const got = [];
  observer.onChange((ev) => got.push(ev));
  const ev = {
    surfaceId: 3, changed: ['title', 'activated'],
    appId: 'a', title: 'New', activated: true,
  };
  fe.deliver(WINDOW_EVENT.change, ev);
  assert.deepEqual(got, [ev]);
});

test('observer drops unknown change fields but keeps valid ones', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  const got = [];
  observer.onChange((ev) => got.push(ev));
  fe.deliver(WINDOW_EVENT.change, {
    surfaceId: 1, changed: ['title', 'bogus'],
    appId: null, title: 't', activated: false,
  });
  assert.deepEqual(got[0].changed, ['title']);   // 'bogus' filtered out
});

test('observer ignores events that are not window.map/unmap/change', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  let fired = false;
  observer.onMap(() => { fired = true; });
  // Subscription is on 'window.*' so window.closing matches the pattern but is
  // not one of the three the observer handles; it must be a no-op.
  fe.deliver('window.closing', { surfaceId: 1 });
  assert.equal(fired, false);
});

test('observer drops malformed payloads (validated, not blindly cast)', () => {
  const fe = fakeEvents();
  const { observer } = createWindowObserver(fe.handle);
  const got = [];
  observer.onMap((ev) => got.push(ev));
  fe.deliver(WINDOW_EVENT.map, { surfaceId: 'nope' });
  fe.deliver(WINDOW_EVENT.map, { surfaceId: 1 }); // missing rect
  fe.deliver(WINDOW_EVENT.map, null);
  assert.equal(got.length, 0);
});

test('observer release() detaches the bus subscription', () => {
  const fe = fakeEvents();
  const { observer, release } = createWindowObserver(fe.handle);
  const got = [];
  observer.onMap((ev) => got.push(ev));
  const ev = { surfaceId: 7, outputId: 0, rect: { x: 1, y: 2, width: 3, height: 4 }, appId: 'a', title: 't' };
  fe.deliver(WINDOW_EVENT.map, ev);
  release();
  fe.deliver(WINDOW_EVENT.map, ev);
  assert.equal(got.length, 1);   // only the pre-release delivery
});

// --- tier 2: end-to-end through a real Worker ------------------------------

test('dynamic bus delivers window.map/change/unmap to a live plugin', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('window-observer.mjs')]);
    assert.equal(rt.states()[0].state, 'live');

    // The plugin logs "ready" once init runs; wait for it so its handlers + bus
    // subscription are established before we start emitting.
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    // Allow the bootstrap's events.subscribe message to traverse the wire.
    await new Promise((r) => setTimeout(r, 50));

    const mapEv = { surfaceId: 42, outputId: 0, rect: { x: 5, y: 6, width: 100, height: 60 }, appId: 'foo', title: 'Foo' };
    const changeEv = {
      surfaceId: 42, changed: ['title'],
      appId: 'foo', title: 'Renamed', activated: true,
    };
    pluginBus.emit(WINDOW_EVENT.map, mapEv);
    pluginBus.emit(WINDOW_EVENT.change, changeEv);
    pluginBus.emit(WINDOW_EVENT.unmap, { surfaceId: 42 });

    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('MAP ')));
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('CHANGE ')));
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('UNMAP ')));

    const mapLog = events.find((e) => e.n === 'log' && String(e.d).startsWith('MAP '));
    const changeLog = events.find((e) => e.n === 'log' && String(e.d).startsWith('CHANGE '));
    const unmapLog = events.find((e) => e.n === 'log' && String(e.d).startsWith('UNMAP '));
    assert.deepEqual(JSON.parse(String(mapLog.d).slice(4)), mapEv);
    assert.deepEqual(JSON.parse(String(changeLog.d).slice(7)), changeEv);
    assert.deepEqual(JSON.parse(String(unmapLog.d).slice(6)), { surfaceId: 42 });
  });
});
