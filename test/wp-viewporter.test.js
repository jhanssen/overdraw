// Pure-unit tests for wp_viewporter / wp_viewport: one viewport per surface,
// double-buffered set_source/set_destination applied on wl_surface.commit and
// pushed to the compositor sink, value validation, and destroy clearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeSurface from '../packages/core/dist/protocols/wl_surface.js';
import makeViewporter, { makeViewport } from '../packages/core/dist/protocols/wp_viewporter.js';

function makeCtx() {
  const vpCalls = [];
  const surfaces = new Map();
  const ctx = {
    state: {
      surfaces,
      buffers: new Map(),
      subsurfaces: new Map(),
      subsurfaceOrder: new Map(),
      subsurfacePendingOrder: new Map(),
      viewports: new Map(),
      compositor: {
        commitSurfaceBuffer: () => true,
        commitSurfaceDmabuf: () => true,
        setSurfaceLayout: () => {},
        setSurfaceBufferScale: () => {},
        setSurfaceViewport: (id, dst, src) => vpCalls.push([id, dst, src]),
      },
    },
    events: { wl_buffer: { send_release: () => {} } },
  };
  return { ctx, vpCalls, surfaces };
}

function addSurface(surfaces, resource, id) {
  const rec = { id, resource, role: null, pending: {}, committed: { buffer: null }, xdgSurface: null };
  surfaces.set(resource, rec);
  return rec;
}

test('get_viewport binds at most one viewport per surface', () => {
  const { ctx, surfaces } = makeCtx();
  const mgr = makeViewporter(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const vp = { id: 2 };
  mgr.get_viewport(null, vp, surf);
  assert.equal(rec.hasViewport, true);
  assert.equal(ctx.state.viewports.get(vp), surf);
  // second viewport on the same surface is rejected (viewport_exists)
  const vp2 = { id: 3 };
  mgr.get_viewport(null, vp2, surf);
  assert.equal(ctx.state.viewports.has(vp2), false);
});

test('set_destination: double-buffered, applied + pushed on commit', () => {
  const { ctx, vpCalls, surfaces } = makeCtx();
  const sh = makeSurface(ctx);
  const mgr = makeViewporter(ctx);
  const vh = makeViewport(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const vp = { id: 2 };
  mgr.get_viewport(null, vp, surf);

  vh.set_destination(vp, 800, 600);
  assert.deepEqual(rec.pending.viewportDst, { width: 800, height: 600 });
  assert.equal(vpCalls.length, 0); // not applied until commit

  sh.commit(surf);
  assert.deepEqual(rec.viewportDst, { width: 800, height: 600 });
  assert.deepEqual(vpCalls.at(-1), [5, { width: 800, height: 600 }, null]);
});

test('set_source: validation + unset', () => {
  const { ctx, surfaces } = makeCtx();
  const mgr = makeViewporter(ctx);
  const vh = makeViewport(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const vp = { id: 2 };
  mgr.get_viewport(null, vp, surf);

  vh.set_source(vp, 10, 20, 100, 50);
  assert.deepEqual(rec.pending.viewportSrc, { x: 10, y: 20, width: 100, height: 50 });
  // non-positive size is bad_value -> dropped, previous value stays
  vh.set_source(vp, 0, 0, 0, 0);
  assert.deepEqual(rec.pending.viewportSrc, { x: 10, y: 20, width: 100, height: 50 });
  // all -1 -> unset
  vh.set_source(vp, -1, -1, -1, -1);
  assert.equal(rec.pending.viewportSrc, null);
  // destination -1,-1 -> unset
  vh.set_destination(vp, -1, -1);
  assert.equal(rec.pending.viewportDst, null);
});

test('destroy clears viewport on next commit', () => {
  const { ctx, vpCalls, surfaces } = makeCtx();
  const sh = makeSurface(ctx);
  const mgr = makeViewporter(ctx);
  const vh = makeViewport(ctx);
  const surf = { id: 1 };
  const rec = addSurface(surfaces, surf, 5);
  const vp = { id: 2 };
  mgr.get_viewport(null, vp, surf);
  vh.set_destination(vp, 800, 600);
  sh.commit(surf);

  vh.destroy(vp);
  assert.equal(rec.hasViewport, false);
  assert.equal(rec.pending.viewportDst, null);
  sh.commit(surf);
  assert.equal(rec.viewportDst, null);
  assert.deepEqual(vpCalls.at(-1), [5, null, null]);
});
