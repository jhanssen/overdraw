// Tests for the WM resize transaction: on a "reorder" relayout a window that
// changes size HOLDS its new geometry until it acks the configure and commits a
// matching buffer (signalled here via wm.notifyToplevelCommit), then every held
// window applies together. A timeout applies whatever is held if a client is
// slow. No GPU: a mock compositor records setSurfaceLayout; a configure sink
// returns incrementing serials; the inline master-stack driver settles layout.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockCompositor() {
  const layouts = [];
  return {
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
    setStack() {},
    _layouts: layouts,
  };
}

const rec = (id) => ({ resource: { __id: id } });
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

function setup() {
  const comp = mockCompositor();
  let serial = 0;
  const configures = [];
  const configure = (id, _x, _y, w, h) => {
    serial += 1; configures.push({ id, w, h, serial }); return serial;
  };
  const wm = createWm(comp, OUT, { configure, layoutDriverFactory: inlineMasterStackDriverFactory });
  return { wm, comp, configures };
}

async function addMapped(wm, id) {
  wm.addWindow(id, rec(id));
  await wm.settled();
  wm.windowHasContent(id);
}

const rectOf = (wm, id) => wm.rectOf(id);
// The serial of the most recent configure sent to `id`.
const lastSerial = (configures, id) => configures.filter((c) => c.id === id).at(-1)?.serial;

test('reorder holds geometry: configure sent, but rect not applied until commit', async () => {
  const { wm, configures } = setup();
  await addMapped(wm, 1);  // master, full
  await addMapped(wm, 2);  // 2 master (500x600), 1 stack (500x600)
  await addMapped(wm, 3);  // 3 master (500x600), 2 + 1 stacks (500x300)
  await wm.settled();
  // Order is [3, 2, 1]: 3 master, 2 stack-top, 1 stack-bottom.
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 });
  assert.deepEqual(rectOf(wm, 2), { x: 500, y: 0, width: 500, height: 300 });

  configures.length = 0;
  // Swap the master (3) with its neighbour (2): order -> [2, 3, 1].
  assert.equal(wm.reorder(3, 'swap-next'), true);
  await wm.settled();

  // 2 and 3 changed size (master<->stack), so both were (re)configured...
  const ids = configures.map((c) => c.id).sort();
  assert.deepEqual(ids, [2, 3], 'both resizing windows reconfigured');
  // ...but their drawn rects are HELD at the old geometry until they commit.
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, '3 still old (held)');
  assert.deepEqual(rectOf(wm, 2), { x: 500, y: 0, width: 500, height: 300 }, '2 still old (held)');

  // Only one commits: still held (the batch is atomic).
  wm.notifyToplevelCommit(3, lastSerial(configures, 3));
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, 'held until both ready');

  // Second commits: the whole batch applies.
  wm.notifyToplevelCommit(2, lastSerial(configures, 2));
  assert.deepEqual(rectOf(wm, 2), { x: 0, y: 0, width: 500, height: 600 }, '2 -> master');
  assert.deepEqual(rectOf(wm, 3), { x: 500, y: 0, width: 500, height: 300 }, '3 -> stack-top');
});

test('reorder transaction: stale serial does not release the hold', async () => {
  const { wm, configures } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.settled();
  configures.length = 0;
  wm.reorder(3, 'swap-next');
  await wm.settled();

  // A commit acking an OLDER serial than the held one must not release it.
  wm.notifyToplevelCommit(3, 0);
  wm.notifyToplevelCommit(2, 0);
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, 'still held on stale serial');
});

test('reorder transaction: timeout applies the held geometry if a client is slow', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.settled();
  wm.reorder(3, 'swap-next');
  await wm.settled();
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, 'held immediately after reorder');

  // No commits; wait past the transaction timeout (150ms).
  await new Promise((r) => setTimeout(r, 220));
  assert.deepEqual(rectOf(wm, 2), { x: 0, y: 0, width: 500, height: 600 }, '2 applied on timeout');
  assert.deepEqual(rectOf(wm, 3), { x: 500, y: 0, width: 500, height: 300 }, '3 applied on timeout');
});

test('rapid reorders merge: drawn geometry stays put until clients catch up', async () => {
  const { wm, configures } = setup();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.settled();
  configures.length = 0;

  // Swap, then swap back, before any client commits.
  wm.reorder(3, 'swap-next');
  await wm.settled();
  wm.reorder(3, 'swap-prev');  // 3 returns to master
  await wm.settled();

  // Drawn geometry never moved during the burst.
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, '3 unmoved through the burst');
  assert.deepEqual(rectOf(wm, 2), { x: 500, y: 0, width: 500, height: 300 }, '2 unmoved through the burst');

  // The net target equals the current geometry, so once clients commit the
  // latest configured size the apply is a no-op (no flicker).
  wm.notifyToplevelCommit(3, lastSerial(configures, 3));
  wm.notifyToplevelCommit(2, lastSerial(configures, 2));
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, '3 settled at master');
  assert.deepEqual(rectOf(wm, 2), { x: 500, y: 0, width: 500, height: 300 }, '2 settled at stack-top');
});

test('non-reorder relayout still applies geometry immediately (no transaction)', async () => {
  const { wm } = setup();
  await addMapped(wm, 1);
  await wm.settled();
  // A second window mapping is reason "mapped" -> immediate apply, no hold.
  await addMapped(wm, 2);
  await wm.settled();
  assert.deepEqual(rectOf(wm, 2), { x: 0, y: 0, width: 500, height: 600 }, '2 master immediately');
  assert.deepEqual(rectOf(wm, 1), { x: 500, y: 0, width: 500, height: 600 }, '1 stack immediately');
});

// ---- buffer-dims-only hold (xwayland path) -------------------------------
// A configure sink that returns null signals "no ack expected" -- the
// xwayland case (X has no ack_configure equivalent). The hold then gates
// purely on surfaceReadyAt; notifyToplevelCommit is not part of the path.

function setupBufferDimsOnly() {
  // A surface-readiness store the mock compositor checks. The test flips
  // entries to simulate the client committing a new buffer at the new dims.
  const readyAt = new Map(); // surfaceId -> { w, h, scale? }
  const comp = {
    setSurfaceLayout() {},
    setStack() {},
    setFrozenReadyHandler(cb) { comp._frozenReady = cb; },
    surfaceReadyAt(id, w, h, _scale) {
      const r = readyAt.get(id);
      return !!r && r.w === w && r.h === h;
    },
    _frozenReady: null,
  };
  // Sink returns null -- the xwayland convention (no ack to wait for).
  const configures = [];
  const configure = (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; };
  const wm = createWm(comp, OUT, { configure, layoutDriverFactory: inlineMasterStackDriverFactory });
  return { wm, comp, configures, readyAt };
}

test('xwayland-style hold: serial=null releases on surfaceReadyAt alone', async () => {
  const { wm, comp, configures, readyAt } = setupBufferDimsOnly();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.settled();
  configures.length = 0;

  // Reorder triggers the resize-tx path. Sink returns null -> requireAck=false.
  wm.reorder(3, 'swap-next');
  await wm.settled();

  // Configures were issued (the WM still sends the new size; the X side
  // applies it via the configure-window + synthetic ConfigureNotify path).
  const ids = configures.map((c) => c.id).sort();
  assert.deepEqual(ids, [2, 3], 'both resizing windows configured');

  // Geometry is HELD even without ack -- the broker is waiting on
  // surfaceReadyAt, which hasn't been satisfied yet.
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, '3 still old (held)');
  assert.deepEqual(rectOf(wm, 2), { x: 500, y: 0, width: 500, height: 300 }, '2 still old (held)');

  // notifyToplevelCommit is a no-op here -- there's no serial to ack
  // against. The hold ignores it.
  wm.notifyToplevelCommit(3, null);
  wm.notifyToplevelCommit(2, null);
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, 'still held: surfaceReadyAt is false');

  // Simulate the X client committing the new buffer at the new dims and
  // the GPU process reporting "frozen surface drawable now". Use the frozen-
  // ready handler the broker registered so the broker re-evaluates.
  readyAt.set(3, { w: 500, h: 300 });
  readyAt.set(2, { w: 500, h: 600 });
  comp._frozenReady?.(3);
  comp._frozenReady?.(2);

  // Both windows now read ready; the batch applies.
  assert.deepEqual(rectOf(wm, 2), { x: 0, y: 0, width: 500, height: 600 }, '2 -> master');
  assert.deepEqual(rectOf(wm, 3), { x: 500, y: 0, width: 500, height: 300 }, '3 -> stack-top');
});

test('xwayland-style hold: held until BOTH windows report buffer-ready (batched)', async () => {
  const { wm, comp, readyAt } = setupBufferDimsOnly();
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  await addMapped(wm, 3);
  await wm.settled();

  wm.reorder(3, 'swap-next');
  await wm.settled();

  // Only one window reports ready: held (batched).
  readyAt.set(3, { w: 500, h: 300 });
  comp._frozenReady?.(3);
  assert.deepEqual(rectOf(wm, 3), { x: 0, y: 0, width: 500, height: 600 }, 'still held: 2 not ready yet');

  // Second reports ready: batch applies.
  readyAt.set(2, { w: 500, h: 600 });
  comp._frozenReady?.(2);
  assert.deepEqual(rectOf(wm, 2), { x: 0, y: 0, width: 500, height: 600 }, '2 -> master');
  assert.deepEqual(rectOf(wm, 3), { x: 500, y: 0, width: 500, height: 300 }, '3 -> stack-top');
});
