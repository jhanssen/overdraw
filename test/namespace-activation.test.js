// Activation semantics of the namespace registry + runtime (GPU-free):
// claims are inert at registration; the highest-priority claim's init runs
// at the load-batch barrier; a losing claim's init NEVER runs; activation
// failure fails the plugin and the next claim takes over; post-load claims
// on an inactive namespace activate immediately.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { entry, waitFor, findLog, withRuntime } from './plugin-helpers.mjs';

// In-thread entries keep these tests fast (no Worker spin-up); the
// activation protocol is transport-shared, and sdk-namespace.test.js covers
// the Worker path.
const inthread = (name, raw) => entry('ns-activation.mjs', { name, raw, bundled: true });

test('activation: only the winning claim\'s init runs; the loser\'s never does', async () => {
  const events = [];
  await withRuntime({ onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([
      inthread('low', { priority: 0 }),
      inthread('high', { priority: 100 }),
    ]);
    assert.ok(findLog(events, 'high', 'activated'), 'winner activated');
    assert.equal(findLog(events, 'low', 'activating'), undefined,
      'loser init must never run');
    assert.equal(rt.registry().active('role')?.pluginName, 'high');
    assert.equal(await rt.invokeNamespace('role', 'who', []), 'high');
  });
});

test('activation: load order within a batch does not matter', async () => {
  const events = [];
  await withRuntime({ onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    // Higher-priority claimant loads FIRST here; in the test above it
    // loads second. Either way it wins and the other never activates.
    await rt.load([
      inthread('high', { priority: 100 }),
      inthread('low', { priority: 0 }),
    ]);
    assert.equal(rt.registry().active('role')?.pluginName, 'high');
    assert.equal(findLog(events, 'low', 'activating'), undefined);
  });
});

test('activation failure: plugin is failed, next claim activates', async () => {
  const events = [];
  const logs = [];
  await withRuntime({
    log: (m) => logs.push(m),
    onEvent: (p, n, d) => events.push({ p, n, d }),
  }, async (rt) => {
    await rt.load([
      inthread('fallback', { priority: 0 }),
      inthread('broken', { priority: 100, throwOnActivate: true }),
    ]);
    assert.equal(rt.states().find((s) => s.name === 'broken')?.state, 'failed');
    assert.ok(logs.some((m) => m.includes("activation of 'role' failed")
      && m.includes('activation boom')), `activation failure logged: ${logs.join('; ')}`);
    assert.equal(rt.registry().active('role')?.pluginName, 'fallback');
    assert.ok(findLog(events, 'fallback', 'activated'));
    assert.equal(await rt.invokeNamespace('role', 'who', []), 'fallback');
  });
});

test('post-load claim on an inactive namespace activates immediately', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([inthread('deferred', { claimOnEvent: true })]);
    assert.equal(rt.registry().active('role'), null, 'no claim yet');

    pluginBus.emit(WINDOW_EVENT.map,
      { surfaceId: 1, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
    await waitFor(() => findLog(events, 'deferred', 'activated'));
    assert.equal(rt.registry().active('role')?.pluginName, 'deferred');
  });
});

test('waitForNamespace resolves at activation, not at claim', async () => {
  const events = [];
  await withRuntime({ onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    let resolved = false;
    const wait = rt.waitForNamespace('role', 4000).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(resolved, false, 'nothing claims the namespace yet');

    await rt.load([inthread('provider', { priority: 0 })]);
    await wait;
    assert.equal(resolved, true);
    assert.ok(findLog(events, 'provider', 'activated'));
  });
});

test('stopping the activated claimant activates the next claim (in-thread)', async () => {
  const events = [];
  await withRuntime({ onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([
      inthread('primary', { priority: 100 }),
      inthread('standby', { priority: 0 }),
    ]);
    assert.equal(rt.registry().active('role')?.pluginName, 'primary');
    assert.equal(findLog(events, 'standby', 'activating'), undefined);

    await rt.stopByName('primary');
    await waitFor(() => rt.registry().active('role')?.pluginName === 'standby');
    assert.ok(findLog(events, 'standby', 'activated'));
    assert.equal(await rt.invokeNamespace('role', 'who', []), 'standby');
  });
});
