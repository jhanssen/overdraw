// End-to-end tests for sdk.events.intercept across the Worker boundary.
// Exercises the cross-process plumbing in events.ts (worker side) +
// runtime.ts (core side). GPU-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { entry, waitFor, withRuntime } from './plugin-helpers.mjs';

test('intercept: modify path updates the payload across the wire', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    const out = await pluginBus.emit('bump', { n: 1 }, { timeoutMs: 1000 });
    assert.deepEqual(out, { n: 2 });
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('BUMP ')));
  });
});

test('intercept: observe-only (undefined return) leaves payload unchanged', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    const out = await pluginBus.emit('observe', { x: 'orig' }, { timeoutMs: 1000 });
    assert.deepEqual(out, { x: 'orig' });
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('OBSERVE ')));
  });
});

test('intercept: defer path: emit awaits async handler', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    const t0 = Date.now();
    const out = await pluginBus.emit('defer', { v: 1 }, { timeoutMs: 1000 });
    const elapsed = Date.now() - t0;
    assert.deepEqual(out, { v: 1, deferred: true });
    assert.ok(elapsed >= 10, `expected at least 10ms wait, got ${elapsed}ms`);
  });
});

test('intercept: priority order is honored across the wire', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    const out = await pluginBus.emit('priority', { order: [] }, { timeoutMs: 1000 });
    // lo (priority 0) runs first, hi (priority 10) runs second.
    assert.deepEqual(out.order, ['lo', 'hi']);
  });
});

test('intercept: observers see the post-modification payload', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  let observed = null;
  pluginBus.subscribe('bump', (_, p) => { observed = p; });

  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    await pluginBus.emit('bump', { n: 5 }, { timeoutMs: 1000 });
    assert.deepEqual(observed, { n: 6 });
  });
});

test('intercept: off() removes the interceptor across the wire', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    // Before unregister: bump modifies.
    let out = await pluginBus.emit('bump', { n: 1 }, { timeoutMs: 1000 });
    assert.deepEqual(out, { n: 2 });

    // Trigger the plugin to unregister sub1.
    pluginBus.emit(WINDOW_EVENT.map,
      { surfaceId: 50, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'UNREG-BUMP'));
    await new Promise((r) => setTimeout(r, 50));

    // After: bump is no longer modified.
    out = await pluginBus.emit('bump', { n: 1 }, { timeoutMs: 1000 });
    assert.deepEqual(out, { n: 1 });
  });
});

test('intercept: Worker exit releases the plugin\'s interceptors', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    // Confirm interceptor is wired: 'bump' modifies.
    let out = await pluginBus.emit('bump', { n: 1 }, { timeoutMs: 1000 });
    assert.deepEqual(out, { n: 2 });

    await rt.stop();

    // After teardown: bus has no interceptors; emit returns the input.
    out = await pluginBus.emit('bump', { n: 1 });
    assert.deepEqual(out, { n: 1 });
  });
});

test('intercept: in-thread bundled plugin path', async () => {
  // Same fixture, loaded as a bundled in-thread plugin. The transport differs
  // (direct call vs postMessage) but the SDK surface and intercept semantics
  // must be identical.
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([{
      ...entry('events-intercept.mjs'),
      bundled: true,
    }]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 20));

    const out = await pluginBus.emit('bump', { n: 41 }, { timeoutMs: 500 });
    assert.deepEqual(out, { n: 42 });

    const pri = await pluginBus.emit('priority', { order: [] }, { timeoutMs: 500 });
    assert.deepEqual(pri.order, ['lo', 'hi']);
  });
});

test('intercept: per-handler timeout: stuck plugin handler is skipped', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  await withRuntime({ bus: pluginBus, onEvent: (p, n, d) => events.push({ p, n, d }) }, async (rt) => {
    await rt.load([entry('events-intercept.mjs')]);
    await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));

    // 'defer' takes 10ms; with a 1ms budget it times out and the chain
    // proceeds with the original payload.
    const out = await pluginBus.emit('defer', { v: 1 }, { timeoutMs: 1 });
    assert.deepEqual(out, { v: 1 });
  });
});
