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
// All addon syncobj calls + the compositor sink are stubs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';

function makeCtx() {
  const events = [];
  const released = [];
  const exported = [];
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
    syncobjTimelineSignal: () => true,
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
    events: { wl_buffer: { send_release: () => {} } },
  };
  return { ctx, events, released, exported, fakeFd };
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
