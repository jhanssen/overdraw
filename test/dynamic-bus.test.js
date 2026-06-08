// Tests for the dynamic (pattern-subscribable) event bus.
// GPU-free; pure unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';

// --- exact-name subscription -----------------------------------------------

test('exact: emit fans out to all subscribers in registration order', () => {
  const bus = new DynamicBus();
  const order = [];
  bus.subscribe('e', () => order.push('a'));
  bus.subscribe('e', () => order.push('b'));
  bus.subscribe('e', () => order.push('c'));
  bus.emit('e', null);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('exact: payload reaches subscriber', () => {
  const bus = new DynamicBus();
  let seen = null;
  bus.subscribe('e', (name, payload) => { seen = { name, payload }; });
  bus.emit('e', { x: 1 });
  assert.deepEqual(seen, { name: 'e', payload: { x: 1 } });
});

test('exact: a different event is not delivered', () => {
  const bus = new DynamicBus();
  let count = 0;
  bus.subscribe('e1', () => count++);
  bus.emit('e2', null);
  assert.equal(count, 0);
});

test('exact: off() removes the subscription', () => {
  const bus = new DynamicBus();
  let count = 0;
  const sub = bus.subscribe('e', () => count++);
  bus.emit('e', null);
  assert.equal(count, 1);
  sub.off();
  bus.emit('e', null);
  assert.equal(count, 1);
});

test('exact: idempotent unsubscribe', () => {
  const bus = new DynamicBus();
  const sub = bus.subscribe('e', () => {});
  sub.off();
  sub.off();  // must not throw
  assert.equal(bus.subscriberCount('e'), 0);
});

test('exact: same cb subscribed twice to same name is deduped', () => {
  const bus = new DynamicBus();
  let count = 0;
  const cb = () => count++;
  bus.subscribe('e', cb);
  bus.subscribe('e', cb);  // Set semantics: no second add
  bus.emit('e', null);
  assert.equal(count, 1);
});

// --- prefix-glob subscription ----------------------------------------------

test('prefix: workspace.* matches workspace.shown', () => {
  const bus = new DynamicBus();
  let seen = null;
  bus.subscribe('workspace.*', (name, payload) => { seen = { name, payload }; });
  bus.emit('workspace.shown', { id: 3 });
  assert.deepEqual(seen, { name: 'workspace.shown', payload: { id: 3 } });
});

test('prefix: workspace.* does NOT match workspace (no dot)', () => {
  const bus = new DynamicBus();
  let count = 0;
  bus.subscribe('workspace.*', () => count++);
  bus.emit('workspace', null);
  assert.equal(count, 0);
});

test('prefix: workspace.* does NOT match other.shown', () => {
  const bus = new DynamicBus();
  let count = 0;
  bus.subscribe('workspace.*', () => count++);
  bus.emit('other.shown', null);
  assert.equal(count, 0);
});

test('prefix: matches deeper segments (workspace.* matches workspace.a.b)', () => {
  const bus = new DynamicBus();
  const seen = [];
  bus.subscribe('workspace.*', (name) => seen.push(name));
  bus.emit('workspace.a.b', null);
  assert.deepEqual(seen, ['workspace.a.b']);
});

// --- catch-all subscription ------------------------------------------------

test('catch-all: * matches every event', () => {
  const bus = new DynamicBus();
  const seen = [];
  bus.subscribe('*', (name) => seen.push(name));
  bus.emit('a', null);
  bus.emit('workspace.shown', null);
  bus.emit('output.added', null);
  assert.deepEqual(seen, ['a', 'workspace.shown', 'output.added']);
});

// --- fan-out ordering across subscriber types ------------------------------

test('order: exact subscribers fire before pattern subscribers', () => {
  const bus = new DynamicBus();
  const order = [];
  bus.subscribe('workspace.*', () => order.push('pattern'));
  bus.subscribe('workspace.shown', () => order.push('exact'));
  bus.emit('workspace.shown', null);
  assert.deepEqual(order, ['exact', 'pattern']);
});

test('order: multiple pattern subscribers fire in registration order', () => {
  const bus = new DynamicBus();
  const order = [];
  bus.subscribe('*', () => order.push('catchall1'));
  bus.subscribe('workspace.*', () => order.push('prefix'));
  bus.subscribe('*', () => order.push('catchall2'));
  bus.emit('workspace.shown', null);
  assert.deepEqual(order, ['catchall1', 'prefix', 'catchall2']);
});

// --- error isolation -------------------------------------------------------

test('throwing listener does not break other subscribers', () => {
  const errors = [];
  const bus = new DynamicBus((msg, err) => errors.push({ msg, err }));
  let after = 0;
  bus.subscribe('e', () => { throw new Error('boom'); });
  bus.subscribe('e', () => { after++; });
  bus.emit('e', null);
  assert.equal(after, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /listener for 'e' threw/);
});

test('throwing pattern listener does not break other subscribers', () => {
  const errors = [];
  const bus = new DynamicBus((msg, err) => errors.push({ msg, err }));
  let after = 0;
  bus.subscribe('workspace.*', () => { throw new Error('boom'); });
  bus.subscribe('workspace.*', () => { after++; });
  bus.emit('workspace.shown', null);
  assert.equal(after, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].msg, /pattern 'workspace.\*'/);
});

// --- subscribe/unsubscribe during emit -------------------------------------

test('subscribe during emit does not fire for the current event', () => {
  const bus = new DynamicBus();
  const order = [];
  bus.subscribe('e', () => {
    order.push('a');
    bus.subscribe('e', () => order.push('late'));
  });
  bus.emit('e', null);
  // 'late' subscribed mid-dispatch; it sees the next emit, not this one
  assert.deepEqual(order, ['a']);
  bus.emit('e', null);
  assert.deepEqual(order, ['a', 'a', 'late']);
});

test('unsubscribe during emit does not affect the in-flight fan-out', () => {
  const bus = new DynamicBus();
  const order = [];
  const sub = bus.subscribe('e', () => {
    order.push('a');
    sub.off();
  });
  bus.subscribe('e', () => order.push('b'));
  bus.emit('e', null);
  // Both fire (snapshot semantics); only 'b' fires on the next emit
  assert.deepEqual(order, ['a', 'b']);
  bus.emit('e', null);
  assert.deepEqual(order, ['a', 'b', 'b']);
});

// --- subscriberCount -------------------------------------------------------

test('subscriberCount counts exact and matching pattern subs', () => {
  const bus = new DynamicBus();
  bus.subscribe('e', () => {});
  bus.subscribe('e', () => {});
  bus.subscribe('e.*', () => {});
  bus.subscribe('*', () => {});
  assert.equal(bus.subscriberCount('e'), 3);          // 2 exact + 1 catchall
  assert.equal(bus.subscriberCount('e.foo'), 2);      // 1 prefix + 1 catchall
  assert.equal(bus.subscriberCount('other'), 1);      // 1 catchall
});

// --- clear -----------------------------------------------------------------

test('clear removes everything', () => {
  const bus = new DynamicBus();
  let count = 0;
  bus.subscribe('e', () => count++);
  bus.subscribe('e.*', () => count++);
  bus.subscribe('*', () => count++);
  bus.clear();
  bus.emit('e', null);
  bus.emit('e.foo', null);
  bus.emit('other', null);
  assert.equal(count, 0);
  assert.equal(bus.subscriberCount('e'), 0);
});

// --- argument validation ---------------------------------------------------

test('subscribe rejects empty pattern', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.subscribe('', () => {}), TypeError);
});

test('subscribe rejects non-function cb', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.subscribe('e', null), TypeError);
});

test('subscribe rejects unsupported pattern forms', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.subscribe('a.*.b', () => {}), TypeError);
  assert.throws(() => bus.subscribe('*.shown', () => {}), TypeError);
  assert.throws(() => bus.subscribe('a*', () => {}), TypeError);
});

test('emit rejects empty name', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.emit('', null), TypeError);
});

test('emit rejects name containing *', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.emit('a.*', null), TypeError);
});
