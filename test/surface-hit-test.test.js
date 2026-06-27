// Pure-unit tests for the surface-tree hit-test helper. Exercises the
// invariants the seat's pick() relies on:
//   - the topmost subsurface above a root receives input before the root,
//   - sibling order follows subsurfaceOrder (last in list is topmost),
//   - nested subsurfaces above their subsurface parent win,
//   - input region (surface-local) rejects fall through to whatever is below,
//   - a subsurface with no committed buffer is skipped (no logical size),
//   - bufferScale shrinks the surface's logical size,
//   - buffer_transform 1/3/5/7 swaps width/height.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hitTestSurfaceTree } from '../packages/core/dist/surface-hit-test.js';

// Construct a minimal SurfaceRecord with a buffer descriptor in state.buffers.
// `id` is the surface id; `bufW` / `bufH` are buffer dims; `bufferScale` and
// `bufferTransform` default to spec defaults (1 / 0). `inputRegion`:
//   undefined  -- accept whole surface (the "no set_input_region call" state)
//   null       -- explicit infinite
//   { contains: (lx, ly) => boolean } -- custom predicate (Region stand-in)
function makeSurface(state, id, opts = {}) {
  const resource = { id, destroyed: false };
  const surfaceRec = {
    id,
    resource,
    role: opts.role ?? null,
    pending: {},
    committed: {
      buffer: null,
      bufferScale: opts.bufferScale ?? 1,
      bufferTransform: opts.bufferTransform ?? 0,
    },
    xdgSurface: null,
    inputRegion: 'inputRegion' in opts ? opts.inputRegion : undefined,
    hasContent: true,
  };
  if (opts.bufW != null && opts.bufH != null) {
    const buf = { id: 1000 + id };
    surfaceRec.committed.buffer = buf;
    state.buffers ??= new Map();
    state.buffers.set(buf, {
      resource: buf,
      width: opts.bufW,
      height: opts.bufH,
      offset: 0,
      stride: 0,
      format: 0,
    });
  }
  state.surfaces ??= new Map();
  state.surfaces.set(resource, surfaceRec);
  state.surfacesById ??= new Map();
  state.surfacesById.set(id, surfaceRec);
  return surfaceRec;
}

// Attach `child` as a subsurface of `parent` at parent-local offset (x, y).
// Position in the subsurfaceOrder list is at the END (newest on top), which
// matches what wl_subcompositor.get_subsurface does.
function attachSub(state, parent, child, x, y) {
  state.subsurfaces ??= new Map();
  state.subsurfaceOrder ??= new Map();
  const subResource = { id: 5000 + child.id, destroyed: false };
  state.subsurfaces.set(subResource, {
    resource: subResource,
    surface: child.resource,
    parent: parent.resource,
    x, y, pendingX: x, pendingY: y,
    sync: true,
  });
  let order = state.subsurfaceOrder.get(parent.resource);
  if (!order) { order = []; state.subsurfaceOrder.set(parent.resource, order); }
  order.push(subResource);
}

// --- root-only hit ------------------------------------------------------

test('root with no subsurfaces hits at any in-rect point', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  const hit = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 50, 30);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 1);
  assert.deepEqual(hit.rect, { x: 10, y: 10, width: 200, height: 100 });
});

test('root rejects points outside its rect', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  assert.equal(
    hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 5, 50),
    null);
  assert.equal(
    hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 250, 50),
    null);
});

// --- single subsurface above root --------------------------------------

test('subsurface above root receives the hit when point is inside it', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  // 30x30 subsurface at parent-local (5, 5). Buffer size = logical size.
  const child = makeSurface(state, 2, { bufW: 30, bufH: 30 });
  attachSub(state, root, child, 5, 5);
  // Output origin of parent is (10, 10), so child is at (15, 15)..(45, 45).
  const hit = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 20, 20);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 2);
  assert.deepEqual(hit.rect, { x: 15, y: 15, width: 30, height: 30 });
});

test('point inside parent but outside subsurface falls to root', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  const child = makeSurface(state, 2, { bufW: 30, bufH: 30 });
  attachSub(state, root, child, 5, 5);
  // (100, 50) is inside the parent but well outside the 30x30 child at (15,15).
  const hit = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 100, 50);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 1);
});

// --- sibling order ------------------------------------------------------

test('among sibling subsurfaces the last in subsurfaceOrder is topmost', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  // Two overlapping 40x40 children at the same position; the second
  // attached is on top.
  const lower = makeSurface(state, 2, { bufW: 40, bufH: 40 });
  const upper = makeSurface(state, 3, { bufW: 40, bufH: 40 });
  attachSub(state, root, lower, 10, 10);
  attachSub(state, root, upper, 10, 10);
  const hit = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 20, 20);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 3, 'expected upper (last attached) to win');
});

// --- nested subsurfaces -------------------------------------------------

test('a nested subsurface beats its subsurface parent', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  const sub = makeSurface(state, 2, { bufW: 100, bufH: 60 });
  const inner = makeSurface(state, 3, { bufW: 20, bufH: 20 });
  attachSub(state, root, sub, 10, 10);
  attachSub(state, sub, inner, 5, 5);
  // Root at (0, 0). sub at (10, 10). inner at sub-relative (5, 5)
  // = output (15, 15). A hit at (20, 20) is inside inner.
  const hit = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 20, 20);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 3);
  assert.deepEqual(hit.rect, { x: 15, y: 15, width: 20, height: 20 });
});

// --- input regions ------------------------------------------------------

test('subsurface with empty input region falls through to root', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  const child = makeSurface(state, 2, {
    bufW: 30, bufH: 30,
    inputRegion: { contains: () => false }, // explicit empty region
  });
  attachSub(state, root, child, 5, 5);
  // (20, 20) is inside the child rect, but the region rejects it.
  const hit = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 20, 20);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 1, 'expected root to win when child region rejects');
});

test('root with empty input region returns null', () => {
  const state = {};
  const root = makeSurface(state, 1, {
    bufW: 200, bufH: 100,
    inputRegion: { contains: () => false },
  });
  const hit = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 50, 50);
  assert.equal(hit, null);
});

test('subsurface input region accepts only inside its declared rects', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  // Region accepts only (lx, ly) with lx < 10.
  const region = { contains: (lx, _ly) => lx < 10 };
  const child = makeSurface(state, 2, {
    bufW: 30, bufH: 30,
    inputRegion: region,
  });
  attachSub(state, root, child, 5, 5);
  // Child is at output (15, 15)..(45, 45). lx=5 (output 20) -> region accepts.
  const hitInside = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 20, 20);
  assert.ok(hitInside);
  assert.equal(hitInside.surfaceRec.id, 2);
  // lx=15 (output 30) -> region rejects, falls through to root.
  const hitOutside = hitTestSurfaceTree(state, root, { x: 10, y: 10, width: 200, height: 100 }, 30, 20);
  assert.ok(hitOutside);
  assert.equal(hitOutside.surfaceRec.id, 1);
});

// A CSD client draws shadow margins into a buffer larger than the window and
// declares the window sub-rect via xdg_surface.set_window_geometry. Surface-
// local (== buffer) coords are offset from the on-screen content rect by the
// geometry origin, so the input region -- which the client sets in buffer
// coords -- must be hit-tested at (point - rect) + geomOffset. Without the
// offset, the window's top-left strip (width geom.x, height geom.y) is wrongly
// click-through. Matches the offset the seat applies when delivering
// wl_pointer surface-local coords.
test('root input region is hit-tested with the window-geometry offset', () => {
  const state = {};
  const GX = 40, GY = 30, GW = 300, GH = 200;
  const root = makeSurface(state, 1, { bufW: GX + GW + 40, bufH: GY + GH + 40 });
  root.xdgSurface = { geometry: { x: GX, y: GY, width: GW, height: GH } };
  // Input region in BUFFER coords == the geometry (content) rect.
  root.inputRegion = {
    contains: (lx, ly) => lx >= GX && lx < GX + GW && ly >= GY && ly < GY + GH,
  };
  // The content rect is placed on-screen at (100, 100), sized GW x GH.
  const rect = { x: 100, y: 100, width: GW, height: GH };

  // 5px inside the content's top-left: surface-local (GX+5, GY+5) IS inside the
  // input region. Without the offset the check happens at (5, 5) and misses.
  const tl = hitTestSurfaceTree(state, root, rect, 105, 105);
  assert.ok(tl, 'top-left content point must hit (geometry offset applied)');
  assert.equal(tl.surfaceRec.id, 1);

  // Center stays a hit (sanity; this point hits with or without the offset).
  const mid = hitTestSurfaceTree(state, root, rect, 100 + (GW >> 1), 100 + (GH >> 1));
  assert.ok(mid, 'center must hit');
});

// --- size derivation ----------------------------------------------------

test('subsurface with no committed buffer is skipped', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  // No bufW/bufH -> no committed buffer -> no logical size.
  const child = makeSurface(state, 2, {});
  attachSub(state, root, child, 5, 5);
  // Without a buffer the child is invisible to hit-test; root wins.
  const hit = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 10, 10);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 1);
});

test('bufferScale shrinks the subsurface logical size', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  // 60x60 buffer at scale 2 -> 30x30 logical.
  const child = makeSurface(state, 2, { bufW: 60, bufH: 60, bufferScale: 2 });
  attachSub(state, root, child, 0, 0);
  // (29, 29) inside the 30x30 logical extent -> hits child.
  const inside = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 29, 29);
  assert.ok(inside);
  assert.equal(inside.surfaceRec.id, 2);
  // (35, 35) outside the logical extent -> falls to root.
  const outside = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 35, 35);
  assert.ok(outside);
  assert.equal(outside.surfaceRec.id, 1);
});

test('buffer_transform 90deg rotation swaps width/height', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  // 40x20 buffer with transform=1 (90deg) -> logical 20x40.
  const child = makeSurface(state, 2, { bufW: 40, bufH: 20, bufferTransform: 1 });
  attachSub(state, root, child, 0, 0);
  // (15, 35) is inside the rotated logical extent (20x40) but would be
  // outside the unrotated one (40x20 only covers y<20).
  const hit = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 15, 35);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 2);
  // (25, 15) is outside the rotated 20x40 (x >= 20) -> root.
  const miss = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 25, 15);
  assert.ok(miss);
  assert.equal(miss.surfaceRec.id, 1);
});

// --- destroyed surfaces -------------------------------------------------

test('a destroyed subsurface is skipped', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  const child = makeSurface(state, 2, { bufW: 30, bufH: 30 });
  attachSub(state, root, child, 5, 5);
  child.resource.destroyed = true;
  const hit = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 10, 10);
  assert.ok(hit);
  assert.equal(hit.surfaceRec.id, 1);
});

test('a destroyed root returns null', () => {
  const state = {};
  const root = makeSurface(state, 1, { bufW: 200, bufH: 100 });
  root.resource.destroyed = true;
  const hit = hitTestSurfaceTree(state, root, { x: 0, y: 0, width: 200, height: 100 }, 10, 10);
  assert.equal(hit, null);
});
