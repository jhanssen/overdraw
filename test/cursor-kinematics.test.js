// Pure-unit tests for the cursor kinematic state machine: windowed
// finite-difference velocity, KWin-style shake detector, idle timer,
// refcounted lazy enablement. GPU-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Kinematics } from '../packages/core/dist/cursor/kinematics.js';

// --- enable / disable / lazy behavior ---------------------------------------

test('kinematics: disabled by default; update() is a no-op', () => {
  const k = new Kinematics();
  assert.equal(k.isEnabled(), false);
  k.update(0, 0, 0);
  k.update(100, 0, 100);
  const s = k.snapshot();
  assert.equal(s.speedPxPerSec, 0);
  assert.equal(s.velocityX, 0);
  assert.equal(s.velocityY, 0);
});

test('kinematics: enable() makes update() active; disable() resets', () => {
  const k = new Kinematics();
  k.enable();
  assert.equal(k.isEnabled(), true);
  // Simulate sampling at the configured 60Hz: 16.67ms steps.
  const dt = 1000 / 60;
  for (let i = 0; i < 6; ++i) k.update(i * 100, 0, i * dt);
  const s = k.snapshot();
  // 6 samples at 100px/step at 60Hz -> ~6000 px/s.
  assert.ok(s.speedPxPerSec > 4000 && s.speedPxPerSec < 7000,
    `expected ~6000 px/s, got ${s.speedPxPerSec}`);
  k.disable();
  assert.equal(k.isEnabled(), false);
  const s2 = k.snapshot();
  assert.equal(s2.speedPxPerSec, 0);
  assert.equal(s2.velocityX, 0);
  assert.equal(s2.velocityY, 0);
});

test('kinematics: enable/disable refcount (multiple consumers)', () => {
  const k = new Kinematics();
  k.enable();
  k.enable();
  assert.equal(k.isEnabled(), true);
  k.disable();
  assert.equal(k.isEnabled(), true, 'still enabled after first disable');
  k.disable();
  assert.equal(k.isEnabled(), false);
});

// --- velocity ---------------------------------------------------------------

test('kinematics: velocity is windowed finite-difference, x-axis', () => {
  const k = new Kinematics({ velocityWindowMs: 100, sampleHz: 60 });
  k.enable();
  const dt = 1000 / 60;
  // 6 samples = enough to span 100ms (6/60 = 100ms).
  for (let i = 0; i < 6; ++i) k.update(i * 10, 0, i * dt);
  const s = k.snapshot();
  // 10px per 16.67ms = ~600 px/s.
  assert.ok(s.speedPxPerSec > 500 && s.speedPxPerSec < 700,
    `~600 px/s expected, got ${s.speedPxPerSec}`);
  assert.ok(s.velocityX > 500, `velocityX positive ~600 expected, got ${s.velocityX}`);
  assert.equal(s.velocityY, 0);
});

test('kinematics: velocity zero when stationary', () => {
  const k = new Kinematics();
  k.enable();
  const dt = 1000 / 60;
  for (let i = 0; i < 10; ++i) k.update(50, 50, i * dt);
  const s = k.snapshot();
  assert.equal(s.speedPxPerSec, 0);
});

test('kinematics: velocity reflects direction (negative x)', () => {
  const k = new Kinematics();
  k.enable();
  const dt = 1000 / 60;
  for (let i = 0; i < 6; ++i) k.update(-i * 10, 0, i * dt);
  const s = k.snapshot();
  assert.ok(s.velocityX < -500, `velocityX negative expected, got ${s.velocityX}`);
});

// --- idle -------------------------------------------------------------------

test('kinematics: idleMs increments via tick() until next motion', () => {
  const k = new Kinematics();
  k.enable();
  k.update(0, 0, 0);
  k.tick(0);
  k.tick(50);    // dt=50
  k.tick(100);   // dt=50; idleMsAccum=100
  let s = k.snapshot();
  assert.equal(s.idleMs, 100);
  k.tick(250);   // dt=150; idleMsAccum=250
  s = k.snapshot();
  assert.equal(s.idleMs, 250);
  // Motion resets to 0.
  k.update(1, 1, 260);
  s = k.snapshot();
  assert.equal(s.idleMs, 0);
});

test('kinematics: tick() is a no-op when disabled', () => {
  const k = new Kinematics();
  // Not enabled.
  k.tick(0);
  k.tick(100);
  const s = k.snapshot();
  assert.equal(s.idleMs, 0);
});

// --- shake detector ---------------------------------------------------------

test('kinematics: shake detector fires on rapid back-and-forth motion', () => {
  const k = new Kinematics({ shakeWindowMs: 1000, shakeThreshold: 6.0, sampleHz: 60 });
  k.enable();
  const dt = 1000 / 60;
  // Bounding box diagonal must exceed 100px (the hypr/KWin micro-jitter
  // suppression threshold). Sweep across 150px to ensure the box is
  // big enough. Alternating motion = 60 steps of 150px each =
  // trail ~ 8850; diagonal = 150; ratio ~ 59; threshold 6.0 -> shake.
  let x = 0;
  for (let i = 0; i < 60; ++i) {
    x = (i % 2 === 0) ? 0 : 150;
    k.update(x, 100, i * dt);
  }
  const s = k.snapshot();
  assert.equal(s.shake, true, 'shake should be detected');
  assert.ok(s.shakeIntensity > 0, 'shakeIntensity > 0');
});

test('kinematics: shake NOT detected on slow linear motion', () => {
  const k = new Kinematics({ shakeWindowMs: 1000, shakeThreshold: 6.0, sampleHz: 60 });
  k.enable();
  const dt = 1000 / 60;
  // Slow linear sweep: trail ~ diagonal (no zigzag), so ratio ~ 1, way
  // below the 6.0 threshold.
  for (let i = 0; i < 60; ++i) k.update(i * 5, 0, i * dt);
  const s = k.snapshot();
  assert.equal(s.shake, false, 'linear motion should NOT trigger shake');
});

test('kinematics: shake NOT detected when bounding box too small (< 100px)', () => {
  const k = new Kinematics({ shakeWindowMs: 1000, shakeThreshold: 6.0, sampleHz: 60 });
  k.enable();
  const dt = 1000 / 60;
  // Tight zigzag within 10px box: lots of trail, but diagonal < 100 ->
  // shake guarded off (small-shake suppression).
  for (let i = 0; i < 60; ++i) {
    const x = (i % 2 === 0) ? 0 : 10;
    k.update(x, 5, i * dt);
  }
  const s = k.snapshot();
  assert.equal(s.shake, false, 'tight zigzag should not count as shake');
});

// --- reset ------------------------------------------------------------------

test('kinematics: reset() clears all state', () => {
  const k = new Kinematics();
  k.enable();
  const dt = 1000 / 60;
  for (let i = 0; i < 6; ++i) k.update(i * 100, 0, i * dt);
  let s = k.snapshot();
  assert.ok(s.speedPxPerSec > 0);
  k.reset();
  s = k.snapshot();
  assert.equal(s.speedPxPerSec, 0);
  assert.equal(s.velocityX, 0);
  assert.equal(s.velocityY, 0);
  assert.equal(s.shake, false);
  assert.equal(s.shakeIntensity, 0);
});

// --- mixed ------------------------------------------------------------------

test('kinematics: velocity unaffected by stationary pause then motion', () => {
  const k = new Kinematics({ velocityWindowMs: 100, sampleHz: 60 });
  k.enable();
  const dt = 1000 / 60;
  // Long stationary period (fills ring with 0,0).
  for (let i = 0; i < 30; ++i) k.update(0, 0, i * dt);
  // Then rapid burst across 6 samples.
  for (let i = 30; i < 36; ++i) k.update((i - 30) * 50, 0, i * dt);
  const s = k.snapshot();
  // Window is 100ms = 6 samples, so the velocity sees only the burst
  // (50px/step at 60Hz = 3000 px/s).
  assert.ok(s.speedPxPerSec > 2000 && s.speedPxPerSec < 4000,
    `expected ~3000 px/s, got ${s.speedPxPerSec}`);
});
