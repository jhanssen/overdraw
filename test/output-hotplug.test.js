// M7 hotplug handlers: makeOnOutputAdded / makeOnOutputRemoved.
//
// GPU-free unit tests over the factored hotplug logic. The handlers are pure
// orchestration over state.outputs + addon (mocked) + compositor (mocked).
// Verifies:
//   - OutputAdded inserts state.outputs[X], creates the wl_output global,
//     reserves the scanout, pushes to layers, recomputes residency, and
//     emits output.added.
//   - OutputAdded with a duplicate id warns and tears down the stale entry.
//   - OutputRemoved fires output.pre-remove BEFORE state.outputs.delete and
//     output.removed AFTER; wl_surface.leave (via residency diff) emits
//     BEFORE destroyGlobalForOutput.
//   - OutputRemoved for an unknown id is ignored.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeOnOutputAdded, makeOnOutputRemoved,
} from '../packages/core/dist/output/hotplug.js';
import { JsCompositor } from '../packages/core/dist/gpu/compositor.js';

// Mock the addon -- just records calls so tests can introspect order.
function makeAddon() {
  const calls = [];
  const addon = {
    calls,
    createGlobalForOutput(name, outputId, handler) {
      calls.push(["createGlobalForOutput", { name, outputId, hasHandler: !!handler }]);
    },
    destroyGlobalForOutput(name, outputId) {
      calls.push(["destroyGlobalForOutput", { name, outputId }]);
    },
    reserveScanoutForOutput(outputId, w, h) {
      calls.push(["reserveScanoutForOutput", { outputId, w, h }]);
    },
    releaseScanoutForOutput(outputId) {
      calls.push(["releaseScanoutForOutput", { outputId }]);
    },
    updateOutputLayout(rects) {
      calls.push(["updateOutputLayout", { rects: rects.map((r) => ({ ...r })) }]);
    },
    clientId(_resource) { return 1; },
  };
  return addon;
}

// Mock state: tracks outputs map, optional wm, optional events.
function makeState({ withWm = true, withEvents = false } = {}) {
  // Stub compositor that satisfies the CompositorSink methods hotplug touches.
  // Not a real JsCompositor instance -- hotplug only calls setOutputs() on it
  // when the instanceof check passes, and surfaceOutputs from residency.
  // For the "calls setOutputs" assertion we use the real class to get past
  // the instanceof guard. (Subclassing avoids dragging in a real device.)
  const setOutputsCalls = [];
  const surfaceOutputsByCall = [];  // record what surfaceOutputs returned
  class StubCompositor extends JsCompositor {
    // Override the constructor's heavy init by re-declaring the methods only.
  }
  const compositor = Object.create(JsCompositor.prototype);
  compositor.setOutputs = (outs) => {
    setOutputsCalls.push(outs.map((o) => ({ ...o })));
  };
  compositor.surfaceOutputs = (_id) => {
    // Return current state.outputs ids -- the residency module diffs
    // surface.enteredOutputs against this. For these tests we don't add
    // mapped surfaces, so the diff is a no-op; the return value just has to
    // be a valid array. (Each call snapshots what state.outputs has at that
    // call time; that's how the "leave fires after setOutputs" property
    // holds: setOutputs ran first, so by the time residency runs, the
    // compositor's view excludes the removed output.)
    const ids = [...state.outputs.keys()];
    surfaceOutputsByCall.push(ids);
    return ids;
  };

  const wm = withWm
    ? { setOutputs: (outs) => wmSetOutputsCalls.push(outs.map((o) => ({ ...o }))) }
    : undefined;
  const wmSetOutputsCalls = [];

  const events = withEvents ? {
    wl_surface: { send_enter() {}, send_leave() {} },
  } : undefined;

  const state = {
    outputs: new Map(),
    wm,
    events,
    surfaces: new Map(),  // empty -- no surfaces to diff
    compositor,
    wlOutputResources: new Map(),
    relayout: (reason) => relayoutCalls.push(reason),
    // Mirrors production: installProtocols always seeds the virtual
    // fallback output. pushOutputsToLayers hands it to the WM when the
    // last real output is removed.
    fallbackOutput: {
      id: -1,
      logicalPosition: { x: 0, y: 0 },
      logicalSize: { width: 0, height: 0 },
      deviceSize: { width: 0, height: 0 },
      scale: 1, name: "__fallback__", description: "overdraw fallback output",
      refreshMhz: 0, transform: 0, physicalWidthMm: 0, physicalHeightMm: 0,
      make: "overdraw", model: "overdraw", edidId: "",
    },
  };
  const relayoutCalls = [];

  return {
    state, compositor, setOutputsCalls, wmSetOutputsCalls,
    surfaceOutputsByCall, relayoutCalls,
  };
}

function makePluginBus() {
  const events = [];
  return {
    events,
    emit(name, payload) { events.push({ name, payload }); },
  };
}

function descriptor(outputId, name = `DP-${outputId + 1}`, w = 1920, h = 1080,
                    edidId = `TST-0001-${outputId.toString(16).padStart(8, "0")}`) {
  return {
    outputId, width: w, height: h,
    refreshMhz: 60000, scale: 1, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280,
    name, make: "test", model: name,
    edidId,
  };
}

function makeDeps({ withWm = true } = {}) {
  const fixture = makeState({ withWm });
  const addon = makeAddon();
  const pluginBus = makePluginBus();
  const logCalls = [];
  const deps = {
    addon, state: fixture.state, compositor: fixture.compositor, pluginBus,
    config: { scale: null },
    allowEdidAutoScale: false,
    log: {
      info: (m) => logCalls.push(["info", m]),
      warn: (m) => logCalls.push(["warn", m]),
    },
  };
  return { deps, fixture, addon, pluginBus, logCalls };
}

test('OutputAdded: inserts state.outputs and fires the wired calls', () => {
  const { deps, fixture, addon, pluginBus } = makeDeps();
  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(1, "DP-2"));

  // state.outputs has the new entry with logical = device when scale=1.
  const rec = fixture.state.outputs.get(1);
  assert.ok(rec, "state.outputs[1] populated");
  assert.equal(rec.id, 1);
  assert.equal(rec.name, "DP-2");
  assert.equal(rec.deviceSize.width, 1920);
  assert.equal(rec.logicalSize.width, 1920);
  assert.equal(rec.scale, 1);
  // Durable identifier propagated through the descriptor; the workspace
  // plugin (step 5) keys preferredOutputs on this.
  assert.equal(rec.edidId, "TST-0001-00000001");

  // wl_output global created for this outputId only if state.events is set;
  // these tests run without events to keep the mock minimal. Verify the
  // calls that DON'T depend on events:
  const reserveCall = addon.calls.find(([n]) => n === "reserveScanoutForOutput");
  assert.deepEqual(reserveCall, ["reserveScanoutForOutput", { outputId: 1, w: 1920, h: 1080 }]);

  // pushOutputsToLayers ran -> compositor.setOutputs + wm.setOutputs +
  // addon.updateOutputLayout each called once with the surviving set
  // (which here is just [1]).
  assert.equal(fixture.setOutputsCalls.length, 1);
  assert.equal(fixture.setOutputsCalls[0][0].id, 1);
  assert.equal(fixture.wmSetOutputsCalls.length, 1);
  const updateCalls = addon.calls.filter(([n]) => n === "updateOutputLayout");
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0][1].rects.length, 1);

  // output.added emitted on the bus AFTER state is set up.
  const added = pluginBus.events.find((e) => e.name === "output.added");
  assert.ok(added, "output.added emitted");
  assert.equal(added.payload.outputId, 1);
  assert.equal(added.payload.name, "DP-2");
});

test('OutputAdded: events-equipped state also creates wl_output global', () => {
  const { deps, addon } = makeDeps();
  deps.state.events = { wl_output: {}, wl_surface: { send_enter() {}, send_leave() {} } };
  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(2));

  const createCall = addon.calls.find(([n]) => n === "createGlobalForOutput");
  assert.ok(createCall, "createGlobalForOutput called");
  assert.equal(createCall[1].name, "wl_output");
  assert.equal(createCall[1].outputId, 2);
  assert.equal(createCall[1].hasHandler, true);
});

test('OutputAdded duplicate id: warn + tear down stale entry first', () => {
  const { deps, fixture, addon, logCalls } = makeDeps();
  // Pre-seed an entry at id 1 (simulating a missed remove). Full OutputRecord
  // shape so nextOutputPosition can iterate it without choking on undefined.
  fixture.state.outputs.set(1, {
    id: 1, name: "stale",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "stale", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "stale",
  });

  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(1, "DP-2"));

  // The stale entry was torn down before the new one was inserted.
  const destroyIdx = addon.calls.findIndex(([n]) => n === "destroyGlobalForOutput");
  const reserveIdx = addon.calls.findIndex(([n]) => n === "reserveScanoutForOutput");
  assert.ok(destroyIdx >= 0, "destroyGlobalForOutput called for stale entry");
  assert.ok(destroyIdx < reserveIdx, "stale destroy precedes new reserve");

  // The new entry is in place.
  assert.equal(fixture.state.outputs.get(1).name, "DP-2");

  // A warn log was emitted about the duplicate.
  const warned = logCalls.find(([lvl, m]) => lvl === "warn" && m.includes("already present"));
  assert.ok(warned, "warned about duplicate outputId");
});

test('OutputRemoved: pre-remove sees state.outputs[X], removed does not', () => {
  const { deps, fixture, addon, pluginBus } = makeDeps();
  // Pre-seed two outputs.
  fixture.state.outputs.set(0, {
    id: 0, name: "DP-1",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "DP-1", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-1",
  });
  fixture.state.outputs.set(1, {
    id: 1, name: "DP-2",
    logicalPosition: { x: 1920, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "DP-2", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-2",
  });

  // Subscribe a "pre-remove" handler that asserts the dying output is
  // still in state.outputs, and a "removed" handler that asserts it isn't.
  let preRemoveSawIt = null;
  let removedSawIt = null;
  pluginBus.emit = (name, payload) => {
    pluginBus.events.push({ name, payload });
    if (name === "output.pre-remove") {
      preRemoveSawIt = fixture.state.outputs.has(payload.outputId);
    }
    if (name === "output.removed") {
      removedSawIt = fixture.state.outputs.has(payload.outputId);
    }
  };

  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 1 });

  assert.equal(preRemoveSawIt, true, "output.pre-remove fires while state.outputs[X] still exists");
  assert.equal(removedSawIt, false, "output.removed fires after state.outputs[X] is gone");
  assert.equal(fixture.state.outputs.size, 1);
});

test('OutputRemoved: order is pre-remove -> setOutputs -> destroyGlobal -> removed -> releaseScanout', () => {
  const { deps, fixture, addon, pluginBus } = makeDeps();
  fixture.state.outputs.set(0, {
    id: 0, name: "DP-1",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "DP-1", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-1",
  });

  // Recompute and emit a single shared timeline so the order across addon
  // calls AND bus events is comparable. Wrap pluginBus.emit and intercept
  // addon calls into one shared `timeline` list.
  const timeline = [];
  const origEmit = pluginBus.emit;
  pluginBus.emit = (name, payload) => {
    timeline.push({ kind: "bus", name, payload });
    origEmit.call(pluginBus, name, payload);
  };
  const origAddonPush = (kind) => (...args) => {
    timeline.push({ kind: "addon", call: kind, args });
    // delegate to the real mock (which records into addon.calls):
    if (kind === "destroyGlobalForOutput") {
      addon.calls.push(["destroyGlobalForOutput", { name: args[0], outputId: args[1] }]);
    } else if (kind === "releaseScanoutForOutput") {
      addon.calls.push(["releaseScanoutForOutput", { outputId: args[0] }]);
    } else if (kind === "updateOutputLayout") {
      addon.calls.push(["updateOutputLayout", { rects: args[0].map((r) => ({ ...r })) }]);
    }
  };
  addon.destroyGlobalForOutput = origAddonPush("destroyGlobalForOutput");
  addon.releaseScanoutForOutput = origAddonPush("releaseScanoutForOutput");
  addon.updateOutputLayout = origAddonPush("updateOutputLayout");
  // Wrap compositor.setOutputs / wm.setOutputs into the timeline too.
  const origSetOutputs = fixture.compositor.setOutputs;
  fixture.compositor.setOutputs = (outs) => {
    timeline.push({ kind: "compositor.setOutputs", outs });
    origSetOutputs(outs);
  };
  const origWm = fixture.state.wm.setOutputs;
  fixture.state.wm.setOutputs = (outs) => {
    timeline.push({ kind: "wm.setOutputs", outs });
    origWm(outs);
  };

  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 0 });

  // Pull out the order key events.
  const idxPreRemove = timeline.findIndex((t) => t.kind === "bus" && t.name === "output.pre-remove");
  const idxSetOutputs = timeline.findIndex((t) => t.kind === "compositor.setOutputs");
  const idxWmSetOutputs = timeline.findIndex((t) => t.kind === "wm.setOutputs");
  const idxUpdateLayout = timeline.findIndex(
    (t) => t.kind === "addon" && t.call === "updateOutputLayout");
  const idxDestroyGlobal = timeline.findIndex(
    (t) => t.kind === "addon" && t.call === "destroyGlobalForOutput");
  const idxRemoved = timeline.findIndex((t) => t.kind === "bus" && t.name === "output.removed");
  const idxRelease = timeline.findIndex(
    (t) => t.kind === "addon" && t.call === "releaseScanoutForOutput");

  assert.ok(idxPreRemove >= 0, "pre-remove fired");
  assert.ok(idxSetOutputs > idxPreRemove, "compositor.setOutputs runs after pre-remove");
  assert.ok(idxWmSetOutputs > idxPreRemove, "wm.setOutputs runs after pre-remove");
  assert.ok(idxUpdateLayout > idxPreRemove, "updateOutputLayout runs after pre-remove");
  assert.ok(idxDestroyGlobal > idxSetOutputs,
    "destroyGlobalForOutput runs AFTER setOutputs (so residency diff can emit leave)");
  assert.ok(idxRemoved > idxDestroyGlobal, "output.removed fires after global teardown");
  assert.ok(idxRelease > idxRemoved, "releaseScanoutForOutput is last");
});

test('OutputRemoved: unknown id is ignored with a warn', () => {
  const { deps, fixture, addon, pluginBus, logCalls } = makeDeps();
  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 99 });

  assert.equal(pluginBus.events.length, 0, "no bus events");
  const dest = addon.calls.find(([n]) => n === "destroyGlobalForOutput");
  assert.equal(dest, undefined, "destroyGlobalForOutput not called");
  const warned = logCalls.find(([lvl, m]) => lvl === "warn" && m.includes("99"));
  assert.ok(warned, "warned about unknown outputId");
});

test('OutputAdded: memorized position is restored when durable key matches', () => {
  const { deps, fixture } = makeDeps();
  // Seed an existing output occupying the [0, 1920) slot so the
  // deterministic fallback would otherwise place a fresh add at x=1920.
  fixture.state.outputs.set(0, {
    id: 0, name: "DP-1",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "DP-1", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-1",
    edidId: "TST-0001-00000000",
  });
  // Memorize a position for the durable key of the about-to-add output.
  const edid = "TST-0001-00000001";
  fixture.state.outputPositionMemory = new Map([[edid, { x: 500, y: 200 }]]);

  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(1, "DP-2", 1920, 1080, edid));

  const rec = fixture.state.outputs.get(1);
  assert.deepEqual(rec.logicalPosition, { x: 500, y: 200 });
});

test('OutputAdded: missing memorized position falls back to deterministic right-of-rightmost', () => {
  const { deps, fixture } = makeDeps();
  fixture.state.outputs.set(0, {
    id: 0, name: "DP-1",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "DP-1", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-1",
    edidId: "TST-0001-00000000",
  });
  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(1, "DP-2"));
  assert.deepEqual(fixture.state.outputs.get(1).logicalPosition, { x: 1920, y: 0 });
});

test('OutputAdded: memorized scale wins over EDID-DPI auto when no config scale set', () => {
  const { deps, fixture } = makeDeps();
  deps.allowEdidAutoScale = true; // would normally pick scale from physical dims
  fixture.state.outputScaleMemory = new Map([["TST-0001-00000001", 2]]);
  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(1, "DP-2", 1920, 1080, "TST-0001-00000001"));
  assert.equal(fixture.state.outputs.get(1).scale, 2);
  // logical = device / scale
  assert.equal(fixture.state.outputs.get(1).logicalSize.width, 960);
});

test('OutputAdded: memorized position uses connector name when EDID is empty', () => {
  const { deps, fixture } = makeDeps();
  // Empty edidId -> durable key is the connector name.
  fixture.state.outputPositionMemory = new Map([["DP-2", { x: 1234, y: 567 }]]);
  const onAdded = makeOnOutputAdded(deps);
  onAdded(descriptor(1, "DP-2", 1920, 1080, ""));
  assert.deepEqual(fixture.state.outputs.get(1).logicalPosition, { x: 1234, y: 567 });
});

test('OutputRemoved: state.wlOutputResources entry for X is cleared', () => {
  const { deps, fixture } = makeDeps();
  fixture.state.outputs.set(0, {
    id: 0, name: "DP-1",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1, description: "DP-1", refreshMhz: 60000, transform: 0,
    physicalWidthMm: 500, physicalHeightMm: 280, make: "t", model: "DP-1",
  });
  fixture.state.wlOutputResources.set(0, new Set(["fake-resource"]));
  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 0 });
  assert.equal(fixture.state.wlOutputResources.has(0), false,
    "wlOutputResources[0] cleared so a future bind at the reused dense id starts clean");
});

// -- Last-output removal: the WM must receive the virtual fallback --
//
// The WM's setOutputs throws on an empty set (it requires >= 1 output at
// all times). Unplugging the only monitor must therefore hand it the
// virtual fallback output, and the removal pipeline must run to
// completion -- a throw here is what once left the compositor unable to
// process the monitor's re-add.

function seedOnlyOutput(fixture) {
  fixture.state.outputs.set(0, {
    id: 0, name: "HDMI-A-1",
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 2560, height: 1440 },
    deviceSize: { width: 3840, height: 2160 },
    scale: 1.5, description: "HDMI-A-1", refreshMhz: 59996, transform: 0,
    physicalWidthMm: 697, physicalHeightMm: 392, make: "t", model: "HDMI-A-1",
    edidId: "TST-0001-00000000",
  });
}

// A WM mock that enforces the real contract, so these tests prove the
// fallback (not an empty set) is what reaches it.
function contractWm(calls) {
  return {
    setOutputs(outs) {
      if (outs.length === 0) throw new Error("setOutputs: outputs must be non-empty");
      calls.push(outs.map((o) => ({ ...o })));
    },
  };
}

test('OutputRemoved: last output hands the virtual fallback to the WM', () => {
  const { deps, fixture, addon, pluginBus, logCalls } = makeDeps();
  seedOnlyOutput(fixture);
  const wmCalls = [];
  fixture.state.wm = contractWm(wmCalls);

  const onRemoved = makeOnOutputRemoved(deps);
  onRemoved({ outputId: 0 });  // must not throw

  assert.equal(wmCalls.length, 1, "wm.setOutputs called once");
  assert.equal(wmCalls[0].length, 1);
  assert.equal(wmCalls[0][0].id, -1, "WM received the fallback output");

  // The compositor sink saw the raw empty set (the fallback never renders;
  // clearing the geometry is what lets the residency diff emit leave).
  assert.deepEqual(fixture.setOutputsCalls.at(-1), []);

  // The removal pipeline ran to completion.
  assert.ok(addon.calls.find(([n]) => n === "destroyGlobalForOutput"),
    "wl_output global destroyed");
  assert.ok(addon.calls.find(([n]) => n === "releaseScanoutForOutput"),
    "scanout released");
  assert.ok(pluginBus.events.find((e) => e.name === "output.removed"),
    "output.removed emitted");
  assert.ok(logCalls.find(([lvl, m]) => lvl === "info" && m.includes("output 0 removed")),
    "removal logged");
  assert.equal(fixture.state.outputs.size, 0);
});

test('OutputAdded after last-removal: WM gets the real output back (no fallback)', () => {
  const { deps, fixture } = makeDeps();
  seedOnlyOutput(fixture);
  const wmCalls = [];
  fixture.state.wm = contractWm(wmCalls);

  makeOnOutputRemoved(deps)({ outputId: 0 });
  makeOnOutputAdded(deps)(descriptor(0, "HDMI-A-1", 3840, 2160));

  assert.equal(wmCalls.length, 2);
  const last = wmCalls.at(-1);
  assert.equal(last.length, 1, "exactly one WM output after re-add");
  assert.equal(last[0].id, 0, "the real output replaced the fallback");
});

test('pushOutputsToLayers: empty set without a fallbackOutput skips the WM push', () => {
  // Pre-installProtocols there is no fallback; the WM (if any) must not be
  // handed an empty set.
  const { deps, fixture } = makeDeps();
  seedOnlyOutput(fixture);
  fixture.state.fallbackOutput = undefined;
  const wmCalls = [];
  fixture.state.wm = contractWm(wmCalls);

  makeOnOutputRemoved(deps)({ outputId: 0 });  // must not throw
  assert.equal(wmCalls.length, 0, "wm.setOutputs not called with nothing to push");
});

// -- JsCompositor.setOutputs must accept the empty set --
//
// hotplug.ts's removal pipeline requires outputsGeom to have dropped the
// removed output BEFORE updateAllSurfaceResidency runs, or the diff can
// never emit wl_surface.leave for it. That includes the last output.

test('JsCompositor.setOutputs([]) clears outputsGeom', () => {
  const c = Object.create(JsCompositor.prototype);
  c.outputsGeom = new Map([[0, {
    id: 0, deviceWidth: 3840, deviceHeight: 2160,
    logicalX: 0, logicalY: 0, scale: 1.5,
  }]]);
  c.cameras = new Map([[0, { x: 10, y: 20, zoom: 2 }]]);
  c.hwCursorCaps = new Map();
  c.hwCursorActive = new Map();
  c.hwCursorLastSent = new Map();
  c.hwCursorHotspotDev = new Map();
  c.cursorShapeResolver = undefined;
  c.cursorTargetSurfaceId = null;
  c.internalCursorSurfaceId = null;
  c.hwCursorEnabled = false;
  const damageCalls = [];
  c.outputDamage = {
    setOutputs: (b) => damageCalls.push(["setOutputs", b]),
    setCamera: (...a) => damageCalls.push(["setCamera", a]),
    full: () => damageCalls.push(["full"]),
  };

  c.setOutputs([]);

  assert.equal(c.outputsGeom.size, 0, "outputsGeom cleared");
  assert.equal(c.cameras.size, 0, "cameras for vanished outputs dropped");
  const damageSet = damageCalls.find(([n]) => n === "setOutputs");
  assert.ok(damageSet, "damage map updated");
  assert.deepEqual(damageSet[1], [], "damage map sees the empty set");
});
