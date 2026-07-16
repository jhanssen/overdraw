// Explicit-island layout-driver tests (docs/canvas-design.md §5). An island
// carries its own tile region and member order; the driver runs one
// compute() per island, so one output can host several independently tiled
// regions, exclusive windows own only their island, and island rects are
// used verbatim (reserved zones apply only to implicit rect-null islands).
//
// GPU-free: the driver is pure logic over (snapshot, reservedZones, compute).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLayoutDriver } from '../packages/core/dist/wm/layout-driver.js';
import { createReservedZoneRegistry } from '../packages/core/dist/wm/reserved-zones.js';

function captureTarget() {
  const calls = [];
  return {
    calls,
    apply(result, reason) { calls.push({ result, reason }); },
  };
}

const OUTPUT = { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 };

function managedWin(id) {
  return { id, role: 'toplevel', tiling: 'managed', exclusive: 'none', visible: true };
}

function snapWith(islands, windows, outputs = [OUTPUT]) {
  const windowMap = new Map();
  for (const w of windows) windowMap.set(w.id, w);
  return { outputs, windows: windowMap, islands };
}

test('two islands on one output: one compute() each, tileRegion = island rect', async () => {
  const computeCalls = [];
  const target = captureTarget();
  const islandA = { id: 10, contextOutputId: 0, rect: { x: 0, y: 0, width: 500, height: 600 }, members: [1, 2] };
  const islandB = { id: 11, contextOutputId: 0, rect: { x: 500, y: 0, width: 500, height: 600 }, members: [3] };
  const driver = createLayoutDriver({
    snapshot: () => snapWith([islandA, islandB],
      [managedWin(1), managedWin(2), managedWin(3)]),
    target,
    compute: async (inputs) => {
      computeCalls.push({
        islandId: inputs.island.id,
        outputId: inputs.output.id,
        windowIds: inputs.windows.map((w) => w.id),
        tileRegion: inputs.tileRegion,
      });
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: inputs.tileRegion })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  assert.equal(computeCalls.length, 2);
  const byIsland = new Map(computeCalls.map((c) => [c.islandId, c]));
  assert.deepEqual(byIsland.get(10).windowIds, [1, 2]);
  assert.deepEqual(byIsland.get(11).windowIds, [3]);
  assert.deepEqual(byIsland.get(10).tileRegion, islandA.rect);
  assert.deepEqual(byIsland.get(11).tileRegion, islandB.rect);
  // Both passes share the output context.
  assert.ok(computeCalls.every((c) => c.outputId === 0));
  // Merged apply carries every island's rects.
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].result.rects.length, 3);
});

test('reserved zones never carve explicit island rects; implicit still derives output-minus-zones', async () => {
  const zones = createReservedZoneRegistry();
  zones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });

  const computeCalls = [];
  const target = captureTarget();
  const explicit = { id: 10, contextOutputId: 0, rect: { x: 5000, y: 0, width: 1000, height: 570 }, members: [1] };
  const implicit = { id: 0, contextOutputId: 0, rect: null, members: [2] };
  const driver = createLayoutDriver({
    snapshot: () => snapWith([explicit, implicit], [managedWin(1), managedWin(2)]),
    target,
    reservedZones: zones,
    compute: async (inputs) => {
      computeCalls.push({ islandId: inputs.island.id, tileRegion: inputs.tileRegion });
      return { rects: [{ id: inputs.windows[0].id, outer: inputs.tileRegion }] };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  const byIsland = new Map(computeCalls.map((c) => [c.islandId, c]));
  // An explicit world rect is pure content space: the island source
  // sized it to the workarea and the camera keeps it clear of the bar
  // band, so the driver uses it verbatim.
  assert.deepEqual(byIsland.get(10).tileRegion,
    { x: 5000, y: 0, width: 1000, height: 570 });
  // The implicit island still derives output-minus-zones.
  assert.deepEqual(byIsland.get(0).tileRegion, { x: 0, y: 30, width: 1000, height: 570 });
});

test('fullscreen on an explicit island covers the glass: island origin shifted back by the workarea offset, output-sized', async () => {
  const zones = createReservedZoneRegistry();
  zones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });

  const target = captureTarget();
  const island = {
    id: 10, contextOutputId: 0,
    rect: { x: 5000, y: 0, width: 1000, height: 570 }, members: [1],
  };
  const driver = createLayoutDriver({
    snapshot: () => snapWith([island],
      [{ ...managedWin(1), exclusive: 'fullscreen' }]),
    target,
    reservedZones: zones,
    compute: async () => { throw new Error('exclusive islands never reach the plugin'); },
  });
  driver.schedule('mapped');
  await driver.settled();

  // The docked camera puts the island origin at the workarea origin
  // (0, 30 on the glass); a glass-covering rect therefore starts 30px
  // above the island in world space and spans the full output size.
  assert.deepEqual(target.calls[0].result.rects, [
    { id: 1, outer: { x: 5000, y: -30, width: 1000, height: 600 } },
  ]);
});

test('exclusive window owns only its island; the sibling island still tiles', async () => {
  const target = captureTarget();
  const computeCalls = [];
  const islandA = { id: 10, contextOutputId: 0, rect: { x: 0, y: 0, width: 500, height: 600 }, members: [1, 2] };
  const islandB = { id: 11, contextOutputId: 0, rect: { x: 500, y: 0, width: 500, height: 600 }, members: [3] };
  const driver = createLayoutDriver({
    snapshot: () => snapWith([islandA, islandB], [
      { ...managedWin(1), exclusive: 'maximized' },
      managedWin(2),
      managedWin(3),
    ]),
    target,
    compute: async (inputs) => {
      computeCalls.push(inputs.island.id);
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: inputs.tileRegion })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  // Island A resolves in core (maximized covers the island; peer 2
  // suppressed); only island B reaches the plugin.
  assert.deepEqual(computeCalls, [11]);
  const rects = target.calls[0].result.rects;
  const ids = rects.map((r) => r.id).sort();
  assert.deepEqual(ids, [1, 3]);
  // Maximized covers the ISLAND rect, not the whole output.
  assert.deepEqual(rects.find((r) => r.id === 1).outer, islandA.rect);
});

test('island referencing an unknown output is skipped; others apply', async () => {
  const target = captureTarget();
  const computeCalls = [];
  const driver = createLayoutDriver({
    snapshot: () => snapWith([
      { id: 10, contextOutputId: 7, rect: { x: 0, y: 0, width: 100, height: 100 }, members: [1] },
      { id: 11, contextOutputId: 0, rect: null, members: [2] },
    ], [managedWin(1), managedWin(2)]),
    target,
    log: () => {},
    compute: async (inputs) => {
      computeCalls.push(inputs.island.id);
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: inputs.tileRegion })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  assert.deepEqual(computeCalls, [11]);
  assert.deepEqual(target.calls[0].result.rects.map((r) => r.id), [2]);
});
