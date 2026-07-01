// A subsurface is positioned relative to its parent: its absolute rect is the
// parent's rect + the subsurface offset. The WM never derives child placement --
// it only moves the parent via compositor.setSurfaceLayout, and the compositor
// cascades that move to the parent's subsurface subtree. When the WM MOVES a
// parent toplevel (a tiling reflow when a peer maps, or a master/stack swap) the
// children must follow to the new absolute position immediately, not lag until
// the client's next commit. A client that renders its content into a child
// surface (the GTK content-subsurface pattern, e.g. Firefox) would otherwise
// leave that content parked over whatever now occupies the vacated tile (renders
// on top of the new master) while its own tile shows only the empty decoration
// frame (black).
//
// The fake compositor here implements the same cascade JsCompositor does: a
// setSurfaceLayout on a parent re-lays every registered subsurface child from
// the new parent rect + offset. The tests assert the child's recorded placement
// tracks the parent across both move paths: the immediate relayout (a peer
// mapping) and the resize-transaction apply (a reorder that holds geometry until
// the client commits).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

const rec = (id) => ({ resource: { __id: id } });
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

function setup({ withSerials } = {}) {
  const layouts = [];
  // childId -> { parent, dx, dy }: the subsurface tree the compositor would
  // learn through its accessor.
  const children = new Map();
  const lastRect = new Map();   // id -> { x, y }: last placement seen per surface
  const comp = {
    setSurfaceLayout(id, x, y, w, h) {
      layouts.push({ id, x, y, w, h });
      lastRect.set(id, { x, y });
      // Cascade to subsurface children (content-sized), recursing like the
      // real compositor's cascadeSubsurfaceLayout.
      for (const [childId, c] of children) {
        if (c.parent === id) this.setSurfaceLayout(childId, x + c.dx, y + c.dy, 0, 0);
      }
    },
    // Re-derive a parent's subtree from its current rect (tree change with no
    // parent move). Exercised by the protocol layer's applySubsurfaces; the
    // WM-only tests here reach children through setSurfaceLayout cascades.
    reflowSubsurfaces(parentId) {
      const p = lastRect.get(parentId);
      if (!p) return;
      for (const [childId, c] of children) {
        if (c.parent === parentId) this.setSurfaceLayout(childId, p.x + c.dx, p.y + c.dy, 0, 0);
      }
    },
    setStack() {},
    _layouts: layouts,
  };
  let serial = 0;
  const configures = [];
  const configure = {
    configure: (id, _x, _y, w, h) => {
      if (!withSerials) { configures.push({ id, w, h, serial: null }); return null; }
      serial += 1; configures.push({ id, w, h, serial }); return serial;
    },
    configureMove: () => {},
  };
  const wm = createWm(comp, OUT, {
    configure,
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  return { wm, comp, children, configures };
}

async function addMapped(wm, id) {
  wm.addWindow(id, rec(id));
  await wm.settled();
  wm.windowHasContent(id);
}

const lastLayoutOf = (comp, id) => comp._layouts.filter((l) => l.id === id).at(-1);
const lastSerial = (configures, id) => configures.filter((c) => c.id === id).at(-1)?.serial;

test('immediate reflow: a child follows its parent to the new tile', async () => {
  const { wm, comp, children } = setup();
  await addMapped(wm, 1);                 // window 1 fills the output
  children.set(9001, { parent: 1, dx: 5, dy: 7 });  // content subsurface of win 1

  comp._layouts.length = 0;
  // Mapping window 2 (reason "mapped" -> immediate path) makes 2 the master and
  // pushes window 1 into the right stack column: 1 moves (0,0) -> (500,0).
  await addMapped(wm, 2);

  assert.deepEqual(wm.rectOf(1), { x: 500, y: 0, width: 500, height: 600 },
    'parent moved to the stack column');
  // The parent move cascaded to the child at the parent's NEW origin + offset.
  assert.deepEqual(lastLayoutOf(comp, 9001), { id: 9001, x: 505, y: 7, w: 0, h: 0 },
    'child followed the parent move (would lag at 5,7 without the cascade)');
});

test('resize-transaction apply: a child follows when the held geometry lands', async () => {
  const { wm, comp, children, configures } = setup({ withSerials: true });
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.settled();
  // Order [3, 2, 1]: 3 master (0,0), 2 stack-top (500,0), 1 stack-bottom (500,300).
  children.set(9003, { parent: 3, dx: 4, dy: 6 });  // content subsurface of the master

  comp._layouts.length = 0;
  configures.length = 0;
  // Swap master 3 with neighbour 2 -> [2, 3, 1]. A "reorder" relayout HOLDS the
  // new geometry (resize transaction) until each window acks + commits.
  assert.equal(wm.reorder(3, 'swap-next'), true);
  await wm.settled();

  // Held: 3 has not moved yet, so the child has not been re-laid to a new place.
  // Assert the parent is still at its old rect.
  assert.deepEqual(wm.rectOf(3), { x: 0, y: 0, width: 500, height: 600 }, '3 still held at master');

  // Both resizing windows commit; the held batch applies and 3 moves to the
  // stack-top tile (500,0). pushGeometry's setSurfaceLayout cascades the subtree.
  wm.notifyToplevelCommit(2, lastSerial(configures, 2));
  wm.notifyToplevelCommit(3, lastSerial(configures, 3));

  assert.deepEqual(wm.rectOf(3), { x: 500, y: 0, width: 500, height: 300 }, '3 -> stack-top');
  assert.deepEqual(lastLayoutOf(comp, 9003), { id: 9003, x: 504, y: 6, w: 0, h: 0 },
    'child followed the parent through the transaction apply');
});
