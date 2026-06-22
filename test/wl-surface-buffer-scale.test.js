// Pure-unit tests for wl_surface.set_buffer_scale: double-buffered apply on
// commit, propagation to the compositor sink, and silent-drop of invalid
// scales. The HiDPI placement consequence (logical size = buffer/scale) is a
// compositor-render concern covered by the GPU path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';

function makeCtx() {
  const scaleCalls = [];
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
        setSurfaceBufferScale: (id, scale) => scaleCalls.push([id, scale]),
      },
    },
    events: { wl_buffer: { send_release: () => {} } },
    addon: { postError: (resource, code, msg) => errorCalls.push([code, msg]) },
  };
  return { ctx, scaleCalls, errorCalls, surfaces };
}

function addSurface(surfaces, resource, id) {
  const rec = {
    id, resource, role: null,
    pending: {}, committed: { buffer: null },
    xdgSurface: null,
  };
  surfaces.set(resource, rec);
  return rec;
}

test('set_buffer_scale: double-buffered, applied + pushed to compositor on commit', () => {
  const { ctx, scaleCalls, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  const rec = addSurface(surfaces, resource, 7);

  h.set_buffer_scale(resource, 2);
  // Pending, not yet applied (double-buffered).
  assert.equal(rec.pending.bufferScale, 2);
  assert.equal(rec.committed.bufferScale, undefined);
  assert.equal(scaleCalls.length, 0);

  h.commit(resource);
  assert.equal(rec.committed.bufferScale, 2);
  assert.equal(rec.pending.bufferScale, undefined);
  assert.deepEqual(scaleCalls, [[7, 2]]);

  // A commit with no new scale keeps the committed value and still pushes it.
  h.commit(resource);
  assert.equal(rec.committed.bufferScale, 2);
  assert.deepEqual(scaleCalls, [[7, 2], [7, 2]]);
});

test('set_buffer_scale: invalid scales post invalid_scale', () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 2 };
  const rec = addSurface(surfaces, resource, 8);

  for (const bad of [0, -1, 1.5, NaN]) {
    errorCalls.length = 0;
    h.set_buffer_scale(resource, bad);
    assert.equal(rec.pending.bufferScale, undefined, `scale ${bad} should not apply`);
    // invalid_scale == 0.
    assert.deepEqual(errorCalls.map((c) => c[0]), [0], `scale ${bad} posts invalid_scale`);
  }
  // A valid one still takes and posts nothing.
  errorCalls.length = 0;
  h.set_buffer_scale(resource, 3);
  assert.equal(rec.pending.bufferScale, 3);
  assert.equal(errorCalls.length, 0);
});
