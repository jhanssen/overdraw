// End-to-end test for sdk.actions across the Worker boundary. Exercises
// register/invoke/list/handle plumbing through real Workers. GPU-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { entry, waitFor, findLog, withRuntime } from './plugin-helpers.mjs';

function trigger(bus, op) {
  bus.emit(WINDOW_EVENT.map,
    { surfaceId: op, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
}

// Load the actions-server + actions-client fixtures and wait for both to be ready
// (their plugin.register / actions.register events to reach core).
async function bootstrap(rt, events, pluginBus) {
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));
  void pluginBus;
}

test('sdk.actions: register + invoke across workers (sync handler returns result)', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await bootstrap(rt, events, pluginBus);

    trigger(pluginBus, 1);   // math.add(2,3)
    trigger(pluginBus, 2);   // math.mul(4,5)

    await waitFor(() => findLog(events, 'client', 'add='));
    await waitFor(() => findLog(events, 'client', 'mul='));

    assert.equal(String(findLog(events, 'client', 'add=').d), 'add=5');
    assert.equal(String(findLog(events, 'client', 'mul=').d), 'mul=20');
    assert.ok(findLog(events, 'server', 'math.add(2,3)'), 'server saw the invocation');
    assert.ok(findLog(events, 'server', 'math.mul(4,5)'), 'server saw the invocation');
  });
});

test('sdk.actions: handler throw becomes invoke-promise rejection', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await bootstrap(rt, events, pluginBus);

    trigger(pluginBus, 3);
    await waitFor(() => findLog(events, 'client', 'throws-err'));
    assert.match(String(findLog(events, 'client', 'throws-err').d), /intentional/);
  });
});

test('sdk.actions: invoking a non-existent action rejects with "no such action"', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await bootstrap(rt, events, pluginBus);

    trigger(pluginBus, 4);
    await waitFor(() => findLog(events, 'client', 'nonexistent-err'));
    assert.match(String(findLog(events, 'client', 'nonexistent-err').d), /no such action/);
  });
});

test('sdk.actions: list returns registered actions in alphabetical order', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await bootstrap(rt, events, pluginBus);

    trigger(pluginBus, 5);
    await waitFor(() => findLog(events, 'client', 'list='));
    // alphabetical: async.action, math.add, math.mul, throws
    assert.equal(String(findLog(events, 'client', 'list=').d),
      'list=async.action,math.add,math.mul,throws');
  });
});

test('sdk.actions: async handler awaited; result returned after delay', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await bootstrap(rt, events, pluginBus);

    const t0 = Date.now();
    trigger(pluginBus, 6);
    await waitFor(() => findLog(events, 'client', 'async='));
    const elapsed = Date.now() - t0;
    assert.equal(String(findLog(events, 'client', 'async=').d), 'async=done');
    assert.ok(elapsed >= 30, `async handler should have waited the configured delay; got ${elapsed}ms`);
  });
});

test('sdk.actions: stopping the owning plugin unregisters its actions', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await bootstrap(rt, events, pluginBus);

    // First confirm math.add works.
    trigger(pluginBus, 1);
    await waitFor(() => findLog(events, 'client', 'add='));

    // Stop the server; its actions should be unregistered.
    await rt.stopByName('server');
    await new Promise((r) => setTimeout(r, 50));

    // Invoking math.add again should now fail with "no such action". The
    // client's op=1 path doesn't swallow errors -> propagates to its outer
    // catch as "unexpected-err".
    const errCountBefore = events.filter((e) =>
      e.p === 'client' && String(e.d).startsWith('unexpected-err')).length;
    trigger(pluginBus, 1);
    await waitFor(() => {
      return events.filter((e) =>
        e.p === 'client' && String(e.d).startsWith('unexpected-err')).length > errCountBefore;
    });
    const errAfter = events.filter((e) =>
      e.p === 'client' && String(e.d).startsWith('unexpected-err'));
    assert.match(String(errAfter[errAfter.length - 1].d), /no such action/);
  });
});
