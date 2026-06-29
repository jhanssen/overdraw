// Pure-unit tests for wl_surface.damage / damage_buffer upload-damage tracking:
// double-buffered accumulation, promotion + buffer-coordinate reconciliation on
// commit, and the conservative full-upload fallbacks. The reconciled rect list
// is observed via the damage argument the surface handler passes to the
// compositor sink's commitSurfaceBuffer. Pixel-level correctness (the undamaged
// region survives a partial upload) is covered by the GPU path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';

function makeCtx() {
  const commits = [];
  const releases = [];
  const surfaces = new Map();
  const buffers = new Map();
  const ctx = {
    state: {
      surfaces,
      buffers,
      subsurfaces: new Map(),
      subsurfaceOrder: new Map(),
      subsurfacePendingOrder: new Map(),
      compositor: {
        commitSurfaceBuffer: (id, poolId, offset, w, h, stride, damage) => {
          commits.push({ id, poolId, offset, w, h, stride, damage });
          return true;
        },
        commitSurfaceDmabuf: () => true,
        setSurfaceLayout: () => {},
      },
    },
    events: { wl_buffer: { send_release: (b) => releases.push(b.id) } },
  };
  return { ctx, commits, releases, surfaces, buffers };
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

// Register an shm buffer descriptor and attach it.
function attachShm(h, ctx, resource, buffer, { width, height, stride }) {
  ctx.state.buffers.set(buffer, { poolId: 1, offset: 0, width, height, stride });
  h.attach(resource, buffer, 0, 0);
}

test('damage_buffer: double-buffered, reconciled to clipped buffer rects on commit', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  const rec = addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 200, height: 100, stride: 800 });
  h.damage_buffer(resource, 10, 20, 30, 40);
  // Pending, not yet applied (double-buffered).
  assert.deepEqual(rec.pending.bufferDamage, [{ x: 10, y: 20, width: 30, height: 40 }]);
  assert.equal(commits.length, 0);

  h.commit(resource);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].damage, [{ x: 10, y: 20, width: 30, height: 40 }]);
  // Consumed: pending + committed damage cleared.
  assert.equal(rec.pending.bufferDamage, undefined);
  assert.equal(rec.committed.bufferDamage, undefined);
});

test('damage_buffer: rects are clipped to buffer bounds', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 100, height: 100, stride: 400 });
  // Overhangs the right/bottom edges; expect clip to 100x100.
  h.damage_buffer(resource, 80, 80, 50, 50);
  h.commit(resource);
  assert.deepEqual(commits[0].damage, [{ x: 80, y: 80, width: 20, height: 20 }]);
});

test('damage (surface-coord) is scaled by buffer_scale into buffer coords', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 200, height: 200, stride: 800 });
  h.set_buffer_scale(resource, 2);
  h.damage(resource, 10, 10, 20, 20); // surface coords
  h.commit(resource);
  // x2 scale -> buffer coords.
  assert.deepEqual(commits[0].damage, [{ x: 20, y: 20, width: 40, height: 40 }]);
});

test('no damage requested -> full upload (undefined damage arg)', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 64, height: 64, stride: 256 });
  h.commit(resource);
  assert.equal(commits[0].damage, undefined);
});

test('surface-coord damage with a non-normal transform -> full upload', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 64, height: 64, stride: 256 });
  h.set_buffer_transform(resource, 1); // 90deg
  h.damage(resource, 0, 0, 10, 10);
  h.commit(resource);
  assert.equal(commits[0].damage, undefined);
});

test('surface-coord damage with an active viewport -> full upload', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  const rec = addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 64, height: 64, stride: 256 });
  rec.viewportSrc = { x: 0, y: 0, width: 32, height: 32 };
  h.damage(resource, 0, 0, 10, 10);
  h.commit(resource);
  assert.equal(commits[0].damage, undefined);
});

test('buffer-coord damage is unaffected by transform/viewport (still optimized)', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  const rec = addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 64, height: 64, stride: 256 });
  h.set_buffer_transform(resource, 3);
  rec.viewportSrc = { x: 0, y: 0, width: 32, height: 32 };
  h.damage_buffer(resource, 5, 5, 10, 10);
  h.commit(resource);
  assert.deepEqual(commits[0].damage, [{ x: 5, y: 5, width: 10, height: 10 }]);
});

test('damage does not persist across commits', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 64, height: 64, stride: 256 });
  h.damage_buffer(resource, 0, 0, 10, 10);
  h.commit(resource);
  assert.deepEqual(commits[0].damage, [{ x: 0, y: 0, width: 10, height: 10 }]);

  // Re-attach (a real new frame) with no new damage: full upload, and the
  // previous commit's damage must NOT carry over.
  h.attach(resource, buffer, 0, 0);
  h.commit(resource);
  assert.equal(commits.length, 2);
  assert.equal(commits[1].damage, undefined);
});

test('a bare commit (no fresh attach) does NOT re-upload or re-release the buffer', () => {
  const { ctx, commits, releases, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 64, height: 64, stride: 256 });
  h.commit(resource);                 // attach + commit -> one upload, one release
  assert.equal(commits.length, 1);
  assert.deepEqual(releases, [100]);

  // A commit with no preceding attach (e.g. a frame-callback-only commit)
  // leaves contents unchanged: no second upload, no second release. A second
  // release here is a protocol violation that crashes shm clients (GDK/cairo).
  h.commit(resource);
  assert.equal(commits.length, 1, 'bare commit must not re-upload');
  assert.deepEqual(releases, [100], 'bare commit must not re-release');

  // A fresh re-attach of the same buffer IS a new frame: upload + release again.
  h.attach(resource, buffer, 0, 0);
  h.commit(resource);
  assert.equal(commits.length, 2);
  assert.deepEqual(releases, [100, 100]);
});

test('too many damage rects -> full upload', () => {
  const { ctx, commits, surfaces } = makeCtx();
  const h = makeSurface(ctx);
  const resource = { id: 1 };
  addSurface(surfaces, resource, 7);
  const buffer = { id: 100 };

  attachShm(h, ctx, resource, buffer, { width: 256, height: 256, stride: 1024 });
  // 17 disjoint rects exceeds the per-commit reconcile cap (16).
  for (let i = 0; i < 17; i++) h.damage_buffer(resource, i * 4, 0, 2, 2);
  h.commit(resource);
  assert.equal(commits[0].damage, undefined);
});
