// Pure-unit tests for wl_surface.set_input_region copy semantics.
//
// set_input_region snapshots the region's rect list AT REQUEST TIME, not at
// commit: the spec lets the client destroy the wl_region immediately after the
// request, and an empty region (created, never add()'d) must read as "accept
// nothing" -- not "infinite". Firefox relies on exactly this: it sets an empty
// input region on its content subsurface (so input falls through to the
// toplevel) and destroys the region before committing. A commit-time resource
// lookup loses both cases and wrongly yields an infinite (accept-all) region.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';
import makeRegion from '../packages/core/dist/protocols/wl_region.js';

function makeCtx() {
  const surfaces = new Map();
  const regions = new Map();
  const ctx = {
    state: {
      surfaces,
      regions,
      buffers: new Map(),
      subsurfaces: new Map(),
      subsurfaceOrder: new Map(),
      subsurfacePendingOrder: new Map(),
      compositor: {
        commitSurfaceBuffer: () => true,
        commitSurfaceDmabuf: () => true,
        setSurfaceLayout: () => {},
      },
    },
    events: { wl_buffer: { send_release: () => {} } },
    addon: { postError: () => {} },
  };
  return { ctx, surfaces, regions };
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

test('empty input region destroyed before commit => accept-nothing (not infinite)', () => {
  const { ctx, surfaces } = makeCtx();
  const surf = makeSurface(ctx);
  const region = makeRegion(ctx);
  const sRes = { id: 1 };
  const rec = addSurface(surfaces, sRes, 7);
  const rRes = { id: 2 };

  // Firefox's exact sequence: create region (no add), set as input region,
  // destroy the region, THEN commit.
  surf.set_input_region(sRes, rRes);   // region has no rects yet
  region.destroy(rRes);                // client drops it immediately
  surf.commit(sRes);

  assert.ok(rec.inputRegion, 'applied input region must be a Region, not null/infinite');
  assert.equal(rec.inputRegion.isEmpty(), true, 'empty region accepts nothing');
  assert.equal(rec.inputRegion.contains(5, 5), false);
});

test('non-empty input region destroyed before commit keeps its rects', () => {
  const { ctx, surfaces } = makeCtx();
  const surf = makeSurface(ctx);
  const region = makeRegion(ctx);
  const sRes = { id: 1 };
  const rec = addSurface(surfaces, sRes, 7);
  const rRes = { id: 2 };

  region.add(rRes, 10, 10, 100, 100);
  surf.set_input_region(sRes, rRes);
  region.destroy(rRes);                // copy semantics: destroy is safe
  surf.commit(sRes);

  assert.ok(rec.inputRegion);
  assert.equal(rec.inputRegion.contains(50, 50), true);
  assert.equal(rec.inputRegion.contains(5, 5), false);
});

test('null input region => infinite (accept everywhere)', () => {
  const { ctx, surfaces } = makeCtx();
  const surf = makeSurface(ctx);
  const sRes = { id: 1 };
  const rec = addSurface(surfaces, sRes, 7);

  surf.set_input_region(sRes, null);
  surf.commit(sRes);

  assert.equal(rec.inputRegion, null, 'null region is the infinite region');
});

test('mutating the region after set_input_region does not affect the snapshot', () => {
  const { ctx, surfaces } = makeCtx();
  const surf = makeSurface(ctx);
  const region = makeRegion(ctx);
  const sRes = { id: 1 };
  const rec = addSurface(surfaces, sRes, 7);
  const rRes = { id: 2 };

  region.add(rRes, 0, 0, 100, 100);
  surf.set_input_region(sRes, rRes);   // snapshot taken here
  region.add(rRes, 200, 200, 50, 50);  // post-set mutation, not re-set
  surf.commit(sRes);

  assert.equal(rec.inputRegion.contains(50, 50), true, 'snapshotted rect present');
  assert.equal(rec.inputRegion.contains(220, 220), false, 'post-set rect must NOT leak in');
});
