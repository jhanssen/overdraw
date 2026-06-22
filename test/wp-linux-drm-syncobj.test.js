// Pure-unit tests for wp_linux_drm_syncobj_v1:
//   manager.get_surface marks the wl_surface as explicit-sync (and the second
//     create on the same surface is silently rejected -- spec error
//     surface_exists, no post_error path in this compositor).
//   manager.import_timeline routes the WaylandFd through addon.syncobjImportTimeline
//     and records the resulting handle keyed by the timeline resource.
//   surface.set_acquire_point / set_release_point store the SyncobjPoint
//     keyed by the surface (carrying the timeline's DRM handle, hi/lo).
//   surface.destroy clears syncobjEnabled + drops pending points.
//   timeline.destroy releases the kernel handle via addon.syncobjDestroy.
//
// No GPU work involved -- the tests stub addon.syncobjImportTimeline / Destroy
// to assert the protocol-layer behavior in isolation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSyncobjManager, {
  makeSyncobjTimeline, makeSyncobjSurface,
} from '../packages/core/dist/protocols/wp_linux_drm_syncobj_v1.js';

// Build a minimal Ctx with a stub addon recording syncobj calls.
function makeCtx() {
  const calls = { import: [], destroy: [], error: [] };
  let nextHandle = 100;
  const addon = {
    syncobjImportTimeline(fd) {
      calls.import.push(fd);
      return nextHandle++;
    },
    syncobjDestroy(handle) { calls.destroy.push(handle); },
    postError(resource, code, msg) { calls.error.push([code, msg]); },
    // The remaining members are unused by the handlers under test.
  };
  const state = { surfaces: new Map() };
  const ctx = { state, events: {}, addon };
  return { ctx, state, calls, addon };
}

// Add a surface record to state.surfaces keyed by `resource`.
function addSurface(state, resource, id) {
  state.surfaces.set(resource, {
    id, resource, role: null,
    pending: {}, committed: { buffer: null },
    xdgSurface: null,
  });
}

test('manager.get_surface marks the wl_surface as explicit-sync', () => {
  const { ctx, state } = makeCtx();
  const mgr = makeSyncobjManager(ctx);
  const surfRes = { id: 1 };
  addSurface(state, surfRes, 10);
  const syncobjSurfRes = { id: 2 };
  mgr.get_surface(null, syncobjSurfRes, surfRes);
  assert.equal(state.surfaces.get(surfRes).syncobjEnabled, true);
  assert.equal(state.syncobjSurfaces.get(syncobjSurfRes), surfRes);
  assert.equal(state.syncobjSurfaceBySurface.get(surfRes), syncobjSurfRes);
});

test('manager.get_surface twice on the same wl_surface posts surface_exists', () => {
  const { ctx, state, calls } = makeCtx();
  const mgr = makeSyncobjManager(ctx);
  const surfRes = { id: 1 };
  addSurface(state, surfRes, 10);
  const first = { id: 2 };
  mgr.get_surface(null, first, surfRes);
  const second = { id: 3 };
  mgr.get_surface(null, second, surfRes);
  // The second create posts surface_exists (code 0) and is not recorded: the
  // reverse map still points at the FIRST syncobj-surface.
  assert.equal(state.syncobjSurfaceBySurface.get(surfRes), first);
  assert.equal(state.syncobjSurfaces.has(second), false);
  assert.deepEqual(calls.error.map((c) => c[0]), [0], 'posts surface_exists');
});

test('manager.import_timeline records the addon-returned handle', () => {
  const { ctx, state, calls } = makeCtx();
  const mgr = makeSyncobjManager(ctx);
  const tlRes = { id: 5 };
  const fakeFd = { fd: 42 };
  mgr.import_timeline(null, tlRes, fakeFd);
  assert.equal(calls.import.length, 1);
  assert.equal(calls.import[0], fakeFd);
  assert.equal(state.syncobjTimelines.get(tlRes), 100);
});

test('surface.set_acquire_point stores the SyncobjPoint on the wl_surface', () => {
  const { ctx, state } = makeCtx();
  const mgr = makeSyncobjManager(ctx);
  const surfH = makeSyncobjSurface(ctx);
  const tlH = makeSyncobjTimeline(ctx);
  void tlH;
  const surfRes = { id: 1 };
  addSurface(state, surfRes, 10);
  const syncobjSurfRes = { id: 2 };
  mgr.get_surface(null, syncobjSurfRes, surfRes);
  const tlRes = { id: 3 };
  mgr.import_timeline(null, tlRes, { fd: 42 });

  surfH.set_acquire_point(syncobjSurfRes, tlRes, 0, 7);
  const s = state.surfaces.get(surfRes);
  assert.deepEqual(s.pending.syncobjAcquire, {
    timelineResource: tlRes, handle: 100, pointHi: 0, pointLo: 7,
  });
  // set_release_point at (1, 0) = 0x100000000
  surfH.set_release_point(syncobjSurfRes, tlRes, 1, 0);
  assert.deepEqual(s.pending.syncobjRelease, {
    timelineResource: tlRes, handle: 100, pointHi: 1, pointLo: 0,
  });
});

test('set_acquire_point on a timeline with handle=0 (import failed) stores undefined', () => {
  // Stub the import to return 0 (failure path: invalid_timeline silent-drop).
  const { ctx, state, addon } = makeCtx();
  addon.syncobjImportTimeline = () => 0;
  const mgr = makeSyncobjManager(ctx);
  const surfH = makeSyncobjSurface(ctx);
  const surfRes = { id: 1 };
  addSurface(state, surfRes, 10);
  const syncobjSurfRes = { id: 2 };
  mgr.get_surface(null, syncobjSurfRes, surfRes);
  const tlRes = { id: 3 };
  mgr.import_timeline(null, tlRes, { fd: 42 });

  surfH.set_acquire_point(syncobjSurfRes, tlRes, 0, 5);
  const s = state.surfaces.get(surfRes);
  // pending.syncobjAcquire stays undefined (no fence to wait on); the upload
  // path will fall through to implicit-sync.
  assert.equal(s.pending.syncobjAcquire, undefined);
});

test('surface.destroy clears syncobjEnabled and drops pending points', () => {
  const { ctx, state } = makeCtx();
  const mgr = makeSyncobjManager(ctx);
  const surfH = makeSyncobjSurface(ctx);
  const surfRes = { id: 1 };
  addSurface(state, surfRes, 10);
  const syncobjSurfRes = { id: 2 };
  mgr.get_surface(null, syncobjSurfRes, surfRes);
  const tlRes = { id: 3 };
  mgr.import_timeline(null, tlRes, { fd: 42 });
  surfH.set_acquire_point(syncobjSurfRes, tlRes, 0, 5);

  surfH.destroy(syncobjSurfRes);
  const s = state.surfaces.get(surfRes);
  assert.equal(s.syncobjEnabled, false);
  assert.equal(s.pending.syncobjAcquire, undefined);
  assert.equal(state.syncobjSurfaces.has(syncobjSurfRes), false);
  assert.equal(state.syncobjSurfaceBySurface.has(surfRes), false);
});

test('timeline.destroy calls addon.syncobjDestroy with the handle', () => {
  const { ctx, calls } = makeCtx();
  const mgr = makeSyncobjManager(ctx);
  const tlH = makeSyncobjTimeline(ctx);
  const tlRes = { id: 3 };
  mgr.import_timeline(null, tlRes, { fd: 42 });
  tlH.destroy(tlRes);
  assert.deepEqual(calls.destroy, [100]);
});
