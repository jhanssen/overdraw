// End-to-end test for sdk.events.subscribe/emit across the Worker boundary.
// Exercises the cross-process plumbing in events.ts (worker) + runtime.ts
// (core's bus subscription tracker). GPU-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { DynamicBus } from '../dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../dist/events/types.js';
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

test('sdk.events: plugin subscribe and emit cross the Worker boundary', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  // Track plugin-emitted events arriving on the core bus.
  const pluginEmits = [];
  pluginBus.subscribe('plugin-said-hello', (name, payload) => {
    pluginEmits.push({ name, payload });
  });

  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([entry('events-echo.mjs')]);
  assert.equal(rt.states()[0].state, 'live');

  // Wait for the plugin's "ready" log to confirm init ran.
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));

  // Plugin emitted an event during init; that should be visible on the core
  // bus immediately after init returns.
  await waitFor(() => pluginEmits.length > 0);
  assert.equal(pluginEmits[0].name, 'plugin-said-hello');
  assert.deepEqual(pluginEmits[0].payload, { from: 'events-echo' });

  // Allow the subscribe envelopes to traverse the wire before we emit.
  await new Promise((r) => setTimeout(r, 50));

  // Emit two events: one to the exact-match subscription, one to the
  // prefix-glob subscription.
  pluginBus.emit('foo.exact', { x: 1 });
  pluginBus.emit('bar.added', { id: 7 });
  // And one event that matches NEITHER subscription -- the plugin should not
  // log anything for it.
  pluginBus.emit('unrelated.event', { z: 9 });

  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('EXACT ')));
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('PREFIX ')));

  const exact = events.find((e) => e.n === 'log' && String(e.d).startsWith('EXACT '));
  const prefix = events.find((e) => e.n === 'log' && String(e.d).startsWith('PREFIX '));
  assert.equal(String(exact.d), 'EXACT foo.exact {"x":1}');
  assert.equal(String(prefix.d), 'PREFIX bar.added {"id":7}');

  // Verify unrelated.event did NOT reach the plugin: there must be exactly
  // one EXACT and one PREFIX log line.
  const exactCount = events.filter((e) => e.n === 'log' && String(e.d).startsWith('EXACT ')).length;
  const prefixCount = events.filter((e) => e.n === 'log' && String(e.d).startsWith('PREFIX ')).length;
  assert.equal(exactCount, 1);
  assert.equal(prefixCount, 1);

  await rt.stop();
});

test('sdk.events: plugin can unsubscribe via Subscription.off()', async () => {
  const events = [];
  const pluginBus = new DynamicBus();

  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([entry('events-echo.mjs')]);
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // First emit -- both subscriptions fire.
  pluginBus.emit('foo.exact', { a: 1 });
  pluginBus.emit('bar.x', { b: 1 });
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('EXACT ')));
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d).startsWith('PREFIX ')));

  // Trigger the plugin to unsubscribe the exact-match subscription via a
  // window.map signal (surfaceId 99 is the unsubscribe-foo trigger in the
  // fixture).
  pluginBus.emit(WINDOW_EVENT.map, { surfaceId: 99, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'UNSUB1'));
  await new Promise((r) => setTimeout(r, 50));

  // Subsequent foo.exact emits should NOT reach the plugin; bar.* still does.
  const exactBefore = events.filter((e) => e.n === 'log' && String(e.d).startsWith('EXACT ')).length;
  const prefixBefore = events.filter((e) => e.n === 'log' && String(e.d).startsWith('PREFIX ')).length;
  pluginBus.emit('foo.exact', { a: 2 });
  pluginBus.emit('bar.y', { b: 2 });
  await waitFor(() => {
    return events.filter((e) => e.n === 'log' && String(e.d).startsWith('PREFIX ')).length > prefixBefore;
  });
  await new Promise((r) => setTimeout(r, 50));

  const exactAfter = events.filter((e) => e.n === 'log' && String(e.d).startsWith('EXACT ')).length;
  const prefixAfter = events.filter((e) => e.n === 'log' && String(e.d).startsWith('PREFIX ')).length;
  assert.equal(exactAfter, exactBefore);     // no new EXACT after unsub
  assert.equal(prefixAfter, prefixBefore + 1);

  await rt.stop();
});

test('sdk.events: plugin Worker exit releases all its bus subscriptions', async () => {
  const events = [];
  const pluginBus = new DynamicBus();

  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([entry('events-echo.mjs')]);
  await waitFor(() => events.some((e) => e.n === 'log' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // Before shutdown: subscriber count for the plugin's patterns is 2 (its two
  // subscriptions).
  assert.equal(pluginBus.subscriberCount('foo.exact'), 1);
  assert.equal(pluginBus.subscriberCount('bar.something'), 1);

  await rt.stop();

  // After Worker exit, subscriber counts return to zero.
  assert.equal(pluginBus.subscriberCount('foo.exact'), 0);
  assert.equal(pluginBus.subscriberCount('bar.something'), 0);
});
