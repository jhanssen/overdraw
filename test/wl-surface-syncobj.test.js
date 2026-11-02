// Pure-unit tests for the wp_linux_drm_syncobj_v1 wiring through
// wl_surface.commit:
//   - acquire/release points are promoted (and consumed) on commit when a
//     dmabuf is attached; the acquire point is exported as a sync_file and
//     passed to commitSurfaceDmabuf; the release point is queued for the
//     GPU-completion path via queueSurfaceReleasePoint.
//   - acquire/release points are DROPPED when the committed buffer is shm
//     (explicit-sync is undefined there; spec's unsupported_buffer).
//   - acquire/release points are DROPPED when no buffer is attached
//     (spec's no_buffer).
//   - points do not persist across commits (one-shot per spec).
//
//   - synchronized subsurfaces: cached points ride the parent-commit cascade,
//     and a cached commit superseded before the parent commits has its
//     release point signaled and its wl_buffer released.
//
// All addon syncobj calls + the compositor sink are stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';

function makeCtx() {
  const events = [];
  const released = [];
  const exported = [];
  const signaled = [];
  const wlReleased = [];
  const fakeFd = (raw) => ({
    fd: raw, closed: false,
    close() { this.closed = true; },
    takeRawFd() { const f = this.fd; this.fd = -1; this.closed = true; return f; },
    dup() { return fakeFd(this.fd); },
    readAll: async () => new Uint8Array(),
    write: async () => 0,
  });
  const addon = {
    syncobjImportTimeline: () => 100,
    syncobjDestroy: () => {},
    syncobjExportSyncFile(handle, hi, lo) {
      exported.push({ handle, hi, lo });
      return fakeFd(123 + exported.length);  // stable, distinguishable
    },
    syncobjTimelineSignal(handle, hi, lo) {
      signaled.push({ handle, hi, lo });
      return true;
    },
  };
  const surfaces = new Map();
  const buffers = new Map();
  const ctx = {
    state: {
      surfaces, buffers,
      subsurfaces: new Map(),
      subsurfaceOrder: new Map(),
      subsurfacePendingOrder: new Map(),
      compositor: {
        commitSurfaceBuffer: () => true,
        commitSurfaceDmabuf(id, fd, w, h, fourcc, modHi, modLo, off, stride,
                            bufferId, acquireFenceFd) {
          events.push({
            kind: 'dmabuf', id, bufferId,
            acquireFenceFd: acquireFenceFd ?? null,
          });
          return true;
        },
        setSurfaceLayout: () => {},
        setSurfaceBufferScale: () => {},
        setSurfaceBufferTransform: () => {},
        setBufferReleasePoint(bufferId, handle, hi, lo) {
          released.push({ bufferId, handle, hi, lo });
        },
      },
    },
    addon,
    events: { wl_buffer: { send_release: (b) => wlReleased.push(b) } },
  };
  return { ctx, events, released, exported, signaled, wlReleased, fakeFd };
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

function setDmabufBuffer(state, surface, bufferResource) {
  state.buffers.set(bufferResource, {
    resource: bufferResource, dmabuf: true,
    fd: { fd: 7, closed: false }, offset: 0, stride: 1024,
    width: 256, height: 256, format: 0,
  });
  surface.pending.buffer = bufferResource;
}

function setShmBuffer(state, surface, bufferResource) {
  state.buffers.set(bufferResource, {
    resource: bufferResource, dmabuf: false, poolId: 99,
    offset: 0, stride: 1024, width: 256, height: 256, format: 0,
  });
  surface.pending.buffer = bufferResource;
}

test('dmabuf commit with acquire+release points: fence exported, release queued', () => {
  const { ctx, events, released, exported } = makeCtx();
  const h = makeSurface(ctx);
  const surfRes = { id: 1 };
  const rec = addSurface(ctx.state, surfRes, 7);
  const bufRes = { id: 2, destroyed: false };
  setDmabufBuffer(ctx.state, rec, bufRes);
  rec.pending.syncobjAcquire = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 5,
  };
  rec.pending.syncobjRelease = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 6,
  };
  h.commit(surfRes);
  // Acquire exported once, fence handed to commitSurfaceDmabuf.
  assert.deepEqual(exported, [{ handle: 100, hi: 0, lo: 5 }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'dmabuf');
  assert.notEqual(events[0].acquireFenceFd, null);
  // Release queued for the surface.
  // Release recorded keyed by bufferId (the wire layer's stable id), with
  // the same handle / point the client set.
  assert.equal(released.length, 1);
  assert.equal(released[0].handle, 100);
  assert.equal(released[0].hi, 0);
  assert.equal(released[0].lo, 6);
  assert.ok(released[0].bufferId > 0, 'bufferId assigned');
  // Pending points cleared (one-shot per spec).
  assert.equal(rec.pending.syncobjAcquire, undefined);
  assert.equal(rec.pending.syncobjRelease, undefined);
  // committed.syncobjRelease is cleared after uploadBuffer registers the
  // point with the compositor (so a follow-up commit without new points
  // does not re-register the stale value). The release point lives on the
  // compositor's bufferId-keyed map from that point on.
  assert.equal(rec.committed.syncobjRelease, undefined);
});

test('shm commit with syncobj points: points dropped, no fence exported', () => {
  const { ctx, events, released, exported } = makeCtx();
  const h = makeSurface(ctx);
  const surfRes = { id: 1 };
  const rec = addSurface(ctx.state, surfRes, 7);
  const bufRes = { id: 2, destroyed: false };
  setShmBuffer(ctx.state, rec, bufRes);
  rec.pending.syncobjAcquire = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 5,
  };
  rec.pending.syncobjRelease = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 6,
  };
  h.commit(surfRes);
  assert.deepEqual(exported, []);
  assert.deepEqual(released, []);
  // Pending is still cleared (the promotion ran; it just elected not to honor).
  assert.equal(rec.pending.syncobjAcquire, undefined);
  assert.equal(rec.pending.syncobjRelease, undefined);
  assert.equal(rec.committed.syncobjRelease, undefined);
  // The shm commit itself still happened (a single commitSurfaceBuffer call;
  // not tracked in events since the stub returns true and we wired
  // commitSurfaceBuffer above as a no-op tracker).
});

test('no-buffer commit with syncobj points: points dropped', () => {
  const { ctx, events, released, exported } = makeCtx();
  const h = makeSurface(ctx);
  const surfRes = { id: 1 };
  const rec = addSurface(ctx.state, surfRes, 7);
  rec.pending.syncobjAcquire = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 5,
  };
  rec.pending.syncobjRelease = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 6,
  };
  h.commit(surfRes);
  assert.deepEqual(events, []);
  assert.deepEqual(exported, []);
  assert.deepEqual(released, []);
  assert.equal(rec.pending.syncobjAcquire, undefined);
  assert.equal(rec.pending.syncobjRelease, undefined);
});

test('points are one-shot: a follow-up dmabuf commit with no new points does not re-export', () => {
  const { ctx, events, released, exported } = makeCtx();
  const h = makeSurface(ctx);
  const surfRes = { id: 1 };
  const rec = addSurface(ctx.state, surfRes, 7);
  const buf1 = { id: 2, destroyed: false };
  setDmabufBuffer(ctx.state, rec, buf1);
  rec.pending.syncobjAcquire = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 5,
  };
  rec.pending.syncobjRelease = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: 6,
  };
  h.commit(surfRes);
  // Second commit: new buffer attached, no syncobj points -- per spec the
  // implicit-sync fallback engages.
  const buf2 = { id: 4, destroyed: false };
  setDmabufBuffer(ctx.state, rec, buf2);
  h.commit(surfRes);
  assert.equal(exported.length, 1);
  assert.equal(released.length, 1);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].acquireFenceFd, null);
  assert.equal(events[1].acquireFenceFd, null);
});

// Parent (main surface) + one subsurface child in sync mode.
function setupSyncTree(state) {
  const parentRes = { id: 10 };
  const childRes = { id: 11 };
  addSurface(state, parentRes, 70);
  const child = addSurface(state, childRes, 71);
  state.subsurfaces.set({ id: 12 }, {
    surface: childRes, parent: parentRes,
    sync: true, x: 0, y: 0, pendingX: 0, pendingY: 0,
  });
  return { parentRes, childRes, child };
}

function setPoints(rec, acqLo, relLo) {
  rec.pending.syncobjAcquire = {
    timelineResource: { id: 3 }, handle: 100, pointHi: 0, pointLo: acqLo,
  };
  rec.pending.syncobjRelease = {
    timelineResource: { id: 3 }, handle: 200, pointHi: 0, pointLo: relLo,
  };
}

test('sync subsurface: cached points are promoted by the parent-commit cascade', () => {
  const { ctx, events, released, exported, signaled } = makeCtx();
  const h = makeSurface(ctx);
  const { parentRes, childRes, child } = setupSyncTree(ctx.state);
  const buf = { id: 20, destroyed: false };
  setDmabufBuffer(ctx.state, child, buf);
  setPoints(child, 1, 1);
  h.commit(childRes);
  assert.deepEqual(events, [], 'sync child commit is cached, not applied');
  assert.deepEqual(released, []);

  h.commit(parentRes);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 71);
  assert.notEqual(events[0].acquireFenceFd, null, 'acquire fence carried');
  assert.deepEqual(exported, [{ handle: 100, hi: 0, lo: 1 }]);
  assert.equal(released.length, 1);
  assert.equal(released[0].bufferId, events[0].bufferId);
  assert.equal(released[0].handle, 200);
  assert.equal(released[0].lo, 1);
  assert.deepEqual(signaled, [], 'applied buffer is released by the GPU path, not here');
});

test('sync subsurface: a superseded cached commit releases its buffer and point', () => {
  const { ctx, events, released, signaled, wlReleased } = makeCtx();
  const h = makeSurface(ctx);
  const { parentRes, childRes, child } = setupSyncTree(ctx.state);
  const bufs = [1, 2, 3].map((i) => ({ id: 20 + i, destroyed: false }));
  bufs.forEach((b, i) => {
    setDmabufBuffer(ctx.state, child, b);
    setPoints(child, i + 1, i + 1);
    h.commit(childRes);
  });
  assert.deepEqual(events, [], 'parent has not committed');
  assert.deepEqual(signaled, [
    { handle: 200, hi: 0, lo: 1 },
    { handle: 200, hi: 0, lo: 2 },
  ]);
  assert.deepEqual(wlReleased, [bufs[0], bufs[1]]);

  h.commit(parentRes);
  assert.equal(events.length, 1, 'only the latest cached buffer is applied');
  assert.equal(released.length, 1);
  assert.equal(released[0].lo, 3);
});

test('sync subsurface: re-attaching the cached buffer signals the old point but keeps the buffer', () => {
  const { ctx, signaled, wlReleased } = makeCtx();
  const h = makeSurface(ctx);
  const { childRes, child } = setupSyncTree(ctx.state);
  const buf = { id: 30, destroyed: false };
  setDmabufBuffer(ctx.state, child, buf);
  setPoints(child, 1, 1);
  h.commit(childRes);
  child.pending.buffer = buf;
  setPoints(child, 2, 2);
  h.commit(childRes);
  assert.deepEqual(signaled, [{ handle: 200, hi: 0, lo: 1 }]);
  assert.deepEqual(wlReleased, []);
});

test('sync subsurface: a superseded cached shm buffer is released', () => {
  const { ctx, signaled, wlReleased } = makeCtx();
  const h = makeSurface(ctx);
  const { childRes, child } = setupSyncTree(ctx.state);
  const shm1 = { id: 40, destroyed: false };
  const shm2 = { id: 41, destroyed: false };
  setShmBuffer(ctx.state, child, shm1);
  h.commit(childRes);
  setShmBuffer(ctx.state, child, shm2);
  h.commit(childRes);
  assert.deepEqual(wlReleased, [shm1]);
  assert.deepEqual(signaled, []);
});

test('sync subsurface: a commit without an attach leaves the cached buffer alone', () => {
  const { ctx, signaled, wlReleased } = makeCtx();
  const h = makeSurface(ctx);
  const { childRes, child } = setupSyncTree(ctx.state);
  setDmabufBuffer(ctx.state, child, { id: 50, destroyed: false });
  setPoints(child, 1, 1);
  h.commit(childRes);
  h.commit(childRes);
  assert.deepEqual(signaled, []);
  assert.deepEqual(wlReleased, []);
});
