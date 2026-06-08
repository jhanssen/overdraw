// End-to-end test for sdk.actions across the Worker boundary. Exercises
// register/invoke/list/handle plumbing through real Workers. GPU-free.

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

function trigger(bus, op) {
  bus.emit(WINDOW_EVENT.map,
    { surfaceId: op, rect: { x: 0, y: 0, width: 1, height: 1 }, appId: null, title: null });
}

function findLog(events, pluginName, prefix) {
  return events.find((e) => e.p === pluginName && e.n === 'log' && String(e.d).startsWith(prefix));
}

test('sdk.actions: register + invoke across workers (sync handler returns result)', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  // Allow actions.register events to reach core.
  await new Promise((r) => setTimeout(r, 50));

  trigger(pluginBus, 1);   // math.add(2,3)
  trigger(pluginBus, 2);   // math.mul(4,5)

  await waitFor(() => findLog(events, 'client', 'add='));
  await waitFor(() => findLog(events, 'client', 'mul='));

  assert.equal(String(findLog(events, 'client', 'add=').d), 'add=5');
  assert.equal(String(findLog(events, 'client', 'mul=').d), 'mul=20');
  assert.ok(findLog(events, 'server', 'math.add(2,3)'), 'server saw the invocation');
  assert.ok(findLog(events, 'server', 'math.mul(4,5)'), 'server saw the invocation');

  await rt.stop();
});

test('sdk.actions: handler throw becomes invoke-promise rejection', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  trigger(pluginBus, 3);
  await waitFor(() => findLog(events, 'client', 'throws-err'));
  assert.match(String(findLog(events, 'client', 'throws-err').d), /intentional/);

  await rt.stop();
});

test('sdk.actions: invoking a non-existent action rejects with "no such action"', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  trigger(pluginBus, 4);
  await waitFor(() => findLog(events, 'client', 'nonexistent-err'));
  assert.match(String(findLog(events, 'client', 'nonexistent-err').d), /no such action/);

  await rt.stop();
});

test('sdk.actions: list returns registered actions in alphabetical order', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  trigger(pluginBus, 5);
  await waitFor(() => findLog(events, 'client', 'list='));
  // alphabetical: async.action, math.add, math.mul, throws
  assert.equal(String(findLog(events, 'client', 'list=').d),
    'list=async.action,math.add,math.mul,throws');

  await rt.stop();
});

test('sdk.actions: async handler awaited; result returned after delay', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  const t0 = Date.now();
  trigger(pluginBus, 6);
  await waitFor(() => findLog(events, 'client', 'async='));
  const elapsed = Date.now() - t0;
  assert.equal(String(findLog(events, 'client', 'async=').d), 'async=done');
  assert.ok(elapsed >= 30, `async handler should have waited the configured delay; got ${elapsed}ms`);

  await rt.stop();
});

test('sdk.actions: stopping the owning plugin unregisters its actions', async () => {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  await rt.load([
    entry('actions-server.mjs', { name: 'server' }),
    entry('actions-client.mjs', { name: 'client' }),
  ]);
  await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
  await waitFor(() => events.some((e) => e.p === 'client' && String(e.d) === 'ready'));
  await new Promise((r) => setTimeout(r, 50));

  // First confirm math.add works.
  trigger(pluginBus, 1);
  await waitFor(() => findLog(events, 'client', 'add='));

  // Stop the server; its actions should be unregistered.
  await rt.stopByName('server');
  await new Promise((r) => setTimeout(r, 50));

  // Invoking math.add again should now fail with "no such action".
  const addCountBefore = events.filter((e) => e.p === 'client' && String(e.d).startsWith('add=')).length;
  const errCountBefore = events.filter((e) =>
    e.p === 'client' && String(e.d).startsWith('unexpected-err')).length;
  trigger(pluginBus, 1);
  // The client's catch swallows the err only on the throws/nonexistent paths
  // (the op=1 path lets the error propagate). Wait for unexpected-err.
  await waitFor(() => {
    return events.filter((e) =>
      e.p === 'client' && String(e.d).startsWith('unexpected-err')).length > errCountBefore;
  });
  const errLog = events.find((e) =>
    e.p === 'client' && String(e.d).startsWith('unexpected-err')
    && events.indexOf(e) > events.findIndex((x) =>
      x.p === 'client' && String(x.d).startsWith('add=') && events.indexOf(x) >= addCountBefore - 1));
  // Just match content, not position:
  const errAfter = events.filter((e) =>
    e.p === 'client' && String(e.d).startsWith('unexpected-err'));
  const lastErr = errAfter[errAfter.length - 1];
  assert.match(String(lastErr.d), /no such action/);
  void errLog;   // exposed for diagnostics

  await rt.stop();
});
