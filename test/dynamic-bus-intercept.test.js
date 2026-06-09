// Tests for the dynamic bus intercept mechanism.
// GPU-free; pure unit tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';

// --- emit return shape -----------------------------------------------------

test('emit returns a Promise', () => {
  const bus = new DynamicBus();
  const r = bus.emit('e', { x: 1 });
  assert.ok(r && typeof r.then === 'function');
});

test('emit with no interceptors resolves to the input payload', async () => {
  const bus = new DynamicBus();
  const payload = { x: 1 };
  const out = await bus.emit('e', payload);
  assert.equal(out, payload);
});

test('emit with no interceptors fans out to observers synchronously', () => {
  // The fan-out happens before emit() returns, even though emit() itself
  // returns a Promise. Observers see the payload before the next microtask.
  const bus = new DynamicBus();
  let seen = null;
  bus.subscribe('e', (_, p) => { seen = p; });
  bus.emit('e', { x: 1 });
  assert.deepEqual(seen, { x: 1 });
});

// --- modify path -----------------------------------------------------------

test('interceptor returning a new payload replaces it', async () => {
  const bus = new DynamicBus();
  bus.intercept('e', () => ({ x: 2 }));
  const out = await bus.emit('e', { x: 1 });
  assert.deepEqual(out, { x: 2 });
});

test('interceptor returning undefined leaves the payload alone', async () => {
  const bus = new DynamicBus();
  bus.intercept('e', () => { /* observe-only */ });
  const out = await bus.emit('e', { x: 1 });
  assert.deepEqual(out, { x: 1 });
});

test('chained interceptors see prior output as input', async () => {
  const bus = new DynamicBus();
  bus.intercept('e', (_, p) => ({ n: p.n + 1 }), { priority: 0 });
  bus.intercept('e', (_, p) => ({ n: p.n * 10 }), { priority: 1 });
  const out = await bus.emit('e', { n: 0 });
  assert.deepEqual(out, { n: 10 });   // (0 + 1) * 10
});

test('observers see the final post-modification payload', async () => {
  const bus = new DynamicBus();
  bus.intercept('e', () => ({ x: 'modified' }));
  let seen = null;
  bus.subscribe('e', (_, p) => { seen = p; });
  await bus.emit('e', { x: 'original' });
  assert.deepEqual(seen, { x: 'modified' });
});

// --- priority ordering -----------------------------------------------------

test('interceptors run in priority order (lower first)', async () => {
  const bus = new DynamicBus();
  const order = [];
  bus.intercept('e', () => { order.push('high'); }, { priority: 10 });
  bus.intercept('e', () => { order.push('low'); }, { priority: 0 });
  bus.intercept('e', () => { order.push('mid'); }, { priority: 5 });
  await bus.emit('e', null);
  assert.deepEqual(order, ['low', 'mid', 'high']);
});

test('equal-priority interceptors run in registration order', async () => {
  const bus = new DynamicBus();
  const order = [];
  bus.intercept('e', () => { order.push('a'); });
  bus.intercept('e', () => { order.push('b'); });
  bus.intercept('e', () => { order.push('c'); });
  await bus.emit('e', null);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('default priority is 0', async () => {
  const bus = new DynamicBus();
  const order = [];
  bus.intercept('e', () => { order.push('default'); });
  bus.intercept('e', () => { order.push('explicit-1'); }, { priority: 1 });
  await bus.emit('e', null);
  assert.deepEqual(order, ['default', 'explicit-1']);
});

// --- defer path (async handlers) -------------------------------------------

test('async interceptor: emit awaits its Promise', async () => {
  const bus = new DynamicBus();
  let resolved = false;
  bus.intercept('e', async () => {
    await new Promise((r) => setTimeout(r, 10));
    resolved = true;
  });
  await bus.emit('e', null);
  assert.equal(resolved, true);
});

test('async interceptor: returned value is honored', async () => {
  const bus = new DynamicBus();
  bus.intercept('e', async (_, p) => {
    await new Promise((r) => setTimeout(r, 5));
    return { x: p.x + 1 };
  });
  const out = await bus.emit('e', { x: 1 });
  assert.deepEqual(out, { x: 2 });
});

test('observers fire only after all interceptors settle', async () => {
  const bus = new DynamicBus();
  const order = [];
  bus.intercept('e', async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('intercept-done');
  });
  bus.subscribe('e', () => { order.push('observer'); });
  await bus.emit('e', null);
  assert.deepEqual(order, ['intercept-done', 'observer']);
});

// --- pattern matching ------------------------------------------------------

test('intercept matches prefix-glob', async () => {
  const bus = new DynamicBus();
  const seen = [];
  bus.intercept('window.*', (n) => { seen.push(n); });
  await bus.emit('window.map', null);
  await bus.emit('window.unmap', null);
  await bus.emit('output.changed', null);
  assert.deepEqual(seen, ['window.map', 'window.unmap']);
});

test('intercept matches catch-all', async () => {
  const bus = new DynamicBus();
  const seen = [];
  bus.intercept('*', (n) => { seen.push(n); });
  await bus.emit('a', null);
  await bus.emit('b.c', null);
  assert.deepEqual(seen, ['a', 'b.c']);
});

test('intercept rejects unsupported pattern forms', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.intercept('a.*.b', () => {}), TypeError);
  assert.throws(() => bus.intercept('*.shown', () => {}), TypeError);
});

// --- off() unsubscribe -----------------------------------------------------

test('off() removes the interceptor', async () => {
  const bus = new DynamicBus();
  let count = 0;
  const sub = bus.intercept('e', () => { count++; });
  await bus.emit('e', null);
  assert.equal(count, 1);
  sub.off();
  await bus.emit('e', null);
  assert.equal(count, 1);
});

test('off() during dispatch does not disturb the current chain', async () => {
  const bus = new DynamicBus();
  const order = [];
  let subB;
  bus.intercept('e', () => { order.push('a'); subB.off(); });
  subB = bus.intercept('e', () => { order.push('b'); });
  bus.intercept('e', () => { order.push('c'); });
  await bus.emit('e', null);
  // First emit: snapshot taken before a runs, so b still runs.
  assert.deepEqual(order, ['a', 'b', 'c']);
  await bus.emit('e', null);
  // Second emit: b is gone now.
  assert.deepEqual(order, ['a', 'b', 'c', 'a', 'c']);
});

// --- error handling --------------------------------------------------------

test('throwing interceptor is skipped; chain continues with prior payload', async () => {
  const bus = new DynamicBus();
  const warnings = [];
  const bus2 = new DynamicBus((msg) => warnings.push(msg));
  bus2.intercept('e', () => { throw new Error('boom'); });
  bus2.intercept('e', (_, p) => ({ x: p.x + 1 }));
  const out = await bus2.emit('e', { x: 1 });
  assert.deepEqual(out, { x: 2 });
  assert.ok(warnings.some((m) => m.includes('boom') || m.includes('failed')));
  void bus;
});

test('async-rejecting interceptor is skipped; chain continues', async () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.intercept('e', async () => { throw new Error('async-boom'); });
  bus.intercept('e', (_, p) => ({ x: p.x + 1 }));
  const out = await bus.emit('e', { x: 1 });
  assert.deepEqual(out, { x: 2 });
  assert.ok(warnings.some((m) => m.includes('failed')));
});

test('one observer throwing does not stop others', async () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  let count = 0;
  bus.subscribe('e', () => { throw new Error('obs-boom'); });
  bus.subscribe('e', () => { count++; });
  await bus.emit('e', null);
  assert.equal(count, 1);
});

// --- timeout ---------------------------------------------------------------

test('interceptor exceeding per-handler timeout is abandoned; chain continues with prior payload', async () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.intercept('e', () => new Promise((r) => setTimeout(() => r({ x: 'late' }), 100)));
  bus.intercept('e', (_, p) => ({ x: (p?.x ?? 'orig') + '+next' }));
  const out = await bus.emit('e', { x: 'orig' }, { timeoutMs: 20 });
  // First handler timed out -> payload unchanged at that point -> second
  // handler appends to the original.
  assert.deepEqual(out, { x: 'orig+next' });
  assert.ok(warnings.some((m) => m.includes('timed out') || m.includes('failed')));
});

test('per-handler timeout: each handler gets a fresh budget', async () => {
  // Two handlers that each take ~30ms with a 50ms per-handler budget both
  // complete (the budget is not cumulative across handlers).
  const bus = new DynamicBus();
  bus.intercept('e', () => new Promise((r) => setTimeout(() => r({ x: 'first' }), 30)));
  bus.intercept('e', (_, p) => new Promise((r) => setTimeout(() => r({ x: p.x + '+second' }), 30)));
  const out = await bus.emit('e', { x: 'orig' }, { timeoutMs: 50 });
  assert.deepEqual(out, { x: 'first+second' });
});

test('no timeoutMs: a slow interceptor is not skipped', async () => {
  const bus = new DynamicBus();
  bus.intercept('e', () => new Promise((r) => setTimeout(() => r({ x: 'late' }), 30)));
  const out = await bus.emit('e', { x: 'orig' });
  assert.deepEqual(out, { x: 'late' });
});

// --- emitSync --------------------------------------------------------------

test('emitSync fans out to observers synchronously', () => {
  const bus = new DynamicBus();
  let seen = null;
  bus.subscribe('e', (_, p) => { seen = p; });
  bus.emitSync('e', { x: 1 });
  assert.deepEqual(seen, { x: 1 });
});

test('emitSync runs interceptors for side effects but ignores return values', () => {
  const bus = new DynamicBus();
  let interceptorRan = false;
  bus.intercept('e', () => { interceptorRan = true; return { x: 'modified' }; });
  let seen = null;
  bus.subscribe('e', (_, p) => { seen = p; });
  bus.emitSync('e', { x: 'orig' });
  assert.equal(interceptorRan, true);
  assert.deepEqual(seen, { x: 'orig' });   // observer saw the input, not the interceptor's return
});

test('emitSync warns when interceptors registered without markSyncOnly', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.intercept('e', () => ({ x: 'modified' }));
  bus.emitSync('e', { x: 'orig' });
  assert.ok(warnings.some((m) => m.includes('emitSync') && m.includes('markSyncOnly')));
});

test('emitSync warns only once per name', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.intercept('e', () => {});
  bus.emitSync('e', null);
  bus.emitSync('e', null);
  bus.emitSync('e', null);
  const warns = warnings.filter((m) => m.includes('emitSync'));
  assert.equal(warns.length, 1);
});

test('emitSync with no interceptors does not warn even if not marked', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.subscribe('e', () => {});
  bus.emitSync('e', null);
  assert.equal(warnings.length, 0);
});

test('emitSync swallows Promise rejections from sync-only handlers', async () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.markSyncOnly('e');
  bus.intercept('e', async () => { throw new Error('async-fail'); });
  bus.emitSync('e', null);
  // Give the rejection time to surface as a warning rather than an unhandled rejection.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(warnings.some((m) => m.includes('rejected')));
});

// --- markSyncOnly ----------------------------------------------------------

test('markSyncOnly: intercept after mark warns at registration', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.markSyncOnly('frame.tick');
  bus.intercept('frame.tick', () => {});
  assert.ok(warnings.some((m) => m.includes('sync-only') && m.includes('frame.tick')));
});

test('markSyncOnly: catch-all intercept warns for each sync-only name (deduped)', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.markSyncOnly('frame.tick');
  bus.markSyncOnly('pointer.move');
  bus.intercept('*', () => {});
  // One warning for the (pattern, name) pair on first matching name; the
  // implementation breaks after the first match to avoid log floods.
  const warns = warnings.filter((m) => m.includes('sync-only'));
  assert.ok(warns.length >= 1);
});

test('markSyncOnly: prefix-glob intercept warns when it matches', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.markSyncOnly('pointer.move');
  bus.intercept('pointer.*', () => {});
  assert.ok(warnings.some((m) => m.includes('sync-only') && m.includes('pointer.move')));
});

test('markSyncOnly: intercept on unrelated pattern does not warn', () => {
  const warnings = [];
  const bus = new DynamicBus((msg) => warnings.push(msg));
  bus.markSyncOnly('frame.tick');
  bus.intercept('window.*', () => {});
  assert.equal(warnings.filter((m) => m.includes('sync-only')).length, 0);
});

test('markSyncOnly rejects empty / starred names', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.markSyncOnly(''), TypeError);
  assert.throws(() => bus.markSyncOnly('a.*'), TypeError);
});

// --- intercept argument validation -----------------------------------------

test('intercept rejects empty pattern', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.intercept('', () => {}), TypeError);
});

test('intercept rejects non-function cb', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.intercept('e', null), TypeError);
});

test('intercept rejects non-finite priority', () => {
  const bus = new DynamicBus();
  assert.throws(() => bus.intercept('e', () => {}, { priority: NaN }), TypeError);
  assert.throws(() => bus.intercept('e', () => {}, { priority: Infinity }), TypeError);
});

// --- clear -----------------------------------------------------------------

test('clear removes interceptors too', async () => {
  const bus = new DynamicBus();
  let count = 0;
  bus.intercept('e', () => { count++; });
  bus.clear();
  await bus.emit('e', null);
  assert.equal(count, 0);
});
