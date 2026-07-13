// Pure-unit tests for commit-timing-v1: the wp_commit_timing_manager_v1 /
// wp_commit_timer_v1 request handlers (error paths) and the timed-commit
// queue in wl_surface.commit -- a commit carrying a future timestamp is not
// latched before that time, and later commits (timed or not) latch behind
// it in order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import makeSurface, { unmapAndTeardownSurface } from '../packages/core/dist/protocols/wl_surface.js';
import makeCommitTimingManager, { makeCommitTimer }
  from '../packages/core/dist/protocols/wp_commit_timing_v1.js';

function makeCtx() {
  const errors = [];
  const latched = [];   // offsets passed to commitSurfaceBuffer, in latch order
  const discarded = [];
  const wakes = { count: 0 };
  const events = {
    wl_buffer: { send_release: () => {} },
    wp_presentation_feedback: {
      send_discarded: (cb) => discarded.push(cb),
      send_presented: () => {},
      send_sync_output: () => {},
    },
  };
  const state = {
    surfaces: new Map(),
    buffers: new Map(),
    subsurfaces: new Map(),
    events,
    compositor: {
      commitSurfaceBuffer: (_id, _poolId, offset) => { latched.push(offset); return true; },
      commitSurfaceDmabuf: () => true,
      setSurfaceLayout: () => {},
    },
  };
  const addon = {
    postError: (resource, code, message) => errors.push({ resource, code, message }),
    destroyResource: (r) => { r.destroyed = true; },
    clientId: () => 1,
    wake: () => { wakes.count++; },
  };
  return { ctx: { state, events, addon }, errors, latched, discarded, wakes };
}

function addSurface(state, resource, id) {
  const rec = {
    id, resource, role: null,
    pending: {}, committed: { buffer: null },
    xdgSurface: null,
  };
  state.surfaces.set(resource, rec);
  return rec;
}

// A distinct shm buffer whose pool offset tags it in the latch log.
function addBuffer(state, offset) {
  const buf = { id: 1000 + offset, destroyed: false };
  state.buffers.set(buf, { poolId: 1, offset, width: 4, height: 4, stride: 16 });
  return buf;
}

// tv_sec_hi/lo + tv_nsec for "CLOCK_MONOTONIC now + deltaMs".
function timestampIn(deltaMs) {
  const ns = process.hrtime.bigint() + BigInt(deltaMs) * 1_000_000n;
  const sec = ns / 1_000_000_000n;
  return {
    hi: Number(sec >> 32n),
    lo: Number(sec & 0xffffffffn),
    nsec: Number(ns % 1_000_000_000n),
  };
}

test('get_timer: second timer on the same surface posts commit_timer_exists', () => {
  const { ctx, errors } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const surfRes = { id: 1 };
  addSurface(ctx.state, surfRes, 10);

  const mgrRes = { id: 2 };
  mgr.get_timer(mgrRes, { id: 3 }, surfRes);
  assert.equal(errors.length, 0);
  mgr.get_timer(mgrRes, { id: 4 }, surfRes);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 0, 'commit_timer_exists');
  assert.equal(errors[0].resource, mgrRes, 'error posted on the manager');
});

test('timer destroy frees the one-per-surface slot', () => {
  const { ctx, errors } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surfRes = { id: 1 };
  addSurface(ctx.state, surfRes, 10);

  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);
  timer.destroy(timerRes);
  mgr.get_timer({ id: 2 }, { id: 4 }, surfRes);
  assert.equal(errors.length, 0, 'no commit_timer_exists after destroy');
});

test('set_timestamp: invalid tv_nsec posts invalid_timestamp', () => {
  const { ctx, errors } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surfRes = { id: 1 };
  addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  timer.set_timestamp(timerRes, 0, 1, 1_000_000_000);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 0, 'invalid_timestamp');
  assert.equal(errors[0].resource, timerRes);
});

test('set_timestamp: second timestamp before commit posts timestamp_exists', () => {
  const { ctx, errors } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surfRes = { id: 1 };
  addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  timer.set_timestamp(timerRes, 0, 1, 0);
  assert.equal(errors.length, 0);
  timer.set_timestamp(timerRes, 0, 2, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 1, 'timestamp_exists');
});

test('set_timestamp after the surface is destroyed posts surface_destroyed', () => {
  const { ctx, errors } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surface = makeSurface(ctx);
  const surfRes = { id: 1, destroyed: false };
  addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  surface.destroy(surfRes);
  timer.set_timestamp(timerRes, 0, 1, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 2, 'surface_destroyed');
});

test('a commit with a future timestamp latches at the target time, not at commit', async () => {
  const { ctx, latched } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surface = makeSurface(ctx);
  const surfRes = { id: 1 };
  const s = addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  const buf = addBuffer(ctx.state, 0);
  const t = timestampIn(40);
  timer.set_timestamp(timerRes, t.hi, t.lo, t.nsec);
  surface.attach(surfRes, buf, 0, 0);
  const cb = { id: 100, destroyed: false };
  surface.frame(surfRes, cb);
  surface.commit(surfRes);

  assert.equal(latched.length, 0, 'buffer not latched at commit time');
  assert.equal(s.frameCallbacks, undefined, 'frame callback not armed early');
  assert.equal(s.timedCommits.length, 1);

  await sleep(80);
  assert.deepEqual(latched, [0], 'buffer latched after the target time');
  assert.deepEqual(s.frameCallbacks, [cb], 'frame callback armed with the latch');
  assert.equal(s.timedCommits, undefined, 'queue drained');
});

test('a commit with a past timestamp latches immediately', () => {
  const { ctx, latched } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surface = makeSurface(ctx);
  const surfRes = { id: 1 };
  const s = addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  const buf = addBuffer(ctx.state, 0);
  const t = timestampIn(-5);
  timer.set_timestamp(timerRes, t.hi, t.lo, t.nsec);
  surface.attach(surfRes, buf, 0, 0);
  surface.commit(surfRes);

  assert.deepEqual(latched, [0], 'latched synchronously');
  assert.equal(s.timedCommits, undefined, 'nothing queued');
});

test('an untimed commit behind a queued timed commit latches after it, in order', async () => {
  const { ctx, latched } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surface = makeSurface(ctx);
  const surfRes = { id: 1 };
  addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  const bufA = addBuffer(ctx.state, 16);
  const bufB = addBuffer(ctx.state, 32);
  const t = timestampIn(40);
  timer.set_timestamp(timerRes, t.hi, t.lo, t.nsec);
  surface.attach(surfRes, bufA, 0, 0);
  surface.commit(surfRes);
  // Untimed follow-up: must not jump ahead of the queued timed commit.
  surface.attach(surfRes, bufB, 0, 0);
  surface.commit(surfRes);

  assert.equal(latched.length, 0, 'both commits held');
  await sleep(80);
  assert.deepEqual(latched, [16, 32], 'latched in commit order once the time passed');
});

test('a deferred latch wakes the frame loop; queueing/re-arming alone does not', async () => {
  const { ctx, latched, wakes } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surface = makeSurface(ctx);
  const surfRes = { id: 1 };
  addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  const buf = addBuffer(ctx.state, 0);
  const t = timestampIn(40);
  timer.set_timestamp(timerRes, t.hi, t.lo, t.nsec);
  surface.attach(surfRes, buf, 0, 0);
  surface.commit(surfRes);

  // Queued, timer armed, nothing latched: the frame loop must NOT be woken
  // (a static surface with a far-future commit stays idle until then).
  assert.equal(latched.length, 0);
  assert.equal(wakes.count, 0, 'no wake while the commit is only queued');

  // The latch fires from a timer callback, outside any native-event wake --
  // it must request a frame itself or the applied commit never renders and
  // the client never gets its frame callback (the "animates only on input"
  // stall). One wake per pump, not periodic.
  await sleep(80);
  assert.deepEqual(latched, [0]);
  assert.equal(wakes.count, 1, 'exactly one wake for the deferred latch');
  await sleep(40);
  assert.equal(wakes.count, 1, 'no further wakes once the queue is drained');
});

test('teardown discards queued commits and fires discarded on captured feedbacks', () => {
  const { ctx, latched, discarded, wakes } = makeCtx();
  const mgr = makeCommitTimingManager(ctx);
  const timer = makeCommitTimer(ctx);
  const surface = makeSurface(ctx);
  const surfRes = { id: 1, destroyed: false };
  const s = addSurface(ctx.state, surfRes, 10);
  const timerRes = { id: 3 };
  mgr.get_timer({ id: 2 }, timerRes, surfRes);

  const buf = addBuffer(ctx.state, 0);
  const t = timestampIn(10_000);
  timer.set_timestamp(timerRes, t.hi, t.lo, t.nsec);
  surface.attach(surfRes, buf, 0, 0);
  const fb = { id: 200, destroyed: false };
  s.pending.presentationFeedbacks = [fb];
  surface.commit(surfRes);
  assert.equal(s.timedCommits.length, 1);

  unmapAndTeardownSurface(ctx.state, ctx.addon, s);
  assert.equal(s.timedCommits, undefined, 'queue dropped');
  assert.deepEqual(discarded, [fb], 'captured feedback got discarded');
  assert.equal(latched.length, 0, 'held content never latched');
  assert.equal(wakes.count, 0, 'a discard latches nothing and must not wake');
});
