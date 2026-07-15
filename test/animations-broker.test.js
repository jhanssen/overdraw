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

// ---- output-camera targets -------------------------------------------------

test('animations.cancel: output-camera target forwards to the evaluator', async () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev);
  await broker('p', 'animations.cancel',
    { target: { kind: 'output-camera', outputId: 2 } });
  assert.deepEqual(ev.calls[0],
    { method: 'cancel', target: { kind: 'output-camera', outputId: 2 } });
});

test('animations.cancel: output-camera without outputId throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.cancel',
    { target: { kind: 'output-camera', windowId: 2 } }),
    /malformed payload/);
});

test('cameraGate: denial rejects the run before it reaches the evaluator', () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev, {
    cameraGate: () => 'interactive grab active',
  });
  assert.throws(() => broker('p', 'animations.run', {
    spec: { type: 'tween', target: { kind: 'output-camera', outputId: 0 },
            from: { x: 0 }, to: { x: 100 }, duration: 100 },
  }), /camera animation denied: interactive grab active/);
  assert.equal(ev.calls.length, 0);
});

test('cameraGate: walks composite specs to find camera leaves', () => {
  const ev = mockEvaluator();
  const gated = [];
  const broker = createAnimationsBroker(ev, {
    cameraGate: (outputId) => { gated.push(outputId); return 'denied'; },
  });
  assert.throws(() => broker('p', 'animations.run', {
    spec: { type: 'sequence', items: [
      { type: 'tween', target: { kind: 'window-opacity', windowId: 1 },
        from: 0, to: 1, duration: 50 },
      { type: 'parallel', items: [
        { type: 'tween', target: { kind: 'output-camera', outputId: 4 },
          from: { x: 0 }, to: { x: 10 }, duration: 50 },
      ] },
    ] },
  }), /camera animation denied/);
  assert.deepEqual(gated, [4]);
});

test('cameraGate: window-only specs pass an always-deny gate', async () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev, { cameraGate: () => 'denied' });
  await broker('p', 'animations.run', {
    spec: { type: 'tween', target: { kind: 'window-opacity', windowId: 1 },
            from: 0, to: 1, duration: 50 },
  });
  assert.equal(ev.calls.length, 1);
});

test('cameraGate: allow (null) lets a camera run through', async () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev, { cameraGate: () => null });
  await broker('p', 'animations.run', {
    spec: { type: 'tween', target: { kind: 'output-camera', outputId: 1 },
            from: { x: 0 }, to: { x: 10 }, duration: 50 },
  });
  assert.equal(ev.calls.length, 1);
});
