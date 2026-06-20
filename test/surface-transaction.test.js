// Pure-unit tests for the surface-transaction broker. Verifies the
// freeze/thaw lifecycle, requirement merging on the same surface, batch
// atomicity via batchKey, deadline expiry, and cancellation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSurfaceTransactionBroker }
  from '../packages/core/dist/surface-transaction.js';

// Tiny fake sink that records freeze/thaw calls and routes the frozen-
// ready callback for tests to drive manually.
function makeSink() {
  let cb = null;
  const calls = [];
  return {
    calls,
    freezeSurface(id) { calls.push(['freeze', id]); },
    thawSurface(id) { calls.push(['thaw', id]); },
    setFrozenReadyHandler(c) { cb = c; },
    fireReady(id) { cb?.(id); },
  };
}

// Controllable clock + timer for deterministic deadline tests.
function makeClock() {
  let now = 0;
  const timers = []; // {at, cb, alive}
  return {
    now: () => now,
    setTimer(cb, ms) {
      const t = { at: now + ms, cb, alive: true };
      timers.push(t);
      return t;
    },
    clearTimer(h) { if (h) h.alive = false; },
    advance(dt) {
      now += dt;
      // Fire any due timers, in due-time order, allowing reentry.
      while (true) {
        const due = timers
          .filter((t) => t.alive && t.at <= now)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.alive = false;
        due.cb();
      }
    },
  };
}

test('begin freezes; ready-then-evaluate thaws and runs onApply', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  let applied = 0;
  let ready = false;
  b.begin(7, {
    tag: 'test',
    ready: () => ready,
    onApply: () => { applied++; },
  });
  assert.deepEqual(sink.calls, [['freeze', 7]]);
  assert.equal(applied, 0);
  assert.ok(b.has(7));
  // Not ready yet.
  b.evaluate();
  assert.equal(applied, 0);
  // Becomes ready; the frozen-ready signal triggers evaluate.
  ready = true;
  sink.fireReady(7);
  assert.equal(applied, 1);
  assert.deepEqual(sink.calls, [['freeze', 7], ['thaw', 7]]);
  assert.ok(!b.has(7));
});

test('onStart fires synchronously inside begin (the first time only)', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  const order = [];
  b.begin(1, {
    tag: 'a',
    ready: () => false,
    onStart: () => order.push('onStart-a'),
  });
  // Second requirement joins; surface is already frozen; onStart-b must NOT fire.
  b.begin(1, {
    tag: 'b',
    ready: () => false,
    onStart: () => order.push('onStart-b'),
  });
  assert.deepEqual(order, ['onStart-a']);
  // Only one freeze.
  assert.equal(sink.calls.filter((c) => c[0] === 'freeze').length, 1);
  assert.deepEqual(b.tagsFor(1), ['a', 'b']);
});

test('multiple requirements on one surface: apply waits for all', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  const order = [];
  let r1 = false, r2 = false;
  b.begin(5, { tag: 'r1', ready: () => r1, onApply: () => order.push('apply-1') });
  b.begin(5, { tag: 'r2', ready: () => r2, onApply: () => order.push('apply-2') });
  r1 = true;
  sink.fireReady(5);
  assert.deepEqual(order, []);
  r2 = true;
  sink.fireReady(5);
  assert.deepEqual(order, ['apply-1', 'apply-2']);
});

test('batchKey: holds in the same batch wait for each other', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  let aReady = false, cReady = false;
  const applied = [];
  b.begin(1, {
    tag: 'a', batchKey: 'wm-tx',
    ready: () => aReady, onApply: () => applied.push(1),
  });
  b.begin(2, {
    tag: 'c', batchKey: 'wm-tx',
    ready: () => cReady, onApply: () => applied.push(2),
  });
  aReady = true;
  sink.fireReady(1);
  // a is ready but c is not; nothing applies yet.
  assert.deepEqual(applied, []);
  cReady = true;
  sink.fireReady(2);
  // Both ready: atomic batch fires.
  assert.deepEqual(applied, [1, 2]);
});

test('null batchKey: independent holds apply individually', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  let aReady = false, cReady = false;
  const applied = [];
  b.begin(1, { tag: 'a', ready: () => aReady, onApply: () => applied.push(1) });
  b.begin(2, { tag: 'c', ready: () => cReady, onApply: () => applied.push(2) });
  aReady = true;
  sink.fireReady(1);
  assert.deepEqual(applied, [1]);
  cReady = true;
  sink.fireReady(2);
  assert.deepEqual(applied, [1, 2]);
});

test('null + non-null batchKey: independent does not wait for batch', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  let aReady = false, bReady = false;
  const applied = [];
  // Independent hold.
  b.begin(1, { tag: 'indep', ready: () => aReady, onApply: () => applied.push('indep') });
  // Batched hold.
  b.begin(2, {
    tag: 'tx', batchKey: 'wm-tx',
    ready: () => bReady, onApply: () => applied.push('tx'),
  });
  aReady = true;
  sink.fireReady(1);
  // Independent applies; batched waits for its (lone) batch peer to also be ready.
  assert.deepEqual(applied, ['indep']);
  bReady = true;
  sink.fireReady(2);
  assert.deepEqual(applied, ['indep', 'tx']);
});

test('deadline forces apply even if requirements never go ready', () => {
  const sink = makeSink();
  const clock = makeClock();
  const b = createSurfaceTransactionBroker(sink, {
    timeoutMs: 100,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  let applied = false;
  b.begin(9, { tag: 'slow', ready: () => false, onApply: () => { applied = true; } });
  clock.advance(99);
  assert.equal(applied, false);
  clock.advance(2);
  assert.equal(applied, true);
});

test('deadline extends when a new requirement joins late', () => {
  const sink = makeSink();
  const clock = makeClock();
  const b = createSurfaceTransactionBroker(sink, {
    timeoutMs: 100, now: clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  let applied = false;
  b.begin(1, { tag: 'a', ready: () => false, onApply: () => { applied = true; } });
  clock.advance(80);
  b.begin(1, { tag: 'b', ready: () => false });
  // Original would have expired at t=100, but the joiner pushed it to t=180.
  clock.advance(25); // t=105
  assert.equal(applied, false);
  clock.advance(80); // t=185
  assert.equal(applied, true);
});

test('cancel: thaws without running onApply, runs onCancel', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  const order = [];
  // Add a never-ready requirement first so the hold persists.
  b.begin(3, { tag: 'block', ready: () => false });
  b.begin(3, {
    tag: 'x',
    ready: () => true,
    onApply: () => order.push('apply'),
    onCancel: () => order.push('cancel'),
  });
  assert.ok(b.has(3));
  b.cancel(3);
  assert.deepEqual(order, ['cancel']);
  assert.ok(!b.has(3));
  // freeze + thaw recorded once each.
  assert.deepEqual(sink.calls.filter((c) => c[1] === 3),
    [['freeze', 3], ['thaw', 3]]);
});

test('already-ready requirement applies immediately on begin', () => {
  const sink = makeSink();
  const b = createSurfaceTransactionBroker(sink);
  let applied = false;
  b.begin(5, { tag: 'fast', ready: () => true, onApply: () => { applied = true; } });
  assert.equal(applied, true);
  assert.ok(!b.has(5));
});
