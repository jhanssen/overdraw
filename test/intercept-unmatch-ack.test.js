// Pure-unit tests for the Worker-transport unmatch handshake: the broker
// parks an unmatched surface's rings until the worker acks that its tick
// loop stopped (intercept.unmatch-ack), releasing early on notify failure
// and via timeout when no ack ever arrives. Releasing before the ack
// would race brackets the worker already wrote to its wire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InterceptBroker } from '../packages/core/dist/intercept/broker.js';
import { TypedBus } from '../packages/core/dist/events/bus.js';
import { WINDOW_EVENT } from '../packages/core/dist/events/types.js';

function fakeTextureUsage() {
  return { RENDER_ATTACHMENT: 0x10, TEXTURE_BINDING: 0x04, COPY_SRC: 0x01, COPY_DST: 0x02 };
}

// The broker only needs surfaceClientTexture (for matched dims) and
// clearInterceptOutput (observable teardown marker) on this path.
function setup(opts = {}) {
  const bus = new TypedBus();
  const cleared = [];
  const messages = [];
  const broker = new InterceptBroker({
    bus,
    compositor: {
      surfaceClientTexture: () => ({ w: 100, h: 100 }),
      clearInterceptOutput: (sid) => cleared.push(sid),
    },
    worker: {
      addon: { pluginReleaseSurfaceBuffer: () => {} },
      dawn: {},
      coreDeviceHandle: 0n,
      textureUsage: fakeTextureUsage(),
      connIdByPlugin: () => 1,
      allocCompose: async () => ({ surfaceBufId: 1 }),
      allocSurface: async () => ({ surfaceBufId: 2 }),
    },
    log: (line) => messages.push(line),
    ...(opts.unmatchAckTimeoutMs !== undefined
      ? { unmatchAckTimeoutMs: opts.unmatchAckTimeoutMs } : {}),
  });
  return { broker, bus, cleared, messages };
}

function mapEvent(surfaceId, appId) {
  return { surfaceId, appId, title: null, rect: { x: 0, y: 0, width: 100, height: 100 } };
}

async function registerAndMatch(broker, bus, opts = {}) {
  const notified = { matched: [], unmatched: [] };
  const id = await broker.registerWorker({
    match: { appId: { source: 'firefox', flags: '' } },
    pluginName: 'test-plugin',
    notifyMatched: async (n) => { notified.matched.push(n.info.surfaceId); },
    notifyUnmatched: opts.notifyUnmatched
      ?? (async (info) => { notified.unmatched.push(info.surfaceId); }),
  });
  bus.emit(WINDOW_EVENT.map, mapEvent(7, 'firefox'));
  assert.deepEqual(broker.activeSurfacesFor(id), [7]);
  return { id, notified };
}

test('worker unmatch: rings stay parked until the ack', async () => {
  const { broker, bus, cleared } = setup();
  const { id, notified } = await registerAndMatch(broker, bus);

  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 7 });
  await Promise.resolve();
  assert.deepEqual(notified.unmatched, [7], 'worker was notified');
  assert.deepEqual(cleared, [], 'rings not released before the ack');

  broker.ackUnmatched(id, 7);
  assert.deepEqual(cleared, [7], 'ack releases the rings');

  // Duplicate ack is a no-op.
  broker.ackUnmatched(id, 7);
  assert.deepEqual(cleared, [7]);
});

test('worker unmatch: timeout releases without an ack', async () => {
  const { broker, bus, cleared, messages } = setup({ unmatchAckTimeoutMs: 20 });
  await registerAndMatch(broker, bus);

  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 7 });
  assert.deepEqual(cleared, []);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(cleared, [7], 'timeout released the rings');
  assert.ok(messages.some((m) => m.includes('no unmatch-ack')),
    'timeout is logged');
});

test('worker unmatch: notify failure releases promptly (no ack will come)', async () => {
  const { broker, bus, cleared } = setup({ unmatchAckTimeoutMs: 5000 });
  await registerAndMatch(broker, bus, {
    notifyUnmatched: async () => { throw new Error('worker gone'); },
  });

  bus.emit(WINDOW_EVENT.unmap, { surfaceId: 7 });
  // The rejection resolves on the microtask queue.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(cleared, [7], 'released without waiting out the timeout');
});

test('ackUnmatched with nothing parked is a no-op', async () => {
  const { broker, cleared } = setup();
  broker.ackUnmatched(99, 1);
  assert.deepEqual(cleared, []);
});
