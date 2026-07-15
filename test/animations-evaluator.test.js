// Pure-unit tests for the core animation evaluator. GPU-free; the
// evaluator drives a mock CompositorSink to record applied values.
// Spring physics + tween easing are exercised here against synthetic
// dt arrays so the test doesn't depend on a real frame clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEvaluator } from '../packages/core/dist/animations/evaluator.js';

function mockSink() {
  const calls = [];
  return {
    calls,
    setSurfaceOpacity(id, opacity) {
      calls.push({ method: 'opacity', id, opacity });
    },
    setSurfaceTransform(id, t) {
      calls.push({ method: 'transform', id, t: { ...t } });
    },
    setSurfaceOutputMargin(id, m) {
      calls.push({ method: 'margin', id, m: { ...m } });
    },
    setOutputCamera(outputId, x, y, zoom, transient) {
      calls.push({ method: 'camera', outputId, x, y, zoom, transient });
    },
    // Stubs required by CompositorSink shape; unused here.
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    setSurfaceMask() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
  };
}

// Drive the evaluator forward in small steps so each tick stays under
// the evaluator's per-tick dt clamp (default 100ms). The first tick
// just records the baseline; calls land from the second tick on.
// `startMs` is the baseline; `totalMs` is total elapsed time to cover;
// `stepMs` is the per-tick advance (default 16ms ~= 60Hz).
function drive(evaluator, startMs, totalMs, stepMs = 16) {
  evaluator.tick(startMs);
  let t = startMs;
  const end = startMs + totalMs;
  while (t < end) {
    t = Math.min(t + stepMs, end);
    evaluator.tick(t);
  }
}

// ---- tween: linear -----------------------------------------------------

test('tween linear: opacity 0 -> 1 over 1s reaches midpoint at t=500ms', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);

  const done = e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 1000,
  });

  drive(e, 0, 500);
  const last = sink.calls.filter((c) => c.method === 'opacity' && c.id === 1).pop();
  assert.ok(last, 'opacity applied');
  assert.ok(Math.abs(last.opacity - 0.5) < 0.02,
    `midpoint opacity ~= 0.5 got ${last.opacity}`);

  // Advance to end (another 500ms).
  drive(e, 500, 600);
  await done;
  const final = sink.calls.filter((c) => c.method === 'opacity' && c.id === 1).pop();
  assert.equal(final.opacity, 1, 'final opacity = 1');
  assert.equal(e.activeCount(), 0);
});

// ---- tween: ease-in-out clamps -----------------------------------------

test('tween: progress beyond duration clamps to to-value', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const done = e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 100,
  });
  // Drive ~5s; well past the 100ms duration.
  drive(e, 0, 5000);
  await done;
  const last = sink.calls.filter((c) => c.method === 'opacity').pop();
  assert.equal(last.opacity, 1);
});

// ---- tween: cubic-bezier easing applies --------------------------------

test('tween cubic-bezier: ease-in produces smaller mid-progress than linear', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  void e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 1000,
    easing: 'ease-in',
  });
  drive(e, 0, 500);
  const last = sink.calls.filter((c) => c.method === 'opacity' && c.id === 1).pop();
  // ease-in: 0.42, 0.0, 1.0, 1.0 -> midpoint should be < 0.5.
  assert.ok(last.opacity < 0.4,
    `ease-in midpoint should be < 0.4 (got ${last.opacity})`);
});

// ---- tween: zero duration ----------------------------------------------

test('tween: duration 0 snaps to `to` and resolves immediately', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  await e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 0,
  });
  const applied = sink.calls.find((c) => c.method === 'opacity' && c.id === 1);
  assert.equal(applied.opacity, 1);
  assert.equal(e.activeCount(), 0);
});

// ---- tween: transform interpolates each field --------------------------

test('tween transform: translateX and scaleX interpolate independently', () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  void e.run({
    type: 'tween',
    target: { kind: 'window-transform', windowId: 1 },
    from: { translateX: 0, scaleX: 1 },
    to: { translateX: 100, scaleX: 2 },
    duration: 1000,
  });
  drive(e, 0, 500);
  const last = sink.calls.filter((c) => c.method === 'transform').pop().t;
  assert.ok(Math.abs(last.translateX - 50) < 2,
    `translateX ~= 50 (got ${last.translateX})`);
  assert.ok(Math.abs(last.scaleX - 1.5) < 0.02,
    `scaleX ~= 1.5 (got ${last.scaleX})`);
  // Fields omitted from from/to default: translateY=0, scaleY=1.
  assert.equal(last.translateY, 0);
  assert.equal(last.scaleY, 1);
});

// ---- spring: settles + Promise resolves --------------------------------

test('spring: opacity 0 -> 1 overshoots then settles', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const done = e.run({
    type: 'spring',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1,
    stiffness: 200, damping: 8, mass: 1,  // underdamped -> overshoot
  });

  // Drive ~2s in 16ms steps.
  let t = 0;
  e.tick(t);  // baseline
  let sawOvershoot = false;
  for (let i = 0; i < 200; i++) {
    t += 16;
    e.tick(t);
    const last = sink.calls.filter((c) => c.method === 'opacity').pop();
    if (last && last.opacity > 1) sawOvershoot = true;
    if (e.activeCount() === 0) break;
  }
  await done;
  assert.ok(sawOvershoot, 'underdamped spring should overshoot >1');
  const final = sink.calls.filter((c) => c.method === 'opacity').pop();
  assert.equal(final.opacity, 1, 'settled to target');
  assert.equal(e.activeCount(), 0);
});

test('spring critically damped: settles without overshoot', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const done = e.run({
    type: 'spring',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1,
    // critical damping for k=200, m=1 is 2*sqrt(k*m) ~= 28.28
    stiffness: 200, damping: 28.3, mass: 1,
  });
  let t = 0;
  e.tick(t);
  let maxValue = 0;
  for (let i = 0; i < 300; i++) {
    t += 16;
    e.tick(t);
    const last = sink.calls.filter((c) => c.method === 'opacity').pop();
    if (last) maxValue = Math.max(maxValue, last.opacity);
    if (e.activeCount() === 0) break;
  }
  await done;
  assert.ok(maxValue <= 1.001, `critically damped should not overshoot (got max ${maxValue})`);
});

// ---- cancel-on-replacement ---------------------------------------------

test('cancel-on-replacement: new tween on same target preempts the old one', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const first = e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 10_000,
  });
  e.tick(0);
  e.tick(50);
  // First is mid-flight; replacement on same target preempts.
  const second = e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0.5, to: 0, duration: 100,
  });
  await first;  // resolves cleanly on preemption

  // Drive second to completion.
  drive(e, 50, 500);
  await second;
  const last = sink.calls.filter((c) => c.method === 'opacity').pop();
  assert.equal(last.opacity, 0);
});

test('cancel-on-replacement: different windows do not preempt each other', () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  void e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 1000,
  });
  void e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 2 },
    from: 1, to: 0, duration: 1000,
  });
  assert.equal(e.activeCount(), 2);
});

// ---- cancel(target) ----------------------------------------------------

test('cancel(target): resolves the run Promise + removes the leaf', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const done = e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: 0, to: 1, duration: 10_000,
  });
  e.tick(0);
  e.tick(50);
  await e.cancel({ kind: 'window-opacity', windowId: 1 });
  await done;
  assert.equal(e.activeCount(), 0);
});

test('cancel(target) on unknown target: silent no-op', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  await e.cancel({ kind: 'window-opacity', windowId: 999 });
  assert.equal(e.activeCount(), 0);
});

// ---- sequence ----------------------------------------------------------

test('sequence: items run one at a time; total resolves after the last', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const done = e.run({
    type: 'sequence',
    items: [
      { type: 'tween',
        target: { kind: 'window-opacity', windowId: 1 },
        from: 0, to: 1, duration: 100 },
      { type: 'tween',
        target: { kind: 'window-opacity', windowId: 1 },
        from: 1, to: 0, duration: 100 },
    ],
  });
  // Drive first item to completion (~100ms).
  drive(e, 0, 200);
  // The first item resolved; the await in the sequence chains to the
  // second item. Yield to microtasks so the chained startTween enters
  // the map.
  await Promise.resolve();
  await Promise.resolve();
  // Drive second item.
  drive(e, 200, 200);
  await done;
  const last = sink.calls.filter((c) => c.method === 'opacity').pop();
  assert.equal(last.opacity, 0);
});

// ---- parallel ----------------------------------------------------------

test('parallel: items run concurrently; total resolves after both', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const done = e.run({
    type: 'parallel',
    items: [
      { type: 'tween',
        target: { kind: 'window-opacity', windowId: 1 },
        from: 0, to: 1, duration: 100 },
      { type: 'tween',
        target: { kind: 'window-opacity', windowId: 2 },
        from: 1, to: 0, duration: 100 },
    ],
  });
  // Both leaves enter the map together.
  assert.equal(e.activeCount(), 2);
  drive(e, 0, 200);
  await done;
  assert.equal(e.activeCount(), 0);
});

// ---- payload validation ------------------------------------------------

test('coerceValue: rejects non-finite opacity', () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  assert.throws(() => e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 1 },
    from: NaN, to: 1, duration: 100,
  }), /must be a finite number/);
});

test('coerceValue: rejects negative margin', () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  assert.throws(() => e.run({
    type: 'tween',
    target: { kind: 'window-output-margin', windowId: 1 },
    from: { top: 0 }, to: { top: -5 }, duration: 100,
  }), /non-negative/);
});

// ---- output-camera target ------------------------------------------------

test('tween output-camera: writes transient per-frame camera values', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);

  const done = e.run({
    type: 'tween',
    target: { kind: 'output-camera', outputId: 2 },
    from: { x: 0 }, to: { x: 928 }, duration: 400,
  });
  drive(e, 0, 200);
  const mid = sink.calls.at(-1);
  assert.equal(mid.method, 'camera');
  assert.equal(mid.outputId, 2);
  assert.equal(mid.transient, true);
  // Linear midpoint; missing fields ride the identity camera.
  assert.ok(Math.abs(mid.x - 464) < 40, `mid.x ${mid.x} ~ 464`);
  assert.equal(mid.y, 0);
  assert.equal(mid.zoom, 1);

  drive(e, 200, 300);
  await done;
  const last = sink.calls.at(-1);
  assert.equal(last.x, 928);
  assert.equal(last.transient, true);
});

test('output-camera and window targets with the same numeric id do not preempt', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const cam = e.run({
    type: 'tween',
    target: { kind: 'output-camera', outputId: 3 },
    from: { x: 0 }, to: { x: 100 }, duration: 100,
  });
  const fade = e.run({
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 3 },
    from: 0, to: 1, duration: 100,
  });
  assert.equal(e.activeCount(), 2);
  drive(e, 0, 150);
  await Promise.all([cam, fade]);
  assert.ok(sink.calls.some((c) => c.method === 'camera' && c.x === 100));
  assert.ok(sink.calls.some((c) => c.method === 'opacity' && c.opacity === 1));
});

test('cancel-on-replacement: a new flight on the same output preempts the old one', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const first = e.run({
    type: 'tween',
    target: { kind: 'output-camera', outputId: 1 },
    from: { x: 0 }, to: { x: 1000 }, duration: 1000,
  });
  drive(e, 0, 100);
  const second = e.run({
    type: 'tween',
    target: { kind: 'output-camera', outputId: 1 },
    from: { x: 100 }, to: { x: 2000 }, duration: 100,
  });
  await first;  // resolves cleanly on preemption
  assert.equal(e.activeCount(), 1);
  drive(e, 100, 150);
  await second;
  assert.equal(sink.calls.at(-1).x, 2000);
});

test('cancel(output-camera target): resolves the run Promise', async () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  const run = e.run({
    type: 'tween',
    target: { kind: 'output-camera', outputId: 5 },
    from: { x: 0 }, to: { x: 500 }, duration: 1000,
  });
  await e.cancel({ kind: 'output-camera', outputId: 5 });
  await run;
  assert.equal(e.activeCount(), 0);
});

test('coerceValue: rejects non-positive camera zoom', () => {
  const sink = mockSink();
  const e = createEvaluator(sink);
  assert.throws(() => e.run({
    type: 'tween',
    target: { kind: 'output-camera', outputId: 1 },
    from: { zoom: 1 }, to: { zoom: 0 }, duration: 100,
  }), /positive/);
});
