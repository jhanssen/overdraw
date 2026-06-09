// Pure-unit tests for the @overdraw/sdk-anim builders. Verifies that
// each builder produces a structurally-correct AnimationSpec; the
// builders are stateless functions, so the tests are shallow shape
// checks.
//
// The builders ARE the public API of @overdraw/sdk-anim, so the test
// imports from the package by name (workspace symlink) the same way a
// plugin author would.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tween, spring, sequence, parallel, target, cubicBezier, easings,
} from '@overdraw/sdk-anim';

test('tween: builds a TweenSpec with required fields', () => {
  const spec = tween(target.windowOpacity(7),
    { from: 0, to: 1, duration: 200 });
  assert.deepEqual(spec, {
    type: 'tween',
    target: { kind: 'window-opacity', windowId: 7 },
    from: 0, to: 1, duration: 200,
  });
});

test('tween: omits easing field when not provided', () => {
  const spec = tween(target.windowOpacity(1),
    { from: 0, to: 1, duration: 100 });
  assert.ok(!('easing' in spec), 'easing absent when omitted');
});

test('tween: preserves easing preset string', () => {
  const spec = tween(target.windowOpacity(1),
    { from: 0, to: 1, duration: 100, easing: 'ease-in-out' });
  assert.equal(spec.easing, 'ease-in-out');
});

test('tween: preserves cubic-bezier easing object', () => {
  const spec = tween(target.windowOpacity(1),
    { from: 0, to: 1, duration: 100,
      easing: cubicBezier(0.42, 0, 0.58, 1) });
  assert.deepEqual(spec.easing,
    { kind: 'cubic-bezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 });
});

test('spring: builds a SpringSpec with required fields', () => {
  const spec = spring(target.windowOpacity(7),
    { from: 0, to: 1, stiffness: 200, damping: 20 });
  assert.equal(spec.type, 'spring');
  assert.deepEqual(spec.target, { kind: 'window-opacity', windowId: 7 });
  assert.equal(spec.stiffness, 200);
  assert.equal(spec.damping, 20);
});

test('spring: omits undefined params (lets the evaluator default them)', () => {
  const spec = spring(target.windowOpacity(1), { from: 0, to: 1 });
  assert.ok(!('stiffness' in spec), 'stiffness absent');
  assert.ok(!('damping' in spec), 'damping absent');
  assert.ok(!('mass' in spec), 'mass absent');
  assert.ok(!('initialVelocity' in spec), 'initialVelocity absent');
});

test('spring: preserves explicit mass + initialVelocity', () => {
  const spec = spring(target.windowOpacity(1),
    { from: 0, to: 1, mass: 2, initialVelocity: 50 });
  assert.equal(spec.mass, 2);
  assert.equal(spec.initialVelocity, 50);
});

test('sequence: composes leaf specs in order', () => {
  const a = tween(target.windowOpacity(1), { from: 0, to: 1, duration: 100 });
  const b = tween(target.windowOpacity(1), { from: 1, to: 0, duration: 100 });
  const spec = sequence(a, b);
  assert.equal(spec.type, 'sequence');
  assert.equal(spec.items.length, 2);
  assert.strictEqual(spec.items[0], a);
  assert.strictEqual(spec.items[1], b);
});

test('parallel: composes leaf specs', () => {
  const a = tween(target.windowOpacity(1), { from: 0, to: 1, duration: 100 });
  const b = tween(target.windowOpacity(2), { from: 1, to: 0, duration: 100 });
  const spec = parallel(a, b);
  assert.equal(spec.type, 'parallel');
  assert.equal(spec.items.length, 2);
});

test('sequence + parallel: nest', () => {
  const inner = parallel(
    tween(target.windowOpacity(1), { from: 0, to: 1, duration: 100 }),
    tween(target.windowOpacity(2), { from: 0, to: 1, duration: 100 }),
  );
  const outer = sequence(
    tween(target.windowOpacity(1), { from: 1, to: 0, duration: 100 }),
    inner,
  );
  assert.equal(outer.type, 'sequence');
  assert.equal(outer.items.length, 2);
  assert.equal(outer.items[1].type, 'parallel');
  assert.equal(outer.items[1].items.length, 2);
});

test('target helpers: produce TargetRef values', () => {
  assert.deepEqual(target.windowOpacity(1),
    { kind: 'window-opacity', windowId: 1 });
  assert.deepEqual(target.windowTransform(2),
    { kind: 'window-transform', windowId: 2 });
  assert.deepEqual(target.windowOutputMargin(3),
    { kind: 'window-output-margin', windowId: 3 });
});

test('cubicBezier: builds a CubicBezier object', () => {
  const c = cubicBezier(0.25, 0.1, 0.25, 1);
  assert.deepEqual(c,
    { kind: 'cubic-bezier', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });
});

test('easings: maps to preset strings', () => {
  assert.equal(easings.linear, 'linear');
  assert.equal(easings.ease, 'ease');
  assert.equal(easings.easeIn, 'ease-in');
  assert.equal(easings.easeOut, 'ease-out');
  assert.equal(easings.easeInOut, 'ease-in-out');
});

test('builders are stateless: distinct calls return distinct objects', () => {
  const a = tween(target.windowOpacity(1), { from: 0, to: 1, duration: 100 });
  const b = tween(target.windowOpacity(1), { from: 0, to: 1, duration: 100 });
  assert.notStrictEqual(a, b);
  assert.deepEqual(a, b);
});
