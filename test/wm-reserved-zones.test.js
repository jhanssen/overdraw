// The reserved-zone registry is wired into the layout driver's deps in
// production via main.ts. These tests verify the contract end-to-end on the
// WM side: the tile region passed to the layout plugin shrinks by registered
// zones, and the maximized-presentation resolver also honors them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWm } from "../packages/core/dist/wm/index.js";
import { createLayoutDriver } from "../packages/core/dist/wm/layout-driver.js";
import { createReservedZoneRegistry } from "../packages/core/dist/wm/reserved-zones.js";

const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];
const rec = (id) => ({ resource: { __id: id } });

function mockCompositor() {
  return {
    layouts: [],
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setStack() {},
  };
}

// Driver that records its LayoutInputs.tileRegion + places one window at the
// tile region. Lets a test inspect what the driver passed in.
function recordingDriverFactory(reservedZones) {
  return function factory(target, snapshot) {
    const observed = { lastInputs: null };
    const driver = createLayoutDriver({
      target,
      snapshot,
      reservedZones,
      compute: async (inputs) => {
        observed.lastInputs = inputs;
        return {
          rects: inputs.windows.map((w) => ({ id: w.id, outer: inputs.tileRegion })),
        };
      },
    });
    // Expose the observed object for assertions.
    driver._observed = observed;
    return driver;
  };
}

test("tileRegion equals outputRect when no zones registered", async () => {
  const reservedZones = createReservedZoneRegistry();
  const factory = recordingDriverFactory(reservedZones);
  let observed;
  const wm = createWm(mockCompositor(), OUT, {
    layoutDriverFactory: (t, s) => {
      const d = factory(t, s);
      observed = d._observed;
      return d;
    },
    configure: () => {},
  });
  wm.addWindow(1, rec(1));
  await wm.settled();
  assert.deepEqual(observed.lastInputs.tileRegion,
    { x: 0, y: 0, width: 1000, height: 600 });
});

test("tileRegion shrinks by registered top zone", async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set("panel", {
    outputId: 0, edge: "top", thickness: 30, owner: 999,
  });
  const factory = recordingDriverFactory(reservedZones);
  let observed;
  const wm = createWm(mockCompositor(), OUT, {
    layoutDriverFactory: (t, s) => {
      const d = factory(t, s);
      observed = d._observed;
      return d;
    },
    configure: () => {},
  });
  wm.addWindow(1, rec(1));
  await wm.settled();
  assert.deepEqual(observed.lastInputs.tileRegion,
    { x: 0, y: 30, width: 1000, height: 570 });
});

test("tileRegion shrinks by zones on multiple edges (sums)", async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set("panel-top", {
    outputId: 0, edge: "top", thickness: 30, owner: 999,
  });
  reservedZones.set("dock-bottom", {
    outputId: 0, edge: "bottom", thickness: 50, owner: 998,
  });
  reservedZones.set("sidebar-left", {
    outputId: 0, edge: "left", thickness: 200, owner: 997,
  });
  const factory = recordingDriverFactory(reservedZones);
  let observed;
  const wm = createWm(mockCompositor(), OUT, {
    layoutDriverFactory: (t, s) => {
      const d = factory(t, s);
      observed = d._observed;
      return d;
    },
    configure: () => {},
  });
  wm.addWindow(1, rec(1));
  await wm.settled();
  assert.deepEqual(observed.lastInputs.tileRegion,
    { x: 200, y: 30, width: 800, height: 520 });
});

test("maximized presentation: outer rect is the effective rect (not the output)", async () => {
  const reservedZones = createReservedZoneRegistry();
  reservedZones.set("panel", {
    outputId: 0, edge: "top", thickness: 30, owner: 999,
  });
  const comp = mockCompositor();
  const wm = createWm(comp, OUT, {
    layoutDriverFactory: (t, s) => createLayoutDriver({
      target: t, snapshot: s, reservedZones,
      // The plugin sees no windows when they're all maximized -- the driver
      // resolves them internally; compute() should not be called.
      compute: async () => ({ rects: [] }),
    }),
    configure: () => {},
  });
  wm.addWindow(1, rec(1));
  // Push into maximized presentation.
  await wm.propose(1, { presentation: "maximized" }, "client-request");
  await wm.settled();
  // The window's outer rect should be the tileRegion (effectiveRect), not the
  // raw output rect. Top 30 reserved -> y=30, height=570.
  const win = wm.state.windows[0];
  assert.equal(win.outer.y, 30);
  assert.equal(win.outer.height, 570);
  assert.equal(win.outer.x, 0);
  assert.equal(win.outer.width, 1000);
});

test("schedule(reason) reflows on demand (reserved-zones-changed)", async () => {
  // Add a window, let it settle, then register a zone and call wm.schedule
  // with the new 'reserved-zones-changed' reason. The next compute() should
  // see the shrunken tile region.
  const reservedZones = createReservedZoneRegistry();
  const factory = recordingDriverFactory(reservedZones);
  let observed;
  const wm = createWm(mockCompositor(), OUT, {
    layoutDriverFactory: (t, s) => {
      const d = factory(t, s);
      observed = d._observed;
      return d;
    },
    configure: () => {},
  });
  wm.addWindow(1, rec(1));
  await wm.settled();
  // No zones yet.
  assert.equal(observed.lastInputs.tileRegion.y, 0);
  // Register and schedule.
  reservedZones.set("panel", { outputId: 0, edge: "top", thickness: 40, owner: 999 });
  wm.schedule("reserved-zones-changed");
  await wm.settled();
  assert.equal(observed.lastInputs.tileRegion.y, 40);
  assert.equal(observed.lastInputs.tileRegion.height, 560);
});
