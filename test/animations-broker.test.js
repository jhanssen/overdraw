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

// ---- animations.start / animations.settled ---------------------------------

const OPACITY_SPEC = {
  spec: { type: 'tween', target: { kind: 'window-opacity', windowId: 1 },
          from: 0, to: 1, duration: 100 },
};

test('animations.start: registers with the evaluator and returns a handle', async () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev);
  const res = await broker('p', 'animations.start', OPACITY_SPEC);
  assert.equal(typeof res.handle, 'number');
  assert.equal(ev.calls.length, 1);
  assert.equal(ev.calls[0].method, 'run');
});

test('animations.settled: resolves when the started run settles', async () => {
  let settle;
  const ev = {
    ...mockEvaluator(),
    run() { return new Promise((resolve) => { settle = resolve; }); },
  };
  const broker = createAnimationsBroker(ev);
  const { handle } = await broker('p', 'animations.start', OPACITY_SPEC);
  let done = false;
  const claim = Promise.resolve(broker('p', 'animations.settled', { handle }))
    .then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'settled must not resolve before the run does');
  settle();
  await claim;
  assert.equal(done, true);
});

test('animations.settled: unknown handle resolves immediately', async () => {
  const broker = createAnimationsBroker(mockEvaluator());
  await broker('p', 'animations.settled', { handle: 12345 });
});

test('animations.start: distinct handles per start', async () => {
  const broker = createAnimationsBroker(mockEvaluator());
  const a = await broker('p', 'animations.start', OPACITY_SPEC);
  const b = await broker('p', 'animations.start', OPACITY_SPEC);
  assert.notEqual(a.handle, b.handle);
});

test('animations.start: malformed payload throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.start', {}), /malformed payload/);
});

test('animations.settled: malformed payload throws', () => {
  const broker = createAnimationsBroker(mockEvaluator());
  assert.throws(() => broker('p', 'animations.settled', {}), /malformed payload/);
});

test('animations.start: cameraGate denial rejects before the evaluator', () => {
  const ev = mockEvaluator();
  const broker = createAnimationsBroker(ev, { cameraGate: () => 'grab active' });
  assert.throws(() => broker('p', 'animations.start', {
    spec: { type: 'tween', target: { kind: 'output-camera', outputId: 0 },
            from: { x: 0 }, to: { x: 10 }, duration: 100 },
  }), /camera animation denied: grab active/);
  assert.equal(ev.calls.length, 0);
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
