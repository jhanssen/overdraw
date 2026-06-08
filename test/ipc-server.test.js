// Integration test for the IPC server: spins up an actual JSON-RPC 2.0
// server on a temp Unix socket, connects a real client, and verifies every
// supported method end to end. Uses the same actions-server fixture as the
// other action tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

import { DynamicBus } from '../dist/events/dynamic-bus.js';
import { PluginRuntime } from '../dist/plugins/index.js';
import { IpcServer } from '../dist/ipc/server.js';
import { encode, parseMessage } from '../dist/ipc/protocol.js';

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

// Build a runtime + IPC server on a temp socket; return a teardown helper.
async function setup({ withActionsServer = true } = {}) {
  const events = [];
  const pluginBus = new DynamicBus();
  const rt = new PluginRuntime({
    ...FAST, log: () => {},
    bus: pluginBus,
    onEvent: (p, n, d) => events.push({ p, n, d }),
  });
  if (withActionsServer) {
    await rt.load([entry('actions-server.mjs', { name: 'server' })]);
    await waitFor(() => events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
    await new Promise((r) => setTimeout(r, 50));
  }

  const dir = mkdtempSync(join(tmpdir(), 'overdraw-ipc-test-'));
  const socketPath = join(dir, 'overdraw.sock');
  const server = new IpcServer({ socketPath, runtime: rt, bus: pluginBus, log: () => {} });
  await server.start();
  return {
    rt, server, socketPath, pluginBus, events,
    async teardown() {
      await server.stop();
      await rt.stop();
    },
  };
}

// Open a real Unix socket connection to the test server and return a helpers
// object with sendRequest (single-shot) and a generic on-message handler.
async function connect(socketPath) {
  const sock = createConnection({ path: socketPath });
  sock.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  let buf = '';
  const responses = [];
  const notifications = [];
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = parseMessage(line);
      if (msg.method === 'event') notifications.push(msg);
      else responses.push(msg);
    }
  });
  return {
    sock, responses, notifications,
    send(req) { sock.write(encode(req)); },
    sendRaw(line) { sock.write(line + '\n'); },
    async waitForResponse(id) {
      await waitFor(() => responses.some((r) => r.id === id));
      return responses.find((r) => r.id === id);
    },
    close() {
      return new Promise((resolve) => {
        sock.once('close', resolve);
        sock.end();
      });
    },
  };
}

// --- core happy paths ------------------------------------------------------

test('invoke: returns the action result on success', async () => {
  const env = await setup();
  const client = await connect(env.socketPath);
  client.send({
    jsonrpc: '2.0', id: 1, method: 'invoke',
    params: { action: 'math.add', args: { a: 2, b: 3 } },
  });
  const r = await client.waitForResponse(1);
  assert.equal(r.result, 5);
  await client.close();
  await env.teardown();
});

test('invoke: handler throw becomes ACTION_FAILED error', async () => {
  const env = await setup();
  const client = await connect(env.socketPath);
  client.send({
    jsonrpc: '2.0', id: 1, method: 'invoke',
    params: { action: 'throws' },
  });
  const r = await client.waitForResponse(1);
  assert.equal(r.error.code, -32000);   // ACTION_FAILED
  assert.match(r.error.message, /intentional/);
  await client.close();
  await env.teardown();
});

test('invoke: unknown action -> ACTION_FAILED with "no such action"', async () => {
  const env = await setup();
  const client = await connect(env.socketPath);
  client.send({
    jsonrpc: '2.0', id: 1, method: 'invoke',
    params: { action: 'nonexistent' },
  });
  const r = await client.waitForResponse(1);
  assert.equal(r.error.code, -32000);
  assert.match(r.error.message, /no such action/);
  await client.close();
  await env.teardown();
});

test('list-actions: returns every registered action alphabetically', async () => {
  const env = await setup();
  const client = await connect(env.socketPath);
  client.send({ jsonrpc: '2.0', id: 1, method: 'list-actions' });
  const r = await client.waitForResponse(1);
  const names = r.result.map((a) => a.name);
  assert.deepEqual(names, ['async.action', 'math.add', 'math.mul', 'throws']);
  // Descriptions / schemas: math.add has both; others have neither.
  const add = r.result.find((a) => a.name === 'math.add');
  assert.equal(add.description, 'Add two numbers');
  assert.ok(add.schema);
  await client.close();
  await env.teardown();
});

// --- subscriptions --------------------------------------------------------

test('subscribe: receives matching events as notifications; unsubscribe stops the flow', async () => {
  const env = await setup();
  const client = await connect(env.socketPath);

  client.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { pattern: 'foo.*' } });
  const r = await client.waitForResponse(1);
  const subId = r.result.subscription;
  assert.ok(subId);

  // Emit some events on the plugin bus.
  env.pluginBus.emit('foo.bar', { hello: 1 });
  env.pluginBus.emit('foo.baz', { hello: 2 });
  env.pluginBus.emit('unrelated', { hello: 3 });
  await waitFor(() => client.notifications.length >= 2);
  // Should have exactly 2 (foo.bar, foo.baz); unrelated does NOT match.
  assert.equal(client.notifications.length, 2);
  assert.equal(client.notifications[0].params.name, 'foo.bar');
  assert.equal(client.notifications[0].params.subscription, subId);
  assert.deepEqual(client.notifications[0].params.payload, { hello: 1 });
  assert.equal(client.notifications[1].params.name, 'foo.baz');

  // Unsubscribe and confirm no more events arrive.
  client.send({ jsonrpc: '2.0', id: 2, method: 'unsubscribe', params: { subscription: subId } });
  await client.waitForResponse(2);
  const beforeCount = client.notifications.length;
  env.pluginBus.emit('foo.bar', { hello: 4 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(client.notifications.length, beforeCount);

  await client.close();
  await env.teardown();
});

test('subscribe: client disconnect releases the subscription', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { pattern: '*' } });
  await client.waitForResponse(1);
  assert.equal(env.pluginBus.subscriberCount('anything'), 1);
  await client.close();
  // Give the server's close handler a tick to fire.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(env.pluginBus.subscriberCount('anything'), 0);
  await env.teardown();
});

test('unsubscribe: unknown subscription -> SUBSCRIPTION_UNKNOWN error', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.send({
    jsonrpc: '2.0', id: 1, method: 'unsubscribe',
    params: { subscription: 'bogus' },
  });
  const r = await client.waitForResponse(1);
  assert.equal(r.error.code, -32001);   // SUBSCRIPTION_UNKNOWN
  await client.close();
  await env.teardown();
});

// --- protocol-level error paths -------------------------------------------

test('parse error: malformed JSON -> PARSE_ERROR response with id null', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.sendRaw('not json at all');
  await waitFor(() => client.responses.some((r) => r.error?.code === -32700));
  const r = client.responses.find((r) => r.error?.code === -32700);
  assert.equal(r.id, null);
  await client.close();
  await env.teardown();
});

test('invalid request: missing method -> INVALID_REQUEST with id null', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
  await waitFor(() => client.responses.some((r) => r.error?.code === -32600));
  const r = client.responses.find((r) => r.error?.code === -32600);
  assert.equal(r.id, null);    // server can't trust the id of a malformed request
  await client.close();
  await env.teardown();
});

test('method not found: unknown method -> METHOD_NOT_FOUND', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.send({ jsonrpc: '2.0', id: 1, method: 'no-such-method' });
  const r = await client.waitForResponse(1);
  assert.equal(r.error.code, -32601);
  await client.close();
  await env.teardown();
});

test('invalid params: invoke without action -> INVALID_PARAMS', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.send({ jsonrpc: '2.0', id: 1, method: 'invoke', params: { args: { x: 1 } } });
  const r = await client.waitForResponse(1);
  assert.equal(r.error.code, -32602);
  assert.match(r.error.message, /action/);
  await client.close();
  await env.teardown();
});

test('invalid params: subscribe without pattern -> INVALID_PARAMS', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: {} });
  const r = await client.waitForResponse(1);
  assert.equal(r.error.code, -32602);
  await client.close();
  await env.teardown();
});

test('notifications (id-less) get no reply, even for unknown methods', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  client.send({ jsonrpc: '2.0', method: 'no-such-method' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(client.responses.length, 0);
  await client.close();
  await env.teardown();
});

// --- multi-client ---------------------------------------------------------

test('multiple clients: each gets independent subscriptions', async () => {
  const env = await setup({ withActionsServer: false });
  const a = await connect(env.socketPath);
  const b = await connect(env.socketPath);
  a.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { pattern: 'x.*' } });
  await a.waitForResponse(1);
  // b doesn't subscribe; only a should receive.
  env.pluginBus.emit('x.event', { from: 'a' });
  await waitFor(() => a.notifications.length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.notifications.length, 1);
  assert.equal(b.notifications.length, 0);
  await a.close();
  await b.close();
  await env.teardown();
});

test('server stop: closes all connections', async () => {
  const env = await setup({ withActionsServer: false });
  const client = await connect(env.socketPath);
  assert.equal(env.server.connectionCount(), 1);
  // The teardown stops the server, which should drop our client.
  const closed = new Promise((resolve) => client.sock.once('close', resolve));
  await env.teardown();
  await closed;
});
