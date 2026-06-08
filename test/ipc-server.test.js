// Integration test for the IPC server: spins up an actual JSON-RPC 2.0
// server on a temp Unix socket, connects a real client, and verifies every
// supported method end to end. Uses the same actions-server fixture as the
// other action tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';

import { encode, parseMessage } from '../packages/core/dist/ipc/protocol.js';
import { entry, waitFor, withIpcServer } from './plugin-helpers.mjs';

// Wrap withIpcServer with the actions-server fixture load (the bulk of these
// tests need it). Tests that don't can pass {actionsServer: false}.
async function withSetup({ actionsServer = true } = {}, fn) {
  await withIpcServer({}, async (env) => {
    if (actionsServer) {
      await env.rt.load([entry('actions-server.mjs', { name: 'server' })]);
      await waitFor(() => env.events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
      await new Promise((r) => setTimeout(r, 50));
    }
    await fn(env);
  });
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

// Helper: open one client, run the body with it, always close it on exit.
async function withClient(socketPath, fn) {
  const client = await connect(socketPath);
  try { return await fn(client); }
  finally { try { await client.close(); } catch { /* ignore */ } }
}

// --- core happy paths ------------------------------------------------------

test('invoke: returns the action result on success', async () => {
  await withSetup({}, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({
        jsonrpc: '2.0', id: 1, method: 'invoke',
        params: { action: 'math.add', args: { a: 2, b: 3 } },
      });
      const r = await client.waitForResponse(1);
      assert.equal(r.result, 5);
    });
  });
});

test('invoke: handler throw becomes ACTION_FAILED error', async () => {
  await withSetup({}, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({
        jsonrpc: '2.0', id: 1, method: 'invoke',
        params: { action: 'throws' },
      });
      const r = await client.waitForResponse(1);
      assert.equal(r.error.code, -32000);
      assert.match(r.error.message, /intentional/);
    });
  });
});

test('invoke: unknown action -> ACTION_FAILED with "no such action"', async () => {
  await withSetup({}, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({
        jsonrpc: '2.0', id: 1, method: 'invoke',
        params: { action: 'nonexistent' },
      });
      const r = await client.waitForResponse(1);
      assert.equal(r.error.code, -32000);
      assert.match(r.error.message, /no such action/);
    });
  });
});

test('list-actions: returns every registered action alphabetically', async () => {
  await withSetup({}, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'list-actions' });
      const r = await client.waitForResponse(1);
      const names = r.result.map((a) => a.name);
      assert.deepEqual(names, ['async.action', 'math.add', 'math.mul', 'throws']);
      const add = r.result.find((a) => a.name === 'math.add');
      assert.equal(add.description, 'Add two numbers');
      assert.ok(add.schema);
    });
  });
});

// --- subscriptions --------------------------------------------------------

test('subscribe: receives matching events as notifications; unsubscribe stops the flow', async () => {
  await withSetup({}, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { pattern: 'foo.*' } });
      const r = await client.waitForResponse(1);
      const subId = r.result.subscription;
      assert.ok(subId);

      env.pluginBus.emit('foo.bar', { hello: 1 });
      env.pluginBus.emit('foo.baz', { hello: 2 });
      env.pluginBus.emit('unrelated', { hello: 3 });
      await waitFor(() => client.notifications.length >= 2);
      assert.equal(client.notifications.length, 2);
      assert.equal(client.notifications[0].params.name, 'foo.bar');
      assert.equal(client.notifications[0].params.subscription, subId);
      assert.deepEqual(client.notifications[0].params.payload, { hello: 1 });
      assert.equal(client.notifications[1].params.name, 'foo.baz');

      client.send({ jsonrpc: '2.0', id: 2, method: 'unsubscribe', params: { subscription: subId } });
      await client.waitForResponse(2);
      const beforeCount = client.notifications.length;
      env.pluginBus.emit('foo.bar', { hello: 4 });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(client.notifications.length, beforeCount);
    });
  });
});

test('subscribe: client disconnect releases the subscription', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { pattern: '*' } });
      await client.waitForResponse(1);
      assert.equal(env.pluginBus.subscriberCount('anything'), 1);
    });
    // After client.close() the server's close handler fires; give it a tick.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.pluginBus.subscriberCount('anything'), 0);
  });
});

test('unsubscribe: unknown subscription -> SUBSCRIPTION_UNKNOWN error', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({
        jsonrpc: '2.0', id: 1, method: 'unsubscribe',
        params: { subscription: 'bogus' },
      });
      const r = await client.waitForResponse(1);
      assert.equal(r.error.code, -32001);
    });
  });
});

// --- protocol-level error paths -------------------------------------------

test('parse error: malformed JSON -> PARSE_ERROR response with id null', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.sendRaw('not json at all');
      await waitFor(() => client.responses.some((r) => r.error?.code === -32700));
      const r = client.responses.find((r) => r.error?.code === -32700);
      assert.equal(r.id, null);
    });
  });
});

test('invalid request: missing method -> INVALID_REQUEST with id null', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.sendRaw(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
      await waitFor(() => client.responses.some((r) => r.error?.code === -32600));
      const r = client.responses.find((r) => r.error?.code === -32600);
      assert.equal(r.id, null);
    });
  });
});

test('method not found: unknown method -> METHOD_NOT_FOUND', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'no-such-method' });
      const r = await client.waitForResponse(1);
      assert.equal(r.error.code, -32601);
    });
  });
});

test('invalid params: invoke without action -> INVALID_PARAMS', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'invoke', params: { args: { x: 1 } } });
      const r = await client.waitForResponse(1);
      assert.equal(r.error.code, -32602);
      assert.match(r.error.message, /action/);
    });
  });
});

test('invalid params: subscribe without pattern -> INVALID_PARAMS', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: {} });
      const r = await client.waitForResponse(1);
      assert.equal(r.error.code, -32602);
    });
  });
});

test('notifications (id-less) get no reply, even for unknown methods', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (client) => {
      client.send({ jsonrpc: '2.0', method: 'no-such-method' });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(client.responses.length, 0);
    });
  });
});

// --- multi-client ---------------------------------------------------------

test('multiple clients: each gets independent subscriptions', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    await withClient(env.socketPath, async (a) => {
      await withClient(env.socketPath, async (b) => {
        a.send({ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { pattern: 'x.*' } });
        await a.waitForResponse(1);
        env.pluginBus.emit('x.event', { from: 'a' });
        await waitFor(() => a.notifications.length >= 1);
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(a.notifications.length, 1);
        assert.equal(b.notifications.length, 0);
      });
    });
  });
});

test('server stop: closes all connections', async () => {
  await withSetup({ actionsServer: false }, async (env) => {
    const client = await connect(env.socketPath);
    assert.equal(env.server.connectionCount(), 1);
    const closed = new Promise((resolve) => client.sock.once('close', resolve));
    // Stop the server explicitly; withIpcServer's finally will be a no-op.
    await env.server.stop();
    await closed;
  });
});
