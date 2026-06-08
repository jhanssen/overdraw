// End-to-end test for sdk.registerPlugin / sdk.plugin across the Worker
// boundary. Exercises the cross-process plumbing in namespace.ts (worker) +
// runtime.ts (core's namespace controller). GPU-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';
import { PluginRuntime } from '../packages/core/dist/plugins/index.js';

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

// Emit a fake window.map to drive the client fixture (op encoded in surfaceId).
function trigger(bus, op) {
  bus.emit(WINDOW_EVENT.map,
    { surfaceId: op, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
}

function findLog(events, pluginName, prefix) {
  return events.find((e) => e.p === pluginName && e.n === 'log' && String(e.d).startsWith(prefix));
}

test('sdk.namespace: register + invoke across workers (add/mul work, methods log on server)', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('ns-server.mjs', { name: 'server-a' }),
    entry('ns-client.mjs', { name: 'client' }),
  ]);
  assert.equal(rt.states().find((s) => s.name === 'server-a').state, 'live');
  assert.equal(rt.states().find((s) => s.name === 'client').state, 'live');

  await waitFor(() => events.some((e) => e.p === 'server-a' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));

  // Allow plugin.register from server-a + the client's onMap subscription to
  // reach core.
  await new Promise((r) => setTimeout(r, 50));

  // Drive: obtain proxy, then call add(2,3) and mul(4,5).
  trigger(pluginBus, 1);
  trigger(pluginBus, 2);

  await waitFor(() => findLog(events, 'client', 'add='));
  await waitFor(() => findLog(events, 'client', 'mul='));

  // The client logs the result; the server logs the call. Verify both.
  assert.equal(String(findLog(events, 'client', 'add=').d), 'add=5');
  assert.equal(String(findLog(events, 'client', 'mul=').d), 'mul=20');
  assert.ok(findLog(events, 'server-a', 'add(2,3) on server-a'), 'server-a logged the add invocation');
  assert.ok(findLog(events, 'server-a', 'mul(4,5) on server-a'), 'server-a logged the mul invocation');

  await rt.stop();
});

test('sdk.namespace: throw in method becomes a rejection on the proxy call', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('ns-server.mjs', { name: 'server-a' }),
    entry('ns-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server-a' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  trigger(pluginBus, 3);  // call boom()
  await waitFor(() => findLog(events, 'client', 'boom-error'));
  assert.match(String(findLog(events, 'client', 'boom-error').d), /boom from server-a/);

  await rt.stop();
});

test('sdk.namespace: calling an unknown method rejects (not registered)', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('ns-server.mjs', { name: 'server-a' }),
    entry('ns-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server-a' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  trigger(pluginBus, 4);   // call .nonexistent()
  await waitFor(() => findLog(events, 'client', 'nonexistent-error'));
  assert.match(String(findLog(events, 'client', 'nonexistent-error').d), /not registered/);

  await rt.stop();
});

test('sdk.namespace: stopping the active plugin promotes the next-priority registrant', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });

  // Two identical servers at the default priority (100). server-first
  // registers first; on a tie, registration order wins, so server-first is
  // the active. Stop server-first; server-second should take over.
  await rt.load([
    entry('ns-server.mjs', { name: 'server-first' }),
    entry('ns-server.mjs', { name: 'server-second' }),
    entry('ns-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server-first' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'server-second' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // Call once: server-first should handle.
  trigger(pluginBus, 1);
  await waitFor(() => findLog(events, 'client', 'add='));
  assert.ok(findLog(events, 'server-first', 'add(2,3) on server-first'), 'server-first handled the first call');
  assert.equal(findLog(events, 'server-second', 'add(2,3) on server-second'), undefined);

  // Stop server-first. The runtime should remove its 'calc' claim and
  // promote server-second.
  await rt.stopByName('server-first');
  // Give the active-change notification time to propagate (it's synchronous
  // on the core side, but the next plugin.invoke from the client also needs
  // to traverse the wire).
  await new Promise((r) => setTimeout(r, 50));

  // Snapshot before the next call.
  const secondLogCountBefore = events.filter((e) =>
    e.p === 'server-second' && String(e.d).startsWith('add(')).length;

  // Call again: server-second should now handle.
  trigger(pluginBus, 1);
  await waitFor(() => {
    return events.filter((e) =>
      e.p === 'server-second' && String(e.d).startsWith('add(')).length > secondLogCountBefore;
  });

  assert.ok(findLog(events, 'server-second', 'add(2,3) on server-second'),
    'server-second now handles the call after server-first stopped');

  await rt.stop();
});

test('sdk.namespace: wait-for-active resolves when a registration appears', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });

  // Client loads first (and asks for sdk.plugin('calc') -- which will wait).
  // Then server-a loads, registers; the client's pending request resolves.
  await rt.load([entry('ns-client.mjs', { name: 'client' })]);
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // Trigger ensureCalc but defer the server load.
  trigger(pluginBus, 0);
  // The proxy obtain is pending; give it a moment, then verify NOT resolved.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(findLog(events, 'client', 'got-proxy'), undefined,
    'client should still be waiting for the calc registration');

  // Now load the server.
  await rt.load([entry('ns-server.mjs', { name: 'server-a' })]);
  await waitFor(() => events.some((e) => e.p === 'server-a' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // Allow the wait-for-active to resolve and the client to log got-proxy.
  await waitFor(() => findLog(events, 'client', 'got-proxy'));

  // Subsequent calls should now succeed.
  trigger(pluginBus, 1);
  await waitFor(() => findLog(events, 'client', 'add='));
  assert.equal(String(findLog(events, 'client', 'add=').d), 'add=5');

  await rt.stop();
});
