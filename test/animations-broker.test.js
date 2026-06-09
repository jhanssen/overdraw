// Pure-unit tests for the animations broker. Verifies it routes
// animations.run / animations.cancel through to the evaluator and
// rejects malformed payloads.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAnimationsBroker, NOT_HANDLED }
  from '../packages/core/dist/plugins/animations-broker.js';

function mockEvaluator() {
  const calls = [];
  return {
    calls,
    run(spec) {
      calls.push({ method: 'run', spec });
      return Promise.resolve();
    },
    cancel(target) {
      calls.push({ method: 'cancel', target });
      return Promise.resolve();
    },
    tick() {},
    activeCount() { return 0; },
  };
}

test('animations.run: forwards spec to the evaluator', async () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev);
  await broker('p', 'animations.run', {
    spec: { type: 'tween', target: { kind: 'window-opacity', windowId: 1 },
            from: 0, to: 1, duration: 100 },
  });
  assert.equal(ev.calls.length, 1);
  assert.equal(ev.calls[0].method, 'run');
  assert.equal(ev.calls[0].spec.type, 'tween');
});

test('animations.cancel: forwards target to the evaluator', async () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev);
  await broker('p', 'animations.cancel',
    { target: { kind: 'window-opacity', windowId: 7 } });
  assert.deepEqual(ev.calls[0],
    { method: 'cancel', target: { kind: 'window-opacity', windowId: 7 } });
});

test('animations.run: malformed (missing spec) throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.run', {}),
    /malformed payload/);
});

test('animations.run: malformed (unknown spec.type) throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.run',
    { spec: { type: 'unknown', target: { kind: 'window-opacity', windowId: 1 } } }),
    /malformed payload/);
});

test('animations.cancel: malformed (missing target) throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.cancel', {}),
    /malformed payload/);
});

test('animations.cancel: malformed (unknown kind) throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.cancel',
    { target: { kind: 'oops', windowId: 1 } }),
    /malformed payload/);
});

test('non-animations method returns NOT_HANDLED', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.equal(broker('p', 'windows.set-opacity', { id: 1, opacity: 0.5 }),
    NOT_HANDLED);
});
