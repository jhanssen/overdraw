// Pure-unit tests for makeSubsurfaceAccessor -- the single channel by which the
// compositor learns the subsurface tree (it derives absolute child placement +
// cascades fx over the subtree from this). Verifies the accessor returns each
// parent's direct children in draw order with their parent-relative offsets,
// skips content-less / destroyed children, and reflects nesting (children are
// per-parent, so the compositor recurses).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeSubsurfaceAccessor } from '../packages/core/dist/subsurfaces.js';

// Build a CompositorState with a subsurface tree. `nodes` is a list of
// { id, parent?, offX?, offY?, hasContent?, destroyed? }. A node with no
// parent is a root (e.g. a toplevel). Order in the list = get_subsurface
// order = the parent's child draw order (bottom-to-top).
function build(nodes) {
  const surfaces = new Map();      // Resource -> SurfaceRecord
  const surfacesById = new Map();  // id -> SurfaceRecord
  const subsurfaces = new Map();   // subResource -> SubsurfaceRecord
  const subsurfaceOrder = new Map(); // parentResource -> [subResource...]
  const resOf = new Map();         // id -> Resource (stable identity)

  const res = (id) => {
    if (!resOf.has(id)) resOf.set(id, { __id: id, destroyed: false });
    return resOf.get(id);
  };

  for (const n of nodes) {
    const resource = res(n.id);
    resource.destroyed = n.destroyed ?? false;
    const rec = { id: n.id, resource, hasContent: n.hasContent ?? true };
    surfaces.set(resource, rec);      // keyed by the SAME resource object
    surfacesById.set(n.id, rec);
  }
  for (const n of nodes) {
    if (n.parent === undefined) continue;
    const subResource = { __sub: n.id };
    subsurfaces.set(subResource, {
      resource: subResource, surface: res(n.id), parent: res(n.parent),
      x: n.offX ?? 0, y: n.offY ?? 0, pendingX: 0, pendingY: 0, sync: true,
    });
    const list = subsurfaceOrder.get(res(n.parent)) ?? [];
    list.push(subResource);
    subsurfaceOrder.set(res(n.parent), list);
  }
  return { surfaces, surfacesById, subsurfaces, subsurfaceOrder };
}

test('direct children returned with offsets, in draw order', () => {
  const state = build([
    { id: 1 },                              // toplevel
    { id: 20, parent: 1, offX: 5, offY: 7 },
    { id: 21, parent: 1, offX: 30, offY: 0 },
  ]);
  const acc = makeSubsurfaceAccessor(state);
  assert.deepEqual(acc.children(1), [
    { id: 20, offX: 5, offY: 7 },
    { id: 21, offX: 30, offY: 0 },
  ]);
});

test('content-less and destroyed children are skipped', () => {
  const state = build([
    { id: 1 },
    { id: 20, parent: 1, offX: 5, offY: 7 },
    { id: 21, parent: 1, hasContent: false },
    { id: 22, parent: 1, destroyed: true },
  ]);
  const acc = makeSubsurfaceAccessor(state);
  assert.deepEqual(acc.children(1), [{ id: 20, offX: 5, offY: 7 }]);
});

test('nested subsurfaces are per-parent (compositor recurses)', () => {
  const state = build([
    { id: 1 },
    { id: 20, parent: 1, offX: 10, offY: 10 },
    { id: 30, parent: 20, offX: 2, offY: 3 },   // child of the subsurface
  ]);
  const acc = makeSubsurfaceAccessor(state);
  assert.deepEqual(acc.children(1), [{ id: 20, offX: 10, offY: 10 }]);
  assert.deepEqual(acc.children(20), [{ id: 30, offX: 2, offY: 3 }]);
});

test('a surface with no children returns empty', () => {
  const state = build([{ id: 1 }, { id: 20, parent: 1 }]);
  const acc = makeSubsurfaceAccessor(state);
  assert.deepEqual(acc.children(20), []);
  assert.deepEqual(acc.children(999), []);   // unknown id
});
