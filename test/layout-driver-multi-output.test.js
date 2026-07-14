// Multi-output layout-driver tests. Each output gets its own compute() pass
// with its own slice of the global logical coordinate space; windows are
// partitioned by outputId; the merged LayoutResult covers every output.
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

// Two side-by-side outputs at x=0,1000 each 1000x600.
const TWO_OUTPUTS = [
  { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 },
  { id: 1, rect: { x: 1000, y: 0, width: 1000, height: 600 }, scale: 1 },
];

function snap(windows, outputs = TWO_OUTPUTS) {
  // Build the (id -> window) map + one implicit island per output (id =
  // outputId, rect = null) from the flat windows array, mirroring the WM's
  // implicit derivation. The test input expresses "window W is on output O"
  // for brevity.
  const windowMap = new Map();
  const byOutput = new Map();
  for (const w of windows) {
    windowMap.set(w.id, w);
    if (!byOutput.has(w.outputId)) byOutput.set(w.outputId, []);
    byOutput.get(w.outputId).push(w.id);
  }
  const islands = [...byOutput].map(([outputId, members]) =>
    ({ id: outputId, contextOutputId: outputId, rect: null, members }));
  return { outputs, windows: windowMap, islands };
}

function managedOn(id, outputId) {
  return {
    id, role: 'toplevel', outputId,
    tiling: 'managed', exclusive: 'none', visible: true,
  };
}

test('two outputs: compute() called once per output with its own windows', async () => {
  const computeCalls = [];
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([managedOn(1, 0), managedOn(2, 1), managedOn(3, 0)]),
    target,
    compute: async (inputs) => {
      computeCalls.push({
        outputId: inputs.output.id,
        windowIds: inputs.windows.map((w) => w.id),
        tileRegion: inputs.tileRegion,
      });
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: inputs.tileRegion })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  // One compute() per output.
  assert.equal(computeCalls.length, 2);
  const byOutput = new Map(computeCalls.map((c) => [c.outputId, c]));
  assert.deepEqual(byOutput.get(0).windowIds.sort(), [1, 3]);
  assert.deepEqual(byOutput.get(1).windowIds, [2]);
  // Each output's tile region equals its own rect (no reserved zones).
  assert.deepEqual(byOutput.get(0).tileRegion, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(byOutput.get(1).tileRegion, { x: 1000, y: 0, width: 1000, height: 600 });

  // Merged result carries all 3 rects.
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].result.rects.length, 3);
});

test('outputs with their own reserved zones: tileRegion differs per output', async () => {
  const zones = createReservedZoneRegistry();
  // 30px top bar on output 0; 50px right dock on output 1.
  zones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });
  zones.set('dock', { outputId: 1, edge: 'right', thickness: 50, owner: 100 });

  const computeCalls = [];
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([managedOn(1, 0), managedOn(2, 1)]),
    target,
    reservedZones: zones,
    compute: async (inputs) => {
      computeCalls.push({ outputId: inputs.output.id, tileRegion: inputs.tileRegion });
      return { rects: [{ id: inputs.windows[0].id, outer: inputs.tileRegion }] };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  const byOutput = new Map(computeCalls.map((c) => [c.outputId, c]));
  // Output 0: full width, 30 px off the top.
  assert.deepEqual(byOutput.get(0).tileRegion,
    { x: 0, y: 30, width: 1000, height: 570 });
  // Output 1: 50px narrower on the right; origin is the output's global x=1000.
  assert.deepEqual(byOutput.get(1).tileRegion,
    { x: 1000, y: 0, width: 950, height: 600 });
});

test('one output empty (no windows): plugin NOT called for that output', async () => {
  let calls = 0;
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([managedOn(1, 0)]),  // only output 0 has a window
    target,
    compute: async (inputs) => {
      calls += 1;
      assert.equal(inputs.output.id, 0);
      return { rects: [{ id: 1, outer: inputs.tileRegion }] };
    },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(calls, 1);  // only output 0
});

test('per-output exclusive: fullscreen on output 1 covers output 1 only', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([
      managedOn(1, 0),
      {
        id: 2, role: 'toplevel', outputId: 1,
        tiling: 'managed', exclusive: 'fullscreen', visible: true,
      },
    ]),
    target,
    compute: async (inputs) => ({
      rects: inputs.windows.map((w) => ({ id: w.id, outer: inputs.tileRegion })),
    }),
  });
  driver.schedule('mapped');
  await driver.settled();

  const rects = target.calls[0].result.rects;
  // Output 1 fullscreen window gets output 1's full rect.
  const fs = rects.find((r) => r.id === 2);
  assert.deepEqual(fs.outer, { x: 1000, y: 0, width: 1000, height: 600 });
});

test('compute() throw on one output does not block others', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([managedOn(1, 0), managedOn(2, 1)]),
    target,
    log: () => {},
    compute: async (inputs) => {
      if (inputs.output.id === 0) throw new Error('boom');
      return { rects: [{ id: 2, outer: inputs.tileRegion }] };
    },
  });
  driver.schedule('mapped');
  await driver.settled();

  // target.apply IS called -- output 1's pass succeeded.
  assert.equal(target.calls.length, 1);
  const ids = target.calls[0].result.rects.map((r) => r.id);
  assert.deepEqual(ids, [2]);
});
