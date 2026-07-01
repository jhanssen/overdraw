// A subsurface is positioned relative to its parent: its absolute rect is the
// parent's rect + the subsurface offset, re-derived by the compositor's
// emitSubtree (driven through the WM's `rebuild` hook). When the WM MOVES a
// parent toplevel -- a tiling reflow when a peer maps, or a master/stack swap --
// the children must be re-emitted at the new absolute position immediately,
// not lag until the client's next commit. A client that renders its content
// into a child surface (the GTK content-subsurface pattern, e.g. Firefox) would
// otherwise leave that content parked over whatever now occupies the vacated
// tile (renders on top of the new master) while its own tile shows only the
// empty decoration frame (black).
//
// These tests model the child re-emit with a `rebuild` spy that mimics
// emitSubtree (child rect = parent rect + offset). They assert the child's
// recorded placement tracks the parent across both move paths: the immediate
// relayout (a peer mapping) and the resize-transaction apply (a reorder that
// holds geometry until the client commits).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

const rec = (id) => ({ resource: { __id: id } });
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

// A child surface tracked under a parent toplevel at a fixed offset. `rebuild`
// (the WM's subsurface-refresh hook) re-emits every tracked child from its
// parent's CURRENT rect -- exactly what the real emitSubtree does.
function setup({ withSerials } = {}) {
  const layouts = [];
  const comp = {
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
    setStack() {},
    _layouts: layouts,
  };
  // childId -> { parent, dx, dy }
  const children = new Map();
  let serial = 0;
  const configures = [];
  const configure = {
    configure: (id, _x, _y, w, h) => {
      if (!withSerials) { configures.push({ id, w, h, serial: null }); return null; }
      serial += 1; configures.push({ id, w, h, serial }); return serial;
    },
    configureMove: () => {},
  };
  let wm;
  const rebuild = () => {
    for (const [childId, { parent, dx, dy }] of children) {
      const p = wm.rectOf(parent);
      if (p) comp.setSurfaceLayout(childId, p.x + dx, p.y + dy, 0, 0);
    }
  };
  wm = createWm(comp, OUT, {
    configure,
    layoutDriverFactory: inlineMasterStackDriverFactory,
    rebuild,
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
  // The child must have been re-emitted at the parent's NEW origin + offset.
  assert.deepEqual(lastLayoutOf(comp, 9001), { id: 9001, x: 505, y: 7, w: 0, h: 0 },
    'child followed the parent move (would lag at 5,7 before the fix)');
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

  // Held: 3 has not moved yet, so the child has not been re-emitted to a new
  // place. Assert the parent is still at its old rect.
  assert.deepEqual(wm.rectOf(3), { x: 0, y: 0, width: 500, height: 600 }, '3 still held at master');

  // Both resizing windows commit; the held batch applies and 3 moves to the
  // stack-top tile (500,0). pushGeometry re-emits the subtree.
  wm.notifyToplevelCommit(2, lastSerial(configures, 2));
  wm.notifyToplevelCommit(3, lastSerial(configures, 3));

  assert.deepEqual(wm.rectOf(3), { x: 500, y: 0, width: 500, height: 300 }, '3 -> stack-top');
  assert.deepEqual(lastLayoutOf(comp, 9003), { id: 9003, x: 504, y: 6, w: 0, h: 0 },
    'child followed the parent through the transaction apply');
});
