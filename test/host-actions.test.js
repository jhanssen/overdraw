// Host actions: PluginRuntime.registerHostAction runs the handler on the
// main thread (no plugin Worker) and shares the plugin action registry, so
// host actions are invokable and listable through the same paths plugins
// use -- including end-to-end over the IPC socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';

import { PluginRuntime } from '../packages/core/dist/plugins/runtime.js';
import { encode, parseMessage } from '../packages/core/dist/ipc/protocol.js';
import { entry, waitFor, withIpcServer } from './plugin-helpers.mjs';

test('registerHostAction: invokeAction runs the handler and returns its result', async () => {
  const rt = new PluginRuntime({ log: () => {} });
  try {
    rt.registerHostAction({
      name: 'test.echo',
      description: 'echo params back',
      handler: (params) => ({ got: params }),
    });
    const r = await rt.invokeAction('test.echo', { a: 1 });
    assert.deepEqual(r, { got: { a: 1 } });
  } finally {
    await rt.stop();
  }
});

test('registerHostAction: async handlers and thrown errors propagate', async () => {
  const rt = new PluginRuntime({ log: () => {} });
  try {
    rt.registerHostAction({
      name: 'test.async',
      handler: async () => { return 42; },
    });
    rt.registerHostAction({
      name: 'test.throws',
      handler: () => { throw new Error('host boom'); },
    });
    assert.equal(await rt.invokeAction('test.async', null), 42);
    await assert.rejects(() => rt.invokeAction('test.throws', null), /host boom/);
  } finally {
    await rt.stop();
  }
});

test('registerHostAction: appears in listActions; unregister removes it', async () => {
  const rt = new PluginRuntime({ log: () => {} });
  try {
    const reg = rt.registerHostAction({
      name: 'test.listed',
      description: 'a host action',
      handler: () => null,
    });
    const listed = await rt.listActions();
    const info = listed.find((a) => a.name === 'test.listed');
    assert.ok(info, 'host action listed');
    assert.equal(info.description, 'a host action');

    reg.unregister();
    const after = await rt.listActions();
    assert.ok(!after.some((a) => a.name === 'test.listed'), 'unregistered');
    await assert.rejects(() => rt.invokeAction('test.listed', null), /no such action/);
  } finally {
    await rt.stop();
  }
});

test('registerHostAction: duplicate name throws', async () => {
  const rt = new PluginRuntime({ log: () => {} });
  try {
    rt.registerHostAction({ name: 'test.dup', handler: () => null });
    assert.throws(() => {
      rt.registerHostAction({ name: 'test.dup', handler: () => null });
    }, /already registered/);
  } finally {
    await rt.stop();
  }
});

test('registerHostAction: plugin actions and host actions share the registry', async () => {
  await withIpcServer({}, async (env) => {
    await env.rt.load([entry('actions-server.mjs', { name: 'server' })]);
    await waitFor(() => env.events.some((e) => e.p === 'server' && String(e.d) === 'ready'));
    // The fixture registered math.add; a host action colliding with it throws.
    assert.throws(() => {
      env.rt.registerHostAction({ name: 'math.add', handler: () => null });
    }, /already registered/);
    // Both kinds resolve through the same invoke path.
    env.rt.registerHostAction({ name: 'host.side', handler: () => 'host' });
    assert.equal(await env.rt.invokeAction('host.side', null), 'host');
    assert.equal(await env.rt.invokeAction('math.add', { a: 2, b: 3 }), 5);
  });
});

test('registerHostAction: invokable end-to-end over the IPC socket', async () => {
  await withIpcServer({}, async (env) => {
    env.rt.registerHostAction({
      name: 'query.test-snapshot',
      description: 'test host query',
      handler: (params) => ({ echo: params, from: 'host' }),
    });

    const sock = createConnection({ path: env.socketPath });
    sock.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      sock.once('connect', resolve);
      sock.once('error', reject);
    });
    let buf = '';
    const responses = [];
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line) responses.push(parseMessage(line));
      }
    });
    try {
      sock.write(encode({
        jsonrpc: '2.0', id: 1, method: 'invoke',
        params: { action: 'query.test-snapshot', args: { k: 'v' } },
      }));
      await waitFor(() => responses.some((r) => r.id === 1));
      const r = responses.find((x) => x.id === 1);
      assert.deepEqual(r.result, { echo: { k: 'v' }, from: 'host' });

      sock.write(encode({ jsonrpc: '2.0', id: 2, method: 'list-actions' }));
      await waitFor(() => responses.some((r2) => r2.id === 2));
      const list = responses.find((x) => x.id === 2);
      assert.ok(list.result.some((a) => a.name === 'query.test-snapshot'));
    } finally {
      await new Promise((resolve) => { sock.once('close', resolve); sock.end(); });
    }
  });
});
