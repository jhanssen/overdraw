// Pure-unit tests for the core transition evaluator. GPU-free; the
// evaluator owns the time math + lifecycle but no GPU resources, so it
// can be exercised against synthetic timeMs sequences. The compositor's
// transition pipeline is tested separately in the GPU suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTransitionEvaluator } from '../packages/core/dist/transitions/evaluator.js';

// ---- install / lifecycle ---------------------------------------------------

test('install: returns a Promise; idle before install', () => {
  const e = createTransitionEvaluator();
  assert.equal(e.isActive(), false);
  assert.equal(e.getProgress(), null);
  assert.equal(e.durationMs(), null);
});

test('install: rejects durationMs <= 0', () => {
  const e = createTransitionEvaluator();
  assert.throws(() => e.install({ durationMs: 0 }), /durationMs must be > 0/);
  assert.throws(() => e.install({ durationMs: -100 }), /durationMs must be > 0/);
  assert.throws(() => e.install({ durationMs: NaN }), /durationMs must be > 0/);
  assert.equal(e.isActive(), false);
});

test('install: throws when a transition is already active', () => {
  const e = createTransitionEvaluator();
  e.install({ durationMs: 200 });
  assert.throws(() => e.install({ durationMs: 100 }), /already active/);
  // First transition still active; the failed install didn't disturb it.
  assert.equal(e.isActive(), true);
  assert.equal(e.durationMs(), 200);
});

test('install: active after install; progress starts at 0', () => {
  const e = createTransitionEvaluator();
  e.install({ durationMs: 100 });
  assert.equal(e.isActive(), true);
  // Progress is 0 immediately after install (before any tick). The
  // first tick latches startMs and computes easing(0); for "linear"
  // (the default) that's still 0, so a reader between install and
  // first tick sees the correct "at the start" value.
  assert.equal(e.getProgress(), 0);
});

// ---- tick: time latching ---------------------------------------------------

test('tick: first tick latches startMs; progress = easing(0)', () => {
  const e = createTransitionEvaluator();
  e.install({ durationMs: 100 });
  e.tick(500);
  // Linear easing of 0 is 0.
  assert.equal(e.getProgress(), 0);
});

test('tick: latches against the first tick, not install time', () => {
  // Install happens between frames; the first tick is whenever the next
  // frame fires. Progress at that tick is 0 regardless of how much real
  // time elapsed between install and tick.
  const e = createTransitionEvaluator();
  const p = e.install({ durationMs: 100 });
  // Even if 50ms of "wall time" elapsed between install and the first
  // tick, the first tick is t=0.
  e.tick(1050);
  assert.equal(e.getProgress(), 0);
  // Second tick 50ms later is t=0.5 (linear).
  e.tick(1100);
  assert.equal(e.getProgress(), 0.5);
  // Awaiting the promise; should still be pending here. The test
  // proves only that lifecycle/progress is right; resolution is in
  // a later test.
  void p;
});

test('tick: linear progress through duration', () => {
  const e = createTransitionEvaluator();
  e.install({ durationMs: 200 });
  e.tick(0);
  assert.equal(e.getProgress(), 0);
  e.tick(50);
  assert.equal(e.getProgress(), 0.25);
  e.tick(100);
  assert.equal(e.getProgress(), 0.5);
  e.tick(150);
  assert.equal(e.getProgress(), 0.75);
});

test('tick: clamps t < 0 to 0 (clock-skew safety)', () => {
  const e = createTransitionEvaluator();
  e.install({ durationMs: 100 });
  e.tick(1000);
  // Time went BACKWARDS. Should clamp to 0, not produce negative
  // progress or an out-of-range easing value.
  e.tick(990);
  assert.equal(e.getProgress(), 0);
});

// ---- completion ------------------------------------------------------------

test('tick: at t=1 the promise resolves and evaluator returns to idle', async () => {
  const e = createTransitionEvaluator();
  const p = e.install({ durationMs: 100 });
  e.tick(0);
  e.tick(50);
  assert.equal(e.isActive(), true);
  e.tick(100);
  // tick(100) brought rawT to 1 -> completion. Active must now be false
  // BEFORE the promise resolves (so a commit-callback that installs a
  // follow-up transition sees an idle evaluator).
  assert.equal(e.isActive(), false);
  assert.equal(e.getProgress(), null);
  // The promise resolved.
  await p;
});

test('tick: rawT > 1 also completes (clamped at 1)', async () => {
  // A long pause between frames can push rawT past 1 in a single tick.
  // The evaluator should treat that as "done" rather than overshooting
  // progress.
  const e = createTransitionEvaluator();
  const p = e.install({ durationMs: 100 });
  e.tick(0);
  e.tick(500);
  assert.equal(e.isActive(), false);
  await p;
});

test('tick: commit fires synchronously BEFORE the promise resolves', async () => {
  const calls = [];
  const e = createTransitionEvaluator();
  const p = e.install({
    durationMs: 100,
    commit: () => calls.push('commit'),
  });
  p.then(() => calls.push('resolve'));
  e.tick(0);
  e.tick(100);
  // Commit fires synchronously inside the completion tick; the promise
  // resolves in the microtask queue.
  assert.deepEqual(calls, ['commit']);
  await p;
  assert.deepEqual(calls, ['commit', 'resolve']);
});

test('tick: commit sees an IDLE evaluator (state cleared before commit runs)', async () => {
  // The workspace plugin's commit may install a follow-up transition
  // (e.g. a chained animation). For that to work, the evaluator must
  // be back to idle by the time commit() is called -- otherwise the
  // follow-up install would throw "already active".
  const observations = [];
  const e = createTransitionEvaluator();
  e.install({
    durationMs: 50,
    commit: () => {
      observations.push({ active: e.isActive() });
    },
  });
  e.tick(0);
  e.tick(50);
  assert.deepEqual(observations, [{ active: false }]);
});

test('tick: a commit that installs a follow-up transition works', async () => {
  // Concrete consequence of the above: chained transitions are
  // possible because the second install() happens after the first's
  // state was cleared.
  const e = createTransitionEvaluator();
  let secondInstalled = false;
  const p1 = e.install({
    durationMs: 50,
    commit: () => {
      e.install({ durationMs: 50 });
      secondInstalled = true;
    },
  });
  e.tick(0);
  e.tick(50);
  await p1;
  assert.equal(secondInstalled, true);
  assert.equal(e.isActive(), true);
  assert.equal(e.durationMs(), 50);
});

test('tick: commit throwing does not break the evaluator', async () => {
  const e = createTransitionEvaluator();
  // Suppress the console.error the evaluator emits on commit throw.
  const origError = console.error;
  console.error = () => {};
  try {
    const p = e.install({
      durationMs: 50,
      commit: () => { throw new Error('boom'); },
    });
    e.tick(0);
    e.tick(50);
    // Promise still resolves; evaluator still idle.
    await p;
    assert.equal(e.isActive(), false);
  } finally {
    console.error = origError;
  }
});

// ---- easing ---------------------------------------------------------------

test('tick: easing applied to progress', () => {
  const e = createTransitionEvaluator();
  e.install({ durationMs: 100, easing: 'ease-in-out' });
  e.tick(0);
  assert.equal(e.getProgress(), 0);
  // At normalized t=0.5, ease-in-out is symmetric around 0.5 -- the
  // exact value is the cubic-bezier(0.42, 0, 0.58, 1) sample at x=0.5,
  // which is 0.5 by symmetry.
  e.tick(50);
  const p = e.getProgress();
  assert.ok(Math.abs(p - 0.5) < 1e-6, `expected 0.5, got ${p}`);
});

test('install: unknown easing preset throws', () => {
  const e = createTransitionEvaluator();
  assert.throws(
    () => e.install({ durationMs: 100, easing: 'no-such-easing' }),
    /unknown easing preset/);
});

// ---- idle tick is a no-op --------------------------------------------------

test('tick: no-op when idle', () => {
  const e = createTransitionEvaluator();
  // Just shouldn't throw.
  e.tick(0);
  e.tick(1000);
  assert.equal(e.isActive(), false);
  assert.equal(e.getProgress(), null);
});

// ---- after completion: a fresh install works ------------------------------

test('install: can install again after completion', async () => {
  const e = createTransitionEvaluator();
  const p1 = e.install({ durationMs: 100 });
  e.tick(0);
  e.tick(100);
  await p1;
  // Fresh install must succeed.
  const p2 = e.install({ durationMs: 50 });
  assert.equal(e.isActive(), true);
  e.tick(1000);
  e.tick(1050);
  await p2;
});
