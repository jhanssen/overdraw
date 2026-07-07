// Pure-unit tests for zwlr_output_management_unstable_v1's read-only path
// and Step A's apply rejection matrix. Drives the manager / head / mode /
// configuration handler factories with a mock ctx + plugin bus; verifies:
//
//   - bind catch-up: one head + one mode per state.outputs entry; full
//     event order; done(serial) closes the burst.
//   - output.added / output.removed / output.changed re-emit on every
//     bound manager and bump done(serial).
//   - apply rejects position/scale/mode/transform/adaptive_sync/disabled
//     and accepts a no-op configuration with succeeded.
//   - stale-serial apply replies cancelled.
//   - stop emits finished and stops further dispatches.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import makeManager, {
  makeOutputHead,
  makeOutputMode,
  makeOutputConfiguration,
  makeOutputConfigurationHead,
  installOutputManagerBusHooks,
  _resetForTests,
} from "../packages/core/dist/protocols/zwlr_output_manager_v1.js";

let nextResourceId = 0;
function mockResource(name, version = 4) {
  return {
    __resource: `${name}#${nextResourceId++}`,
    interfaceName: name,
    version,
    destroyed: false,
  };
}

function makeDynamicBus() {
  const subs = new Map();
  return {
    subscribe(name, cb) {
      const arr = subs.get(name) ?? subs.set(name, []).get(name);
      arr.push(cb);
      return { off() {} };
    },
    emit(name, payload) {
      const arr = subs.get(name);
      if (arr) for (const cb of arr) cb(name, payload);
    },
  };
}

function makeOutput(id, overrides = {}) {
  return {
    id,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    deviceSize: { width: 1920, height: 1080 },
    scale: 1,
    name: `DP-${id + 1}`,
    description: "Acme 24 inch",
    refreshMhz: 60000,
    transform: 0,
    physicalWidthMm: 530,
    physicalHeightMm: 300,
    make: "ACME",
    model: "24in",
    edidId: `ACM-1234-DEADBEEF${id}`,
    ...overrides,
  };
}

// Attach the minimal apply-side deps mockCtx omits: an addon with
// updateOutputLayout + clientId stubs, a compositor sink without
// surfaceOutputs (residency updates bail), and a typed-bus emit capture.
function withApplyDeps(ctx) {
  ctx.addon = {
    updateOutputLayout: () => {},
    clientId: () => 0,
    createGlobalForOutput: () => {},
    destroyGlobalForOutput: () => {},
    reserveScanoutForOutput: () => {},
    releaseScanoutForOutput: () => {},
  };
  ctx.state.compositor = {}; // no surfaceOutputs -> residency update is a no-op
  // Capture every pluginBus.emit so tests can assert output.changed.
  const realEmit = ctx.state.pluginBus.emit.bind(ctx.state.pluginBus);
  ctx.state._busEmits = [];
  ctx.state.pluginBus.emit = (name, payload) => {
    ctx.state._busEmits.push([name, payload]);
    realEmit(name, payload);
  };
}

function mockCtx(outputs = []) {
  const sent = [];
  const events = {
    zwlr_output_manager_v1: {
      send_head(resource) {
        const h = mockResource("zwlr_output_head_v1");
        sent.push(["head", { resource, head: h }]);
        return h;
      },
      send_done(resource, serial) { sent.push(["done", { resource, serial }]); },
      send_finished(resource) { sent.push(["finished", { resource }]); },
    },
    zwlr_output_head_v1: {
      send_name(resource, name) { sent.push(["head.name", { resource, name }]); },
      send_description(resource, d) { sent.push(["head.description", { resource, d }]); },
      send_physical_size(resource, w, h) { sent.push(["head.physical_size", { resource, w, h }]); },
      send_mode(resource) {
        const m = mockResource("zwlr_output_mode_v1");
        sent.push(["head.mode", { resource, mode: m }]);
        return m;
      },
      send_enabled(resource, e) { sent.push(["head.enabled", { resource, e }]); },
      send_current_mode(resource, m) { sent.push(["head.current_mode", { resource, m }]); },
      send_position(resource, x, y) { sent.push(["head.position", { resource, x, y }]); },
      send_transform(resource, t) { sent.push(["head.transform", { resource, t }]); },
      send_scale(resource, s) { sent.push(["head.scale", { resource, s }]); },
      send_make(resource, make) { sent.push(["head.make", { resource, make }]); },
      send_model(resource, model) { sent.push(["head.model", { resource, model }]); },
      send_serial_number(resource, sn) { sent.push(["head.serial_number", { resource, sn }]); },
      send_adaptive_sync(resource, s) { sent.push(["head.adaptive_sync", { resource, s }]); },
      send_finished(resource) { sent.push(["head.finished", { resource }]); },
    },
    zwlr_output_mode_v1: {
      send_size(resource, w, h) { sent.push(["mode.size", { resource, w, h }]); },
      send_refresh(resource, r) { sent.push(["mode.refresh", { resource, r }]); },
      send_preferred(resource) { sent.push(["mode.preferred", { resource }]); },
      send_finished(resource) { sent.push(["mode.finished", { resource }]); },
    },
    zwlr_output_configuration_v1: {
      send_succeeded(resource) { sent.push(["config.succeeded", { resource }]); },
      send_failed(resource) { sent.push(["config.failed", { resource }]); },
      send_cancelled(resource) { sent.push(["config.cancelled", { resource }]); },
    },
  };
  const state = {
    outputs: new Map(outputs.map((o) => [o.id, o])),
    pluginBus: makeDynamicBus(),
    _sent: sent,
  };
  return { state, events, addon: {} };
}

beforeEach(() => { _resetForTests(); nextResourceId = 0; });

// ---- bind catch-up ------------------------------------------------------

test("bind emits the initial burst for every live output then done(0)", () => {
  const ctx = mockCtx([makeOutput(0), makeOutput(1)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));

  // Two heads expected (one per output).
  const heads = ctx.state._sent.filter(([k]) => k === "head");
  const modes = ctx.state._sent.filter(([k]) => k === "head.mode");
  const dones = ctx.state._sent.filter(([k]) => k === "done");
  assert.equal(heads.length, 2);
  assert.equal(modes.length, 2);
  // Exactly one done closes the bind catch-up.
  assert.equal(dones.length, 1);
  assert.equal(dones[0][1].serial, 0);
});

test("bind sends per-head static events (name/description/physical_size/make/model/serial_number)", () => {
  const out = makeOutput(0, {
    name: "DP-1",
    description: "Acme 24",
    physicalWidthMm: 530,
    physicalHeightMm: 300,
    make: "ACME",
    model: "24in",
    edidId: "ACM-1234-CAFEBABE",
  });
  const ctx = mockCtx([out]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));

  const kinds = ctx.state._sent.map(([k]) => k);
  // The static events appear once each before any mutable events.
  assert.ok(kinds.indexOf("head.name") < kinds.indexOf("head.enabled"));
  assert.ok(kinds.indexOf("head.description") >= 0);
  assert.ok(kinds.indexOf("head.physical_size") >= 0);
  assert.ok(kinds.indexOf("head.make") >= 0);
  assert.ok(kinds.indexOf("head.model") >= 0);
  // serial_number comes from edidId's trailing segment.
  const sn = ctx.state._sent.find(([k]) => k === "head.serial_number");
  assert.equal(sn[1].sn, "CAFEBABE");
});

test("head v1 (since=1) clients do NOT receive make/model/serial_number", () => {
  const ctx = mockCtx([makeOutput(0)]);
  // Patch send_head to mint the head resource at version 1 (a v1 client).
  const realSendHead = ctx.events.zwlr_output_manager_v1.send_head;
  ctx.events.zwlr_output_manager_v1.send_head = (resource) => {
    const h = realSendHead(resource);
    h.version = 1;
    return h;
  };
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1", 1));
  const kinds = ctx.state._sent.map(([k]) => k);
  // since=2 events are gated by head.version; v1 client sees none.
  assert.ok(!kinds.includes("head.make"));
  assert.ok(!kinds.includes("head.model"));
  assert.ok(!kinds.includes("head.serial_number"));
  // adaptive_sync (since=4) also gated off.
  assert.ok(!kinds.includes("head.adaptive_sync"));
});

test("bind sends one preferred mode per head with size + refresh", () => {
  const out = makeOutput(0, { deviceSize: { width: 2560, height: 1440 }, refreshMhz: 144000 });
  const ctx = mockCtx([out]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));

  const size = ctx.state._sent.find(([k]) => k === "mode.size");
  const refresh = ctx.state._sent.find(([k]) => k === "mode.refresh");
  const preferred = ctx.state._sent.find(([k]) => k === "mode.preferred");
  assert.deepEqual([size[1].w, size[1].h], [2560, 1440]);
  assert.equal(refresh[1].r, 144000);
  assert.ok(preferred);
});

// ---- bus events: add / remove / change ----------------------------------

test("output.added emits a fresh head + bumps done(serial)", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));
  installOutputManagerBusHooks(ctx);
  ctx.state._sent.length = 0;

  ctx.state.outputs.set(1, makeOutput(1));
  ctx.state.pluginBus.emit("output.added", { outputId: 1 });

  assert.equal(ctx.state._sent.filter(([k]) => k === "head").length, 1);
  const done = ctx.state._sent.find(([k]) => k === "done");
  assert.ok(done);
  assert.equal(done[1].serial, 1);
});

test("output.removed sends mode.finished + head.finished + bumps done(serial)", () => {
  const ctx = mockCtx([makeOutput(0), makeOutput(1)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));
  installOutputManagerBusHooks(ctx);
  ctx.state._sent.length = 0;

  ctx.state.pluginBus.emit("output.removed", { outputId: 1 });

  const finishedKinds = ctx.state._sent.filter(([k]) => k === "mode.finished" || k === "head.finished");
  assert.equal(finishedKinds.length, 2);
  // mode.finished must precede head.finished (the head holds the
  // current_mode reference).
  assert.equal(finishedKinds[0][0], "mode.finished");
  assert.equal(finishedKinds[1][0], "head.finished");
  const done = ctx.state._sent.find(([k]) => k === "done");
  assert.equal(done[1].serial, 1);
});

test("output.changed re-emits mutable head state for one outputId", () => {
  const ctx = mockCtx([makeOutput(0), makeOutput(1)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));
  installOutputManagerBusHooks(ctx);
  ctx.state._sent.length = 0;

  // Move output 1 to (1920, 0).
  const o1 = ctx.state.outputs.get(1);
  o1.logicalPosition = { x: 1920, y: 0 };
  ctx.state.pluginBus.emit("output.changed", { outputId: 1 });

  // Position event fires; the other output's position event does not.
  const positions = ctx.state._sent.filter(([k]) => k === "head.position");
  assert.equal(positions.length, 1);
  assert.deepEqual([positions[0][1].x, positions[0][1].y], [1920, 0]);
  // Static events do NOT re-fire on change.
  assert.equal(ctx.state._sent.filter(([k]) => k === "head.name").length, 0);
});

test("output.changed without an outputId re-emits every head this manager owns", () => {
  const ctx = mockCtx([makeOutput(0), makeOutput(1)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("zwlr_output_manager_v1"));
  installOutputManagerBusHooks(ctx);
  ctx.state._sent.length = 0;

  ctx.state.pluginBus.emit("output.changed", {});

  assert.equal(ctx.state._sent.filter(([k]) => k === "head.position").length, 2);
});

test("multiple bound managers each receive their own resource burst", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const m1 = makeManager(ctx);
  const m2 = makeManager(ctx);
  m1.bind(mockResource("mgr1"));
  m2.bind(mockResource("mgr2"));
  installOutputManagerBusHooks(ctx);

  // After bind, each manager got its own head.
  const headsByMgr = new Map();
  for (const [k, ev] of ctx.state._sent) {
    if (k === "head") {
      const cnt = headsByMgr.get(ev.resource) ?? 0;
      headsByMgr.set(ev.resource, cnt + 1);
    }
  }
  assert.equal(headsByMgr.size, 2);
  for (const cnt of headsByMgr.values()) assert.equal(cnt, 1);

  // A subsequent output.added fires once per manager (two head events).
  ctx.state._sent.length = 0;
  ctx.state.outputs.set(1, makeOutput(1));
  ctx.state.pluginBus.emit("output.added", { outputId: 1 });
  assert.equal(ctx.state._sent.filter(([k]) => k === "head").length, 2);
});

// ---- stop ---------------------------------------------------------------

test("stop emits finished and silences subsequent change events", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const r = mockResource("mgr");
  mgr.bind(r);
  installOutputManagerBusHooks(ctx);
  ctx.state._sent.length = 0;

  mgr.stop(r);
  assert.ok(ctx.state._sent.find(([k]) => k === "finished"));

  ctx.state._sent.length = 0;
  ctx.state.outputs.set(1, makeOutput(1));
  ctx.state.pluginBus.emit("output.added", { outputId: 1 });
  // No further events for the stopped manager.
  assert.equal(ctx.state._sent.length, 0);
});

// ---- create_configuration + apply ---------------------------------------

function buildConfig(ctx, mgr, mgrResource, serial) {
  const configRes = mockResource("zwlr_output_configuration_v1");
  mgr.create_configuration(mgrResource, configRes, serial);
  return configRes;
}

function findHeadResource(ctx, outputId) {
  // Walk the bind output for the head minted at this outputId. Each head
  // event carries {resource, head}; the head order matches state.outputs
  // iteration. Cheap for small N.
  const heads = ctx.state._sent.filter(([k]) => k === "head").map(([, ev]) => ev.head);
  const idx = [...ctx.state.outputs.keys()].indexOf(outputId);
  return heads[idx];
}

test("apply with no head mutations succeeds when serial matches", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  cfg.apply(cfgRes);

  assert.ok(ctx.state._sent.find(([k]) => k === "config.succeeded"));
  assert.ok(!ctx.state._sent.find(([k]) => k === "config.failed"));
});

test("apply with stale serial replies cancelled", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  installOutputManagerBusHooks(ctx);
  const cfg = makeOutputConfiguration(ctx);
  // Client thinks current serial is 0 (matches initial bind).
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  // Server-side state changes underneath: bump serial.
  ctx.state.outputs.set(1, makeOutput(1));
  ctx.state.pluginBus.emit("output.added", { outputId: 1 });
  // Apply now sees serial mismatch -> cancelled.
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.cancelled"));
});

test("apply with set_position commits state.outputs.logicalPosition + emits output.changed", () => {
  const ctx = mockCtx([makeOutput(0)]);
  withApplyDeps(ctx);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  installOutputManagerBusHooks(ctx);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);

  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("zwlr_output_configuration_head_v1");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_position(cfgHeadRes, 100, 50);
  cfg.apply(cfgRes);

  assert.ok(ctx.state._sent.find(([k]) => k === "config.succeeded"));
  const rec = ctx.state.outputs.get(0);
  assert.deepEqual(rec.logicalPosition, { x: 100, y: 50 });
  // Memory map populated under the durable key.
  assert.deepEqual(ctx.state.outputPositionMemory.get(rec.edidId), { x: 100, y: 50 });
  // output.changed went out on the plugin bus.
  assert.ok(ctx.state._busEmits.find(([n]) => n === "output.changed"));
});

test("apply with set_scale commits scale + recomputes logicalSize", () => {
  const ctx = mockCtx([makeOutput(0)]);
  withApplyDeps(ctx);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);

  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_scale(cfgHeadRes, 512); // 2.0 in wl_fixed
  cfg.apply(cfgRes);

  assert.ok(ctx.state._sent.find(([k]) => k === "config.succeeded"));
  const rec = ctx.state.outputs.get(0);
  assert.equal(rec.scale, 2);
  // logicalSize = round(device / scale) -> 1920/2 = 960
  assert.deepEqual(rec.logicalSize, { width: 960, height: 540 });
  assert.equal(ctx.state.outputScaleMemory.get(rec.edidId), 2);
});

test("position-on-replug round trip: set_position -> hotplug remove -> hotplug add restores position", async () => {
  // Load the hotplug handlers directly so this test exercises the full
  // memory-consult path the user cares about.
  const { makeOnOutputAdded, makeOnOutputRemoved } =
    await import("../packages/core/dist/output/hotplug.js");

  const edid = "ACM-1234-CAFEBABE";
  const ctx = mockCtx([makeOutput(0, { edidId: edid })]);
  withApplyDeps(ctx);
  // Mirror state.outputs to the WM so hotplug's removal teardown finds
  // it; pure-unit can leave the WM nullable.
  ctx.state.wlOutputResources = new Map();

  // Bind, build a config that moves output 0 to (1500, 100), apply.
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  installOutputManagerBusHooks(ctx);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_position(cfgHeadRes, 1500, 100);
  cfg.apply(cfgRes);

  // Memory map is populated.
  assert.deepEqual(ctx.state.outputPositionMemory.get(edid), { x: 1500, y: 100 });

  // Simulate the user unplugging that monitor. Pure-unit removal: drop
  // it from state.outputs (skip the wm.setOutputs path which isn't wired
  // in this fixture). The position memory must survive the removal.
  ctx.state.outputs.delete(0);
  assert.deepEqual(ctx.state.outputPositionMemory.get(edid), { x: 1500, y: 100 });

  // Now hotplug the same EDID back -- this is the user replug after a
  // few seconds of disconnect. The hotplug handler must consult the
  // memory map and place it back at (1500, 100), NOT at the
  // right-of-rightmost fallback.
  const hotplugDeps = {
    addon: ctx.addon,
    state: ctx.state,
    compositor: ctx.state.compositor,
    pluginBus: ctx.state.pluginBus,
    config: { scale: null },
    allowEdidAutoScale: false,
  };
  const onAdded = makeOnOutputAdded(hotplugDeps);
  onAdded({
    outputId: 0,
    width: 1920, height: 1080,
    refreshMhz: 60000, scale: 1, transform: 0,
    physicalWidthMm: 530, physicalHeightMm: 300,
    name: "DP-1", make: "ACME", model: "24in",
    edidId: edid,
  });

  // Output is back at its prior position.
  assert.deepEqual(ctx.state.outputs.get(0).logicalPosition, { x: 1500, y: 100 });
});

test("test() with set_position validates but does NOT commit", () => {
  const ctx = mockCtx([makeOutput(0)]);
  withApplyDeps(ctx);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);

  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_position(cfgHeadRes, 100, 50);
  cfg.test(cfgRes);

  assert.ok(ctx.state._sent.find(([k]) => k === "config.succeeded"));
  // Position unchanged.
  assert.deepEqual(ctx.state.outputs.get(0).logicalPosition, { x: 0, y: 0 });
  assert.equal(ctx.state.outputPositionMemory, undefined);
});

test("apply with set_mode against an unadvertised mode rejected", () => {
  // A mode resource the manager never minted (or one from a different head)
  // can't resolve to dims/refresh; the apply rejects.
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  // Mint a fresh mode resource that isn't tracked by any head.
  cfgHead.set_mode(cfgHeadRes, mockResource("zwlr_output_mode_v1"));
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
});

test("apply with set_custom_mode rejected (no DRM mode-table validation)", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_custom_mode(cfgHeadRes, 2560, 1440, 60000);
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
});

test("apply with set_transform != 0 / set_adaptive_sync rejected", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);

  // set_transform != 0
  let cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  let headRes = findHeadResource(ctx, 0);
  let cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_transform(cfgHeadRes, 1);
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));

  // set_adaptive_sync
  ctx.state._sent.length = 0;
  cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_adaptive_sync(cfgHeadRes, 1);
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
});

test("apply with set_mode picks the advertised mode and dispatches switchOutputMode", async () => {
  const out = makeOutput(0, {
    deviceSize: { width: 1920, height: 1080 },
    refreshMhz: 60000,
    edidId: "ACM-1234-CAFEBABE",
  });
  const ctx = mockCtx([out]);
  withApplyDeps(ctx);
  installOutputManagerBusHooks(ctx);

  // Advertise three modes on the output BEFORE binding (the simulation
  // mirrors what the GPU process's OutputModes frame populates).
  out.availableModes = [
    { width: 1920, height: 1080, refreshMhz: 60000,  preferred: true },
    { width: 2560, height: 1440, refreshMhz: 144000, preferred: false },
    { width: 3840, height: 2160, refreshMhz: 60000,  preferred: false },
  ];

  // Capture switchOutputMode dispatches.
  const switches = [];
  ctx.addon.switchOutputMode = (outputId, w, h, refresh) =>
    switches.push({ outputId, w, h, refresh });

  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);

  // The three advertised modes appeared as head.mode children.
  const modeResources = ctx.state._sent
    .filter(([k]) => k === "head.mode")
    .map(([, ev]) => ev.mode);
  assert.equal(modeResources.length, 3, "all three advertised modes minted");
  // Pick the 2560x1440 mode (the third in our list).
  const targetMode = modeResources[1];

  // Build a config that picks that mode.
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_mode(cfgHeadRes, targetMode);
  cfg.apply(cfgRes);

  assert.ok(ctx.state._sent.find(([k]) => k === "config.succeeded"));
  assert.equal(switches.length, 1);
  assert.deepEqual(switches[0],
    { outputId: 0, w: 2560, h: 1440, refresh: 144000 });
});

test("apply with disable_head rejected as `failed` in v1", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);

  const headRes = findHeadResource(ctx, 0);
  cfg.disable_head(cfgRes, headRes);
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
});

test("test() validates without committing and never sends succeeded twice", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);

  cfg.test(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.succeeded"));

  // After test() the configuration is "used"; another apply replies failed
  // (no second succeeded).
  ctx.state._sent.length = 0;
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
  assert.ok(!ctx.state._sent.find(([k]) => k === "config.succeeded"));
});

test("setting the same property twice poisons the configuration", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgHead = makeOutputConfigurationHead(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfgHead.set_position(cfgHeadRes, 0, 0);
  cfgHead.set_position(cfgHeadRes, 0, 0); // second set: poison
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
});

test("enable_head + disable_head on the same head poisons the configuration", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  mgr.bind(mgrRes);
  const cfg = makeOutputConfiguration(ctx);
  const cfgRes = buildConfig(ctx, mgr, mgrRes, 0);
  const headRes = findHeadResource(ctx, 0);
  const cfgHeadRes = mockResource("cfghead");
  cfg.enable_head(cfgRes, cfgHeadRes, headRes);
  cfg.disable_head(cfgRes, headRes);
  cfg.apply(cfgRes);
  assert.ok(ctx.state._sent.find(([k]) => k === "config.failed"));
});

// ---- head/mode lifetime ------------------------------------------------

test("head.release drops the entry but leaves mode resource alive for separate destroy", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("mgr"));
  const head = makeOutputHead(ctx);
  const mode = makeOutputMode(ctx);

  const headRes = ctx.state._sent.find(([k]) => k === "head")[1].head;
  const modeRes = ctx.state._sent.find(([k]) => k === "head.mode")[1].mode;

  head.release(headRes);
  mode.release(modeRes);
  // No events fired on release; the trampoline tears down the resources.
  // Smoke: subsequent emissions to those resources are unhooked from the
  // owner maps and downstream finishHead is a no-op (no double-finished).
});

test("mode.release prunes the head's mode list; a later update never re-selects it", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("mgr"));
  installOutputManagerBusHooks(ctx);
  const mode = makeOutputMode(ctx);
  const modeRes = ctx.state._sent.find(([k]) => k === "head.mode")[1].mode;

  // Client releases the current mode (destructor request: the resource is
  // destroyed under it). current_mode must not reference it afterwards.
  mode.release(modeRes);
  modeRes.destroyed = true;

  ctx.state._sent.length = 0;
  ctx.state.pluginBus.emit("output.changed", { outputId: 0 });

  assert.equal(ctx.state._sent.filter(([k]) => k === "head.current_mode").length, 0);
  // The rest of the mutable burst still fires.
  assert.equal(ctx.state._sent.filter(([k]) => k === "head.position").length, 1);
});

test("a destroyed mode resource is never selected as current_mode (disconnect case)", () => {
  const ctx = mockCtx([makeOutput(0)]);
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("mgr"));
  installOutputManagerBusHooks(ctx);
  const modeRes = ctx.state._sent.find(([k]) => k === "head.mode")[1].mode;

  // No release request ran (client died); only the destroyed flag flips.
  modeRes.destroyed = true;

  ctx.state._sent.length = 0;
  ctx.state.pluginBus.emit("output.changed", { outputId: 0 });

  assert.equal(ctx.state._sent.filter(([k]) => k === "head.current_mode").length, 0);
});
