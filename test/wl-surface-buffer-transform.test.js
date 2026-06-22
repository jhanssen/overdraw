// Pure-unit tests for wl_surface.set_buffer_transform: double-buffered apply
// on commit, propagation to the compositor sink, and silent-drop of
// out-of-range values. The pixel/sampling effect is covered by
// buffer-transform.gpu.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';

function makeCtx() {
  const calls = [];
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
        setSurfaceBufferTransform: (id, t) => calls.push([id, t]),
      },
    },
    events: { wl_buffer: { send_release: () => {} } },
    addon: { postError: (resource, code, msg) => errorCalls.push([code, msg]) },
  };
  return { ctx, calls, errorCalls, surfaces };
}

function addSurface(surfaces, resource, id) {
  const rec = { id, resource, role: null, pending: {}, committed: { buffer: null }, xdgSurface: null };
  surfaces.set(resource, rec);
  return rec;
}

test('set_buffer_transform: double-buffered, applied + pushed on commit', () => {
  const { ctx, calls, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  const rec = addSurface(surfaces, resource, 4);

  h.set_buffer_transform(resource, 3); // 270
  assert.equal(rec.pending.bufferTransform, 3);
  assert.equal(rec.committed.bufferTransform, undefined);
  assert.equal(calls.length, 0);

  h.commit(resource);
  assert.equal(rec.committed.bufferTransform, 3);
  assert.deepEqual(calls, [[4, 3]]);

  // No new transform this cycle keeps the committed value, still pushed.
  h.commit(resource);
  assert.deepEqual(calls, [[4, 3], [4, 3]]);
});

test('set_buffer_transform: out-of-range and non-integer post invalid_transform', () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 2 };
  const rec = addSurface(surfaces, resource, 5);

  for (const bad of [-1, 8, 2.5, NaN]) {
    errorCalls.length = 0;
    h.set_buffer_transform(resource, bad);
    assert.equal(rec.pending.bufferTransform, undefined, `transform ${bad} should not apply`);
    // invalid_transform == 1.
    assert.deepEqual(errorCalls.map((c) => c[0]), [1], `transform ${bad} posts invalid_transform`);
  }
  for (const ok of [0, 1, 7]) {
    errorCalls.length = 0;
    h.set_buffer_transform(resource, ok);
    assert.equal(rec.pending.bufferTransform, ok);
    assert.equal(errorCalls.length, 0);
  }
});
