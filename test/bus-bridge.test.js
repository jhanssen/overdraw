// BusBridge unit tests (no plugin host, no Worker). Covers the events.*
// surface end-to-end against a real DynamicBus and a mock Endpoint:
// subscribe -> bus.emit fires events.dispatch on the endpoint; intercept ->
// bus.emit awaits the endpoint's events.intercept-handle reply.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BusBridge } from '../packages/core/dist/plugins/bus-bridge.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';

// Minimal Endpoint mock: capture emits + answer requests from a queue.
function mockEndpoint() {
  const emits = [];
  const requests = [];
  let nextReply = null;
  return {
    emit(name, data) { emits.push({ name, data }); },
    request(method, params) {
      requests.push({ method, params });
      const reply = nextReply;
      nextReply = null;
      return Promise.resolve(reply);
    },
    setNextReply(r) { nextReply = r; },
    _emits: emits,
    _requests: requests,
  };
}

function setup(opts = {}) {
  // Important: explicit-undefined passes through unchanged so we can exercise
  // the no-bus warnRuntimeMisconfig path. Destructuring defaults coerce
  // undefined back to the default value, which is wrong for that test.
  const bus = 'bus' in opts ? opts.bus : new DynamicBus();
  const ep = mockEndpoint();
  const logs = [];
  const host = {
    pluginName: 'p',
    bus,
    endpoint: ep,
    log: (m) => logs.push(m),
  };
  const bridge = new BusBridge(host);
  return { bridge, bus, ep, logs, host };
}

test('subscribe + bus.emit -> events.dispatch on endpoint', async () => {
  const { bridge, bus, ep } = setup();
  assert.equal(bridge.handle('events.subscribe', { subId: 1, pattern: 'foo' }), true);
  bus.emit('foo', { x: 1 });
  await new Promise((r) => setImmediate(r));  // dispatch is synchronous-ish
  assert.equal(ep._emits.length, 1);
  assert.equal(ep._emits[0].name, 'events.dispatch');
  assert.deepEqual(ep._emits[0].data, { subId: 1, name: 'foo', payload: { x: 1 } });
});

test('unsubscribe stops further dispatches', async () => {
  const { bridge, bus, ep } = setup();
  bridge.handle('events.subscribe', { subId: 7, pattern: 'foo' });
  bus.emit('foo', 1);
  bridge.handle('events.unsubscribe', { subId: 7 });
  bus.emit('foo', 2);
  await new Promise((r) => setImmediate(r));
  assert.equal(ep._emits.length, 1);  // only the first emit reached the endpoint
});

test('emit -> bus.emit (round-trip via a separate subscriber)', () => {
  const { bridge, bus } = setup();
  const seen = [];
  bus.subscribe('plugin-evt', (_, p) => { seen.push(p); });
  bridge.handle('events.emit', { name: 'plugin-evt', payload: { hi: true } });
  assert.deepEqual(seen, [{ hi: true }]);
});

test('intercept: bus emit awaits endpoint.request; modified payload propagates', async () => {
  const { bridge, bus, ep } = setup();
  bridge.handle('events.intercept-register', { interceptId: 1, pattern: 'foo' });
  // The bridge will request "events.intercept-handle" on the endpoint;
  // arrange to return a modified payload.
  ep.setNextReply({ modified: true, payload: { tag: 'modified' } });
  const final = await bus.emit('foo', { tag: 'original' });
  assert.deepEqual(final, { tag: 'modified' });
  // The bridge MUST have called endpoint.request with the right shape.
  assert.equal(ep._requests.length, 1);
  assert.equal(ep._requests[0].method, 'events.intercept-handle');
  assert.equal(ep._requests[0].params.interceptId, 1);
  assert.equal(ep._requests[0].params.name, 'foo');
  assert.deepEqual(ep._requests[0].params.payload, { tag: 'original' });
});

test('intercept unmodified reply leaves payload untouched', async () => {
  const { bridge, bus, ep } = setup();
  bridge.handle('events.intercept-register', { interceptId: 2, pattern: 'evt' });
  ep.setNextReply({ modified: false });
  const final = await bus.emit('evt', { a: 1 });
  assert.deepEqual(final, { a: 1 });
});

test('intercept-unregister stops further endpoint requests', async () => {
  const { bridge, bus, ep } = setup();
  bridge.handle('events.intercept-register', { interceptId: 5, pattern: 'x' });
  ep.setNextReply({ modified: false });
  await bus.emit('x', 1);
  bridge.handle('events.intercept-unregister', { interceptId: 5 });
  await bus.emit('x', 2);
  assert.equal(ep._requests.length, 1);
});

test('release() drops every subscription and interceptor', async () => {
  const { bridge, bus, ep } = setup();
  bridge.handle('events.subscribe', { subId: 1, pattern: 'a' });
  bridge.handle('events.intercept-register', { interceptId: 2, pattern: 'b' });
  bridge.release();
  // Post-release: bus emits don't reach the endpoint.
  ep.setNextReply({ modified: false });
  bus.emit('a', 1);
  await bus.emit('b', 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(ep._emits.length, 0);
  assert.equal(ep._requests.length, 0);
});

test('handle() returns false for non-events.* names', () => {
  const { bridge } = setup();
  assert.equal(bridge.handle('plugin.register', {}), false);
  assert.equal(bridge.handle('actions.invoke', {}), false);
  assert.equal(bridge.handle('log', 'hi'), false);
});

test('malformed payloads are logged + ignored, no throw', () => {
  const { bridge, logs } = setup();
  bridge.handle('events.subscribe', { subId: 'not-a-number', pattern: 'p' });
  bridge.handle('events.unsubscribe', {});
  bridge.handle('events.emit', { payload: 'x' });  // missing name
  bridge.handle('events.intercept-register', { interceptId: 1 });  // missing pattern
  bridge.handle('events.intercept-unregister', {});
  assert.ok(logs.length >= 4, `expected at least 4 log lines; got ${logs.length}: ${logs.join("\n")}`);
});

test('no bus -> warnRuntimeMisconfig path does not throw and does not register', () => {
  // Mute console.error so the warn does not pollute the test output.
  const origErr = console.error;
  console.error = () => {};
  try {
    const { bridge, ep } = setup({ bus: undefined });
    bridge.handle('events.subscribe', { subId: 1, pattern: 'x' });
    bridge.handle('events.emit', { name: 'x', payload: 1 });
    bridge.handle('events.intercept-register', { interceptId: 1, pattern: 'x' });
    assert.equal(ep._emits.length, 0);
    assert.equal(ep._requests.length, 0);
  } finally {
    console.error = origErr;
  }
});

test('endpoint snapshotted via getter: late endpoint nulling stops dispatch', async () => {
  const ep = mockEndpoint();
  const bus = new DynamicBus();
  const state = { pluginName: 'p', bus, endpoint: ep, log: () => {} };
  // Wrap the state object with a getter so endpoint can be flipped to null
  // after subscribing -- mirrors the plugin host's teardown.
  const host = {
    get pluginName() { return state.pluginName; },
    get bus() { return state.bus; },
    get endpoint() { return state.endpoint; },
    log: state.log,
  };
  const bridge = new BusBridge(host);
  bridge.handle('events.subscribe', { subId: 1, pattern: 'foo' });
  // Plugin teardown: clear endpoint.
  state.endpoint = null;
  bus.emit('foo', 1);
  await new Promise((r) => setImmediate(r));
  // No emits reached the endpoint (it's null at dispatch time).
  assert.equal(ep._emits.length, 0);
});
