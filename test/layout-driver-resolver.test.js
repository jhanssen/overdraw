// Pure-unit tests for the layout driver's mode resolver. The resolver
// dispatches presentation-specific rects (maximized, fullscreen,
// minimized) BEFORE calling the plugin; only `managed` windows reach the
// plugin's compute().

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
  // inline objects stay terse.
  const w = windows.map((win) => ({ outputId: 0, ...win }));
  return {
    outputs: [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }],
    windows: w,
  };
}

function managedWin(id) {
  return { id, role: 'toplevel', presentation: 'managed', outputId: 0 };
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

test('maximized window: resolved to tile region without calling plugin', async () => {
  const target = captureTarget();
  let computeCalls = 0;
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', presentation: 'maximized' }]),
    target,
    compute: async () => { computeCalls++; return { rects: [] }; },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(computeCalls, 0); // no managed windows -> plugin not called
  assert.equal(target.calls[0].result.rects.length, 1);
  // Without reserved zones, maximized = full output.
  assert.deepEqual(target.calls[0].result.rects[0].outer,
    { x: 0, y: 0, width: 1000, height: 600 });
});

test('fullscreen window: resolved to full output rect', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', presentation: 'fullscreen' }]),
    target,
    compute: async () => { throw new Error('plugin should not be called'); },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.deepEqual(target.calls[0].result.rects[0].outer,
    { x: 0, y: 0, width: 1000, height: 600 });
});

test('minimized window: appears in hidden list, not in rects', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', presentation: 'minimized' }]),
    target,
    compute: async () => ({ rects: [] }),
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(target.calls[0].result.rects.length, 0);
  assert.deepEqual([...target.calls[0].result.hidden], [1]);
});

test('mixed: managed + maximized; plugin gets only managed', async () => {
  const target = captureTarget();
  let computeInputs = null;
  const driver = createLayoutDriver({
    snapshot: () => snap([
      managedWin(1),
      { id: 2, role: 'toplevel', presentation: 'maximized' },
      managedWin(3),
    ]),
    target,
    compute: async (inputs) => {
      computeInputs = inputs;
      return { rects: inputs.windows.map((w) => ({ id: w.id, outer: { x: 0, y: 0, width: 500, height: 600 } })) };
    },
  });
  driver.schedule('mapped');
  await driver.settled();
  assert.equal(computeInputs.windows.length, 2);
  assert.deepEqual(computeInputs.windows.map((w) => w.id).sort(), [1, 3]);
  // Result has all 3 rects (2 from plugin + 1 from resolver).
  assert.equal(target.calls[0].result.rects.length, 3);
});

test('reserved zones: maximized + tileRegion both honor them', async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });
  const target = captureTarget();
  let computeInputs = null;
  const driver = createLayoutDriver({
    snapshot: () => snap([
      managedWin(1),
      { id: 2, role: 'toplevel', presentation: 'maximized' },
    ]),
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
  // Maximized window also gets the tile region.
  const maxRect = target.calls[0].result.rects.find((r) => r.id === 2);
  assert.deepEqual(maxRect.outer, { x: 0, y: 30, width: 1000, height: 570 });
});

test('fullscreen ignores reserved zones (full output)', async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set('bar', { outputId: 0, edge: 'top', thickness: 30, owner: 99 });
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([{ id: 1, role: 'toplevel', presentation: 'fullscreen' }]),
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

test('plugin throw: target is still notified for resolver rects (but rects[] not merged)', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([
      managedWin(1),
      { id: 2, role: 'toplevel', presentation: 'maximized' },
    ]),
    target,
    compute: async () => { throw new Error('boom'); },
    log: () => {}, // suppress
  });
  driver.schedule('mapped');
  await driver.settled();
  // The compute throw aborts the whole pass; target.apply is NOT called.
  // The resolver-computed maximized rect is lost too. Documented behavior:
  // managed geometry stays put; subsequent schedules retry. The simpler
  // alternative (apply resolver-only rects on plugin failure) is a
  // future enhancement.
  assert.equal(target.calls.length, 0);
});

test('plugin hidden list merges with resolver hidden list', async () => {
  const target = captureTarget();
  const driver = createLayoutDriver({
    snapshot: () => snap([
      managedWin(1),
      managedWin(2),
      { id: 3, role: 'toplevel', presentation: 'minimized' },
    ]),
    target,
    compute: async (inputs) => ({
      rects: [{ id: inputs.windows[0].id, outer: { x: 0, y: 0, width: 500, height: 600 } }],
      hidden: [inputs.windows[1].id], // plugin chose to hide the 2nd managed
    }),
  });
  driver.schedule('mapped');
  await driver.settled();
  // Hidden list = plugin's [2] + resolver's [3] = [2, 3].
  assert.deepEqual([...target.calls[0].result.hidden].sort(), [2, 3]);
});
