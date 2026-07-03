// Pure-unit tests for wp_presentation feedback routing through the
// synchronized-subsurface commit cache: feedbacks queued while a subsurface
// is sync must survive both cache exits -- the parent-commit cascade and the
// sync->desync flush -- and reach the surface's applied feedback list intact
// (neither dropped nor discarded).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';
import makeWpPresentation, { dispatchPresentationFeedbackForOutput }
  from '../packages/core/dist/protocols/wp_presentation.js';

function makeCtx() {
  const discarded = [];
  const presented = [];
  const destroyed = [];
  const events = {
    wl_buffer: { send_release: () => {} },
    wp_presentation_feedback: {
      send_discarded: (cb) => discarded.push(cb),
      send_presented: (cb) => presented.push(cb),
      send_sync_output: () => {},
    },
  };
  const state = {
    surfaces: new Map(),
    buffers: new Map(),
    subsurfaces: new Map(),
    subsurfaceOrder: new Map(),
    subsurfacePendingOrder: new Map(),
    events,
    compositor: {
      commitSurfaceBuffer: () => true,
      commitSurfaceDmabuf: () => true,
      setSurfaceLayout: () => {},
    },
  };
  const addon = {
    postError: () => {},
    destroyResource: (r) => { r.destroyed = true; destroyed.push(r); },
    clientId: () => 1,
  };
  return { ctx: { state, events, addon }, discarded, presented, destroyed };
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

// Parent (main surface) + one subsurface child in sync mode. Returns the
// records plus the subsurface entry so tests can flip its mode.
function setupTree(ctx) {
  const parentRes = { id: 1 };
  const childRes = { id: 2 };
  const parent = addSurface(ctx.state, parentRes, 10);
  const child = addSurface(ctx.state, childRes, 20);
  const subRes = { id: 3 };
  const sub = {
    resource: subRes, surface: childRes, parent: parentRes,
    sync: true, x: 0, y: 0, pendingX: 0, pendingY: 0,
  };
  ctx.state.subsurfaces.set(subRes, sub);
  return { parent, child, sub, parentRes, childRes };
}

test('sync commit caches queued feedbacks; parent cascade promotes them', () => {
  const { ctx, discarded } = makeCtx();
  const h = makeSurface(ctx);
  const wp = makeWpPresentation(ctx);
  const { child, childRes, parentRes } = setupTree(ctx);

  const cb = { id: 100, destroyed: false };
  wp.feedback({ id: 50 }, childRes, cb);
  assert.deepEqual(child.pending.presentationFeedbacks, [cb]);

  // Sync child commit: feedback moves to the cache, not to applied.
  h.commit(childRes);
  assert.deepEqual(child.cached.presentationFeedbacks, [cb]);
  assert.equal(child.pending.presentationFeedbacks, undefined);
  assert.equal(child.presentationFeedbacks, undefined);

  // Parent commit applies the cache atomically; feedback becomes applied.
  h.commit(parentRes);
  assert.equal(child.cached, undefined);
  assert.deepEqual(child.presentationFeedbacks, [cb]);
  assert.equal(discarded.length, 0);
});

test('sync->desync flush carries cached feedbacks to applied (not dropped)', () => {
  const { ctx, discarded } = makeCtx();
  const h = makeSurface(ctx);
  const wp = makeWpPresentation(ctx);
  const { child, childRes, sub } = setupTree(ctx);

  const cb = { id: 100, destroyed: false };
  wp.feedback({ id: 50 }, childRes, cb);
  h.commit(childRes);
  assert.deepEqual(child.cached.presentationFeedbacks, [cb]);

  // set_desync is effective immediately; the next commit flushes the cache.
  sub.sync = false;
  h.commit(childRes);

  assert.equal(child.cached, undefined);
  assert.deepEqual(child.presentationFeedbacks, [cb],
    'cached feedback survives the desync flush');
  assert.equal(discarded.length, 0, 'no feedback was discarded');
  assert.equal(cb.destroyed, false);
});

test('flushed feedback is delivered by the per-output dispatch', () => {
  const { ctx, presented } = makeCtx();
  const h = makeSurface(ctx);
  const wp = makeWpPresentation(ctx);
  const { child, childRes, sub } = setupTree(ctx);

  const cb = { id: 100, destroyed: false };
  wp.feedback({ id: 50 }, childRes, cb);
  h.commit(childRes);
  sub.sync = false;
  h.commit(childRes);

  dispatchPresentationFeedbackForOutput(ctx.state, ctx.addon, 0, 1n, 0, 1);
  assert.deepEqual(presented, [cb], 'client receives presented after the flush');
  assert.equal(child.presentationFeedbacks, undefined);
});
