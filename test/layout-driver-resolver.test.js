// Pure-unit tests for the layout driver's resolver. The resolver dispatches
// non-managed lanes (exclusive, floating, invisible) BEFORE calling the
// plugin; only windows with tiling="managed", exclusive="none", visible=true
// reach the plugin's compute(). Invisible windows are omitted from rects[]
// (no separate `hidden` list); exclusive windows suppress every peer on
// their output.

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

function snap(windows) {
  // Default every window to outputId 0 unless explicitly set; lets test
  // inline objects stay terse. The driver consumes a windows Map keyed by
  // surfaceId + an outputContent map of ordered ids per output; both are
  // built from the flat array here.
  const wins = windows.map((win) => ({
    outputId: 0,
    tiling: 'managed',
    exclusive: 'none',
    visible: true,
    ...win,
  }));
  const windowMap = new Map();
  const outputContent = new Map([[0, []]]);
  for (const w of wins) {
    windowMap.set(w.id, w);
    outputContent.get(0).push(w.id);
  }
  return {
    outputs: [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }],
    windows: windowMap,
    outputContent,
  };
}

function managedWin(id) {
  return { id, role: 'toplevel', tiling: 'managed', exclusive: 'none', visible: true, outputId: 0 };
}

test('all managed: plugin gets every window; tile region = full output', async () => {
  const target = captureTarget();
  let computeInputs = null;
  const driver = createLayoutDriver({
    snapshot: () => snap([managedWin(1), managedWin(2)]),
    target,
    compute: async (inputs) => {
      computeInputs = inputs;
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: { x: 0, y: 0, width: 500, height: 600 } })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(computeInputs.windows.length, 2);
  assert.deepEqual(computeInputs.tileRegion, { x: 0, y: 0, width: 1000, height: 600 });
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].result.rects.length, 2);
});

test('maximized (exclusive) window: resolved to tile region without calling plugin', async () => {
  const target = captureTarget();
  let computeCalls = 0;
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', exclusive: 'maximized' }]),
    target,
    compute: async () => { computeCalls++; return { rects: [] }; },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(computeCalls, 0); // exclusive window present -> plugin not called
  assert.equal(target.calls[0].result.rects.length, 1);
  // Without reserved zones, maximized = full output.
  assert.deepEqual(target.calls[0].result.rects[0].outer,
    { x: 0, y: 0, width: 1000, height: 600 });
});

test('fullscreen window: resolved to full output rect', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', exclusive: 'fullscreen' }]),
    target,
    compute: async () => { throw new Error('plugin should not be called'); },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.deepEqual(target.calls[0].result.rects[0].outer,
    { x: 0, y: 0, width: 1000, height: 600 });
});

test('invisible window: omitted from rects[] (no draw this frame)', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', visible: false }]),
    target,
    compute: async () => ({ rects: [] }),
  });
  driver.schedule('mapped');
  await driver.settled();
  // apply IS called (drivers always notify the target for the pass), but
  // the rects list is empty -- the WM's applyLayout iterates only the
  // ids in rects[], so the invisible window's geometry is left alone.
  assert.equal(target.calls.length, 1);
  assert.equal(target.calls[0].result.rects.length, 0);
});

test('exclusive suppresses peers on the same output', async () => {
  const target = captureTarget();
  let computeCalls = 0;
  const driver = createLayoutDriver({
    snapshot: () => snap([
      managedWin(1),
      { id: 2, role: 'toplevel', exclusive: 'maximized' },
      managedWin(3),
    ]),
    target,
    compute: async () => {
      computeCalls++;
      return { rects: [] };
    },
  });
  driver.schedule('mapped');
  await driver.settled();
  // Plugin not called: an exclusive window owns the workspace.
  assert.equal(computeCalls, 0);
  // Result has ONLY the exclusive window.
  assert.equal(target.calls[0].result.rects.length, 1);
  assert.equal(target.calls[0].result.rects[0].id, 2);
});

test('reserved zones: exclusive=maximized + tileRegion both honor them', async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });
  const target = captureTarget();
  let computeInputs = null;
  const driver = createLayoutDriver({
    snapshot: () => snap([managedWin(1)]),
    target,
    reservedZones,
    compute: async (inputs) => {
      computeInputs = inputs;
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: { x: 0, y: 0, width: 500, height: 570 } })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();
  // Plugin's tileRegion subtracts the top 30px zone.
  assert.deepEqual(computeInputs.tileRegion,
    { x: 0, y: 30, width: 1000, height: 570 });

  // Now check maximized honors reserved zones too.
  const target2 = captureTarget();
  const driver2 = createLayoutDriver({
    snapshot: () => snap([{ id: 2, role: 'toplevel', exclusive: 'maximized' }]),
    target: target2,
    reservedZones,
    compute: async () => ({ rects: [] }),
  });
  driver2.schedule('mapped');
  await driver2.settled();
  assert.deepEqual(target2.calls[0].result.rects[0].outer,
    { x: 0, y: 30, width: 1000, height: 570 });
});

test('exclusive=fullscreen ignores reserved zones (full output)', async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', exclusive: 'fullscreen' }]),
    target,
    reservedZones,
    compute: async () => ({ rects: [] }),
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.deepEqual(target.calls[0].result.rects[0].outer,
    { x: 0, y: 0, width: 1000, height: 600 });
});

test('all-managed empty: plugin not called when no managed windows', async () => {
  const target = captureTarget();
  let computeCalls = 0;
  const driver = createLayoutDriver({
    snapshot: () => snap([]),
    target,
    compute: async () => { computeCalls++; return { rects: [] }; },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(computeCalls, 0);
});

test('plugin throw on a pass with no resolver rects: target NOT notified', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([managedWin(1)]),
    target,
    compute: async () => { throw new Error('boom'); },
    log: () => {}, // suppress
  });
  driver.schedule('mapped');
  await driver.settled();
  // No managed plugin rects produced, no resolver-only rects either ->
  // apply suppressed. Documented behavior: managed geometry stays put;
  // a subsequent schedule retries.
  assert.equal(target.calls.length, 0);
});

test('floating window: uses its floatingRect; plugin not called', async () => {
  const target = captureTarget();
  let computeCalls = 0;
  const driver = createLayoutDriver({
    snapshot: () => snap([{
      id: 1, role: 'toplevel', tiling: 'floating',
      floatingRect: { x: 100, y: 50, width: 300, height: 200 },
    }]),
    target,
    compute: async () => { computeCalls++; return { rects: [] }; },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(computeCalls, 0);
  assert.deepEqual(target.calls[0].result.rects[0].outer,
    { x: 100, y: 50, width: 300, height: 200 });
});
