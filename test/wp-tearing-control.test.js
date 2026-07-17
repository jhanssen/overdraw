// Pure-unit tests for wp_tearing_control_manager_v1 / wp_tearing_control_v1:
// one tearing-control object per surface, double-buffered presentation hint
// applied on wl_surface.commit and pushed to the compositor sink, destroy
// reverting the hint to vsync on the next commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';
import makeTearingControlManager, { makeTearingControl } from '../packages/core/dist/protocols/wp_tearing_control_v1.js';

const HINT_VSYNC = 0;
const HINT_ASYNC = 1;

function makeCtx() {
  const tearCalls = [];
  const errorCalls = [];
  const surfaces = new Map();
  const ctx = {
    state: {
      surfaces,
      buffers: new Map(),
      subsurfaces: new Map(),
      subsurfaceOrder: new Map(),
      subsurfacePendingOrder: new Map(),
      compositor: {
        commitSurfaceBuffer: () => true,
        commitSurfaceDmabuf: () => true,
        setSurfaceLayout: () => {},
        setSurfaceBufferScale: () => {},
        setSurfaceTearing: (id, async) => tearCalls.push([id, async]),
      },
    },
    events: { wl_buffer: { send_release: () => {} } },
    addon: { postError: (resource, code, msg) => errorCalls.push([code, msg]) },
  };
  return { ctx, tearCalls, errorCalls, surfaces };
}

function addSurface(surfaces, resource, id) {
  const rec = { id, resource, role: null, pending: {}, committed: { buffer: null }, xdgSurface: null };
  surfaces.set(resource, rec);
  return rec;
}

test('get_tearing_control binds at most one object per surface', () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const mgr = makeTearingControlManager(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const tc = { id: 2 };
  mgr.get_tearing_control(null, tc, surf);
  assert.equal(rec.hasTearingControl, true);
  assert.equal(ctx.state.tearingControls.get(tc), surf);
  // second object on the same surface is rejected (tearing_control_exists, code 0)
  const tc2 = { id: 3 };
  mgr.get_tearing_control(null, tc2, surf);
  assert.equal(ctx.state.tearingControls.has(tc2), false);
  assert.deepEqual(errorCalls.map((c) => c[0]), [0], 'second get_tearing_control posts tearing_control_exists');
});

test('set_presentation_hint: double-buffered, applied + pushed on commit', () => {
  const { ctx, tearCalls, surfaces } = makeCtx();
  const sh = makeSurface(ctx);
  const mgr = makeTearingControlManager(ctx);
  const th = makeTearingControl(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const tc = { id: 2 };
  mgr.get_tearing_control(null, tc, surf);

  th.set_presentation_hint(tc, HINT_ASYNC);
  assert.equal(rec.pending.tearingHint, HINT_ASYNC);
  assert.equal(tearCalls.length, 0); // not applied until commit

  sh.commit(surf);
  assert.equal(rec.tearingHint, HINT_ASYNC);
  assert.deepEqual(tearCalls.at(-1), [5, true]);

  // back to vsync
  th.set_presentation_hint(tc, HINT_VSYNC);
  sh.commit(surf);
  assert.equal(rec.tearingHint, HINT_VSYNC);
  assert.deepEqual(tearCalls.at(-1), [5, false]);
});

test('unknown hint values are treated as vsync', () => {
  const { ctx, surfaces } = makeCtx();
  const mgr = makeTearingControlManager(ctx);
  const th = makeTearingControl(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const tc = { id: 2 };
  mgr.get_tearing_control(null, tc, surf);
  th.set_presentation_hint(tc, 7);
  assert.equal(rec.pending.tearingHint, HINT_VSYNC);
});

test('a no-hint commit leaves the applied hint unchanged and pushes nothing', () => {
  const { ctx, tearCalls, surfaces } = makeCtx();
  const sh = makeSurface(ctx);
  const mgr = makeTearingControlManager(ctx);
  const th = makeTearingControl(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const tc = { id: 2 };
  mgr.get_tearing_control(null, tc, surf);
  th.set_presentation_hint(tc, HINT_ASYNC);
  sh.commit(surf);
  const pushes = tearCalls.length;

  sh.commit(surf); // bare commit: hint unchanged
  assert.equal(rec.tearingHint, HINT_ASYNC);
  assert.equal(tearCalls.length, pushes, 'no re-push on a commit without a hint change');
});

test('destroy reverts the hint to vsync on the next commit', () => {
  const { ctx, tearCalls, surfaces } = makeCtx();
  const sh = makeSurface(ctx);
  const mgr = makeTearingControlManager(ctx);
  const th = makeTearingControl(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const tc = { id: 2 };
  mgr.get_tearing_control(null, tc, surf);
  th.set_presentation_hint(tc, HINT_ASYNC);
  sh.commit(surf);
  assert.deepEqual(tearCalls.at(-1), [5, true]);

  th.destroy(tc);
  assert.equal(rec.hasTearingControl, false);
  assert.equal(ctx.state.tearingControls.has(tc), false);
  assert.equal(rec.pending.tearingHint, HINT_VSYNC); // applies on next commit
  assert.equal(rec.tearingHint, HINT_ASYNC, 'applied hint unchanged until the commit');
  sh.commit(surf);
  assert.equal(rec.tearingHint, HINT_VSYNC);
  assert.deepEqual(tearCalls.at(-1), [5, false]);

  // the freed slot can be re-bound
  const tc2 = { id: 3 };
  mgr.get_tearing_control(null, tc2, surf);
  assert.equal(rec.hasTearingControl, true);
});
