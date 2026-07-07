// Pure-unit tests for ext_workspace_v1. Drives the handler factories with a
// mock ctx + dynamic bus; verifies on-bind catch-up, broadcast on
// workspace.* / output.* bus events, the atomicity-of-done invariant, and
// that inbound requests (activate / remove / create_workspace) route
// through state.workspaceDriver.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import makeManager, {
  makeExtWorkspaceGroupHandle,
  makeExtWorkspaceHandle,
  installExtWorkspaceBusHooks,
  sweepDisconnected,
  _resetForTests,
} from "../packages/core/dist/protocols/ext_workspace_v1.js";

// Mirror the bitfield values from the generated module so tests don't
// reach into TS internals.
const STATE = { active: 1, urgent: 2, hidden: 4 };
const GROUP_CAPS = { create_workspace: 1 };
const WS_CAPS = { activate: 1, deactivate: 2, remove: 4, assign: 8 };

function mockResource(name) {
  return { __resource: Symbol(name), interfaceName: name, version: 1, destroyed: false };
}

function makeDynamicBus() {
  const subs = new Map();
  return {
    subscribe(name, cb) {
      let arr = subs.get(name);
      if (!arr) { arr = []; subs.set(name, arr); }
      arr.push(cb);
      return { off() {} };
    },
    emit(name, payload) {
      const arr = subs.get(name);
      if (arr) for (const cb of arr) cb(name, payload);
    },
  };
}

function mockCtx() {
  const sent = [];
  // Resource minting: each send_* that creates a new_id receives `null` as
  // the placeholder and is expected to return the freshly-minted resource.
  const groupResources = [];
  const wsResources = [];
  const events = {
    ext_workspace_manager_v1: {
      send_workspace_group(_resource, _placeholder) {
        const r = mockResource("ext_workspace_group_handle_v1");
        groupResources.push(r);
        sent.push(["workspace_group", { resource: r }]);
        return r;
      },
      send_workspace(_resource, _placeholder) {
        const r = mockResource("ext_workspace_handle_v1");
        wsResources.push(r);
        sent.push(["workspace", { resource: r }]);
        return r;
      },
      send_done(resource) { sent.push(["manager_done", { resource }]); },
      send_finished(resource) { sent.push(["finished", { resource }]); },
    },
    ext_workspace_group_handle_v1: {
      send_capabilities(resource, capabilities) {
        sent.push(["group_capabilities", { resource, capabilities }]);
      },
      send_output_enter(resource, output) {
        sent.push(["output_enter", { resource, output }]);
      },
      send_output_leave(resource, output) {
        sent.push(["output_leave", { resource, output }]);
      },
      send_workspace_enter(resource, workspace) {
        sent.push(["workspace_enter", { resource, workspace }]);
      },
      send_workspace_leave(resource, workspace) {
        sent.push(["workspace_leave", { resource, workspace }]);
      },
      send_removed(resource) { sent.push(["group_removed", { resource }]); },
    },
    ext_workspace_handle_v1: {
      send_id(resource, id) { sent.push(["id", { resource, id }]); },
      send_name(resource, name) { sent.push(["name", { resource, name }]); },
      send_coordinates(resource, coordinates) {
        // unpack the u32 LE for assertions
        const dv = new DataView(coordinates.buffer, coordinates.byteOffset, coordinates.byteLength);
        const coord = dv.getUint32(0, true);
        sent.push(["coordinates", { resource, coord }]);
      },
      send_state(resource, state) { sent.push(["state", { resource, state }]); },
      send_capabilities(resource, capabilities) {
        sent.push(["ws_capabilities", { resource, capabilities }]);
      },
      send_removed(resource) { sent.push(["ws_removed", { resource }]); },
    },
  };
  const wlOutputs = new Map(); // outputId -> Set<Resource>
  const driverCalls = [];
  const state = {
    pluginBus: makeDynamicBus(),
    wlOutputResources: wlOutputs,
    workspaceDriver: {
      async create(spec) { driverCalls.push(["create", spec]); return { handle: 99, index: 99 }; },
      async destroy(index, outputId) { driverCalls.push(["destroy", { index, outputId }]); },
      async show(index, outputId) { driverCalls.push(["show", { index, outputId }]); },
    },
  };
  const addon = {
    clientId(_resource) { return 1; },
  };
  // Helper: register a wl_output resource for outputId so output_enter has
  // something to address.
  function addWlOutput(outputId, clientId = 1) {
    let set = wlOutputs.get(outputId);
    if (!set) { set = new Set(); wlOutputs.set(outputId, set); }
    const r = mockResource("wl_output");
    // tag with the client id by override of addon.clientId
    set.add(r);
    return r;
  }
  return { events, state, addon, sent, groupResources, wsResources, driverCalls, addWlOutput };
}

beforeEach(() => { _resetForTests(); });

// ---- Bus events -> wire events --------------------------------------------

test("output.added emits workspace_group + capabilities + output_enter + done", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  // bind a manager so we have someone to emit to.
  const mgr = mockResource("ext_workspace_manager_v1");
  makeManager(ctx).bind(mgr);
  ctx.sent.length = 0;

  ctx.state.pluginBus.emit("output.added", { outputId: 1 });

  const kinds = ctx.sent.map(([k]) => k);
  assert.deepEqual(kinds.slice(0, 3),
    ["workspace_group", "group_capabilities", "manager_done"],
    `got ${kinds.join(",")}`);
  // Capabilities advertise create_workspace.
  const caps = ctx.sent.find(([k]) => k === "group_capabilities");
  assert.equal(caps[1].capabilities, GROUP_CAPS.create_workspace);
});

test("workspace.created emits workspace + id + coordinates + state + capabilities + done; workspace_enter on group", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const mgr = mockResource("ext_workspace_manager_v1");
  makeManager(ctx).bind(mgr);

  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.sent.length = 0;

  ctx.state.pluginBus.emit("workspace.created",
    { handle: 5, index: 1, outputId: 0, name: "main" });

  const kinds = ctx.sent.map(([k]) => k);
  // workspace + id + name + coordinates + state + ws_capabilities + workspace_enter + manager_done
  assert.ok(kinds.includes("workspace"), `expected workspace; got ${kinds.join(",")}`);
  assert.ok(kinds.includes("id"));
  assert.ok(kinds.includes("name"));
  assert.ok(kinds.includes("coordinates"));
  assert.ok(kinds.includes("state"));
  assert.ok(kinds.includes("ws_capabilities"));
  assert.ok(kinds.includes("workspace_enter"));
  // Exactly one done per manager.
  const dones = kinds.filter((k) => k === "manager_done");
  assert.equal(dones.length, 1);

  // Coordinate is index-1.
  const coord = ctx.sent.find(([k]) => k === "coordinates")[1].coord;
  assert.equal(coord, 0);
  // Capabilities advertise activate|remove, NOT deactivate or assign.
  const caps = ctx.sent.find(([k]) => k === "ws_capabilities")[1].capabilities;
  assert.equal(caps, WS_CAPS.activate | WS_CAPS.remove);
});

test("workspace.shown coalesces prev+next state into one done", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  makeManager(ctx).bind(mockResource("mgr"));

  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  // Mark workspace 1 shown (mimics the boot state where the plugin's init()
  // already shows the first one).
  ctx.state.pluginBus.emit("workspace.shown", { handle: 1, index: 1, outputId: 0 });
  ctx.sent.length = 0;

  // Show workspace 2.
  ctx.state.pluginBus.emit("workspace.shown", { handle: 2, index: 2, outputId: 0 });

  const states = ctx.sent.filter(([k]) => k === "state");
  // Two state events: one clearing active on the old, one setting active on the new.
  assert.equal(states.length, 2);
  // The new one has the active bit set, the old has it cleared.
  const setActive = states.find(([, e]) => (e.state & STATE.active) !== 0);
  const clearActive = states.find(([, e]) => (e.state & STATE.active) === 0);
  assert.ok(setActive && clearActive);
  // Exactly one done.
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 1);
});

// The plugin's registry.show() emits BOTH workspace.hidden{prev} AND
// workspace.shown{next} in that order on the plugin bus (single
// applyEffects pass). The protocol handler's contract: the previously-
// active workspace's state(active=0) MUST reach the wire alongside the
// newly-active workspace's state(active=1), coalesced into one done per
// manager. This test guards the regression where the workspace.hidden
// handler was clearing shownByOutput[outputId] before workspace.shown
// could read it -- the prev state(0) was then silently dropped and
// clients saw two simultaneously-active workspaces.
test("workspace.hidden followed by workspace.shown emits state(0) for prev + state(1) for next", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  makeManager(ctx).bind(mockResource("mgr"));
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 1, index: 1, outputId: 0 });
  // Capture which wire resource each workspace handle was minted as,
  // so the state assertion can be precise about who gained/lost active.
  const wsRes1 = ctx.wsResources[0];
  const wsRes2 = ctx.wsResources[1];
  ctx.sent.length = 0;

  // The registry.show() side-effect order is hidden -> shown.
  ctx.state.pluginBus.emit("workspace.hidden", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 2, index: 2, outputId: 0 });

  const states = ctx.sent.filter(([k]) => k === "state");
  // The previously-active workspace must drop its active bit.
  const prevState = states.find(([, e]) => e.resource === wsRes1);
  assert.ok(prevState, "expected a state event for previously-active workspace 1");
  assert.equal(prevState[1].state & STATE.active, 0,
    "previously-active workspace must have active bit cleared on wire");
  // The newly-active workspace must gain its active bit.
  const nextState = states.find(([, e]) => e.resource === wsRes2);
  assert.ok(nextState, "expected a state event for newly-active workspace 2");
  assert.equal(nextState[1].state & STATE.active, STATE.active,
    "newly-active workspace must have active bit set on wire");
});

// Multi-output guard: a workspace.shown on output 0 must not disturb the
// active bit of the workspace shown on output 1. The bug had emitted a
// stale state for output 1's workspace because shownByOutput was a
// single key/value map -- this test pins the per-output isolation.
test("workspace.shown on output 0 does NOT re-emit state for output 1's shown workspace", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  ctx.addWlOutput(1);
  installExtWorkspaceBusHooks(ctx);
  makeManager(ctx).bind(mockResource("mgr"));
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("output.added", { outputId: 1 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 1, outputId: 1 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 3, index: 2, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 2, index: 1, outputId: 1 });
  // wsResources: [0]=h1 on out0, [1]=h2 on out1, [2]=h3 on out0
  const wsRes2 = ctx.wsResources[1];
  ctx.sent.length = 0;

  // Switch from h1 to h3 on output 0.
  ctx.state.pluginBus.emit("workspace.hidden", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 3, index: 2, outputId: 0 });

  // No state event should reference wsRes2 (output 1's workspace).
  const out1States = ctx.sent.filter(([k, e]) => k === "state" && e.resource === wsRes2);
  assert.equal(out1States.length, 0,
    "output 1's workspace should not receive a state event when output 0 changes");
});

// End-to-end click simulation. Mirrors what Waybar does: bind a manager,
// observe boot, send activate() + commit() through the handle handler,
// then have the driver mock fire the real plugin bus events (hidden +
// shown) that the registry would emit. Asserts: the activate buffers
// until commit; the commit drains the driver call; the wire then shows
// state(0) for prev + state(1) for new + exactly one trailing done; and
// the previously-active workspace's active bit is cleared.
test("end-to-end click: activate + commit produces correct state transitions on the wire", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 1, index: 1, outputId: 0 });
  const wsRes1 = ctx.wsResources[0];
  const wsRes2 = ctx.wsResources[1];

  // Override driver.show to emit the real plugin-bus events the
  // registry would: workspace.hidden then workspace.shown.
  ctx.state.workspaceDriver = {
    async create() { return {}; },
    async destroy() { return {}; },
    async show(index, outputId) {
      // Resolve which handle is being shown by walking the cache. The
      // protocol handler captured (index, outputId) at request time.
      // In this test, index=2 on output 0 -> handle 2.
      ctx.state.pluginBus.emit("workspace.hidden", { handle: 1, index: 1, outputId });
      ctx.state.pluginBus.emit("workspace.shown", { handle: 2, index, outputId });
    },
  };

  ctx.sent.length = 0;

  // Click: Waybar sends activate() + commit().
  makeExtWorkspaceHandle(ctx).activate(wsRes2);
  m.commit(mgrRes);
  // Wait for the driver chain + the batch-trailing done.
  for (let i = 0; i < 10; i++) await Promise.resolve();

  const states = ctx.sent.filter(([k]) => k === "state");
  // Two state events: prev cleared, new set.
  assert.equal(states.length, 2,
    `expected 2 state events; got ${states.length}: ${JSON.stringify(states)}`);
  const prevState = states.find(([, e]) => e.resource === wsRes1);
  const nextState = states.find(([, e]) => e.resource === wsRes2);
  assert.ok(prevState && nextState,
    "expected one state for prev (ws1) and one for new (ws2)");
  assert.equal(prevState[1].state & STATE.active, 0,
    "ws1 must have lost its active bit");
  assert.equal(nextState[1].state & STATE.active, STATE.active,
    "ws2 must have gained its active bit");
  // Exactly one trailing done for the whole batch.
  const dones = ctx.sent.filter(([k]) => k === "manager_done");
  assert.equal(dones.length, 1,
    `expected exactly one batch-trailing done; got ${dones.length}`);
});

test("workspace.urgency-changed re-emits state with urgent bit; coalesced done", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  makeManager(ctx).bind(mockResource("mgr"));
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 1, index: 1, outputId: 0 });
  ctx.sent.length = 0;

  // Mark workspace 2 urgent.
  ctx.state.pluginBus.emit("workspace.urgency-changed",
    { workspaceId: 2, urgent: true, outputId: 0 });
  const states = ctx.sent.filter(([k]) => k === "state");
  assert.equal(states.length, 1);
  assert.equal(states[0][1].state, STATE.urgent);
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 1);

  // Clear urgency.
  ctx.sent.length = 0;
  ctx.state.pluginBus.emit("workspace.urgency-changed",
    { workspaceId: 2, urgent: false, outputId: 0 });
  const states2 = ctx.sent.filter(([k]) => k === "state");
  assert.equal(states2.length, 1);
  assert.equal(states2[0][1].state, 0);
});

test("workspace.renumbered re-emits coordinates per changed workspace; one done", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  makeManager(ctx).bind(mockResource("mgr"));
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 3, index: 3, outputId: 0 });
  ctx.sent.length = 0;

  ctx.state.pluginBus.emit("workspace.renumbered", {
    outputId: 0,
    changes: [{ handle: 2, newIndex: 1 }, { handle: 3, newIndex: 2 }],
  });

  const coords = ctx.sent.filter(([k]) => k === "coordinates");
  assert.equal(coords.length, 2);
  // Both new coordinates.
  const values = coords.map(([, e]) => e.coord).sort();
  assert.deepEqual(values, [0, 1]);
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 1);
});

test("workspace.destroyed emits workspace_leave + ws_removed; one done", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  makeManager(ctx).bind(mockResource("mgr"));
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.sent.length = 0;

  ctx.state.pluginBus.emit("workspace.destroyed", { handle: 1, formerIndex: 1, outputId: 0 });

  const kinds = ctx.sent.map(([k]) => k);
  assert.ok(kinds.includes("workspace_leave"));
  assert.ok(kinds.includes("ws_removed"));
  assert.equal(kinds.filter((k) => k === "manager_done").length, 1);
});

// ---- Catch-up burst on bind -----------------------------------------------

test("late bind: a manager bound after workspaces exist sees full catch-up + one done", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  // Drive plugin events BEFORE binding.
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0, name: "main" });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.shown", { handle: 1, index: 1, outputId: 0 });
  ctx.sent.length = 0;

  // Now bind. The catch-up burst should contain group + group_capabilities
  // + output_enter + 2 workspaces + their metadata + one done.
  makeManager(ctx).bind(mockResource("late-mgr"));

  const kinds = ctx.sent.map(([k]) => k);
  assert.equal(kinds.filter((k) => k === "workspace_group").length, 1);
  assert.equal(kinds.filter((k) => k === "workspace").length, 2);
  // active bit on workspace 1 only.
  const states = ctx.sent.filter(([k]) => k === "state");
  assert.equal(states.length, 2);
  const activeCount = states.filter(([, e]) => (e.state & STATE.active) !== 0).length;
  assert.equal(activeCount, 1);
  // Exactly one trailing done for the entire catch-up.
  assert.equal(kinds.filter((k) => k === "manager_done").length, 1);
});

// ---- Inbound requests -----------------------------------------------------

// Drain pending microtasks so the manager.commit driver-chain Promise
// resolves (the chain dispatches driver calls one at a time and emits
// `done` on settle). Returns after a few ticks to cover the entire chain.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("activate buffers; driver call + done fire only on commit", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 7, index: 3, outputId: 0 });
  const wsRes = ctx.wsResources[ctx.wsResources.length - 1];
  ctx.sent.length = 0;
  ctx.driverCalls.length = 0;

  // Pre-commit: handler enqueues; driver NOT yet called.
  makeExtWorkspaceHandle(ctx).activate(wsRes);
  assert.equal(ctx.driverCalls.length, 0,
    "activate must buffer until commit");
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 0,
    "no done before commit");

  // commit drains: driver fires, then one trailing done.
  m.commit(mgrRes);
  await flushMicrotasks();
  assert.equal(ctx.driverCalls.length, 1);
  assert.equal(ctx.driverCalls[0][0], "show");
  assert.deepEqual(ctx.driverCalls[0][1], { index: 3, outputId: 0 });
  const dones = ctx.sent.filter(([k]) => k === "manager_done");
  assert.equal(dones.length, 1, `expected exactly one done after commit; got ${dones.length}`);
});

test("batched activate; activate; commit: both drive in order, ONE trailing done", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 2, index: 2, outputId: 0 });
  const wsRes1 = ctx.wsResources[ctx.wsResources.length - 2];
  const wsRes2 = ctx.wsResources[ctx.wsResources.length - 1];
  ctx.sent.length = 0;
  ctx.driverCalls.length = 0;

  const h = makeExtWorkspaceHandle(ctx);
  h.activate(wsRes1);
  h.activate(wsRes2);
  // Still buffered; nothing on the wire yet.
  assert.equal(ctx.driverCalls.length, 0);
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 0);

  m.commit(mgrRes);
  await flushMicrotasks();
  // Both driver calls fired, in order.
  assert.equal(ctx.driverCalls.length, 2);
  assert.equal(ctx.driverCalls[0][0], "show");
  assert.equal(ctx.driverCalls[0][1].index, 1);
  assert.equal(ctx.driverCalls[1][0], "show");
  assert.equal(ctx.driverCalls[1][1].index, 2);
  // Exactly one done covering the whole batch.
  const dones = ctx.sent.filter(([k]) => k === "manager_done");
  assert.equal(dones.length, 1,
    `expected exactly one done for the batch; got ${dones.length}`);
});

test("remove buffers until commit", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 7, index: 3, outputId: 0 });
  const wsRes = ctx.wsResources[ctx.wsResources.length - 1];
  ctx.driverCalls.length = 0;

  makeExtWorkspaceHandle(ctx).remove(wsRes);
  assert.equal(ctx.driverCalls.length, 0);
  m.commit(mgrRes);
  await flushMicrotasks();
  assert.equal(ctx.driverCalls.length, 1);
  assert.equal(ctx.driverCalls[0][0], "destroy");
});

test("workspace.deactivate / assign are no-ops (capabilities not advertised)", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 7, index: 3, outputId: 0 });
  const wsRes = ctx.wsResources[ctx.wsResources.length - 1];
  const groupRes = ctx.groupResources[ctx.groupResources.length - 1];

  const h = makeExtWorkspaceHandle(ctx);
  h.deactivate(wsRes);
  h.assign(wsRes, groupRes);
  m.commit(mgrRes);
  await flushMicrotasks();
  assert.equal(ctx.driverCalls.length, 0);
});

test("group.create_workspace buffers; commit drives driver.create with name", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  const groupRes = ctx.groupResources[ctx.groupResources.length - 1];
  ctx.driverCalls.length = 0;

  makeExtWorkspaceGroupHandle(ctx).create_workspace(groupRes, "scratch");
  assert.equal(ctx.driverCalls.length, 0, "create must buffer until commit");
  m.commit(mgrRes);
  await flushMicrotasks();
  assert.equal(ctx.driverCalls.length, 1);
  assert.deepEqual(ctx.driverCalls[0][1], { outputId: 0, name: "scratch" });

  // Empty workspace string -> omit the optional name field in the spec.
  ctx.driverCalls.length = 0;
  makeExtWorkspaceGroupHandle(ctx).create_workspace(groupRes, "");
  m.commit(mgrRes);
  await flushMicrotasks();
  assert.deepEqual(ctx.driverCalls[0][1], { outputId: 0 });
});

test("empty commit is a no-op (no done emitted)", async () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.sent.length = 0;

  m.commit(mgrRes);
  await flushMicrotasks();
  // A commit with no pending requests changes no state; no done.
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 0);
});

test("during commit drain, a peer manager NOT batching still sees per-event done", async () => {
  // Two managers. One batches a commit; the other binds afterward and
  // observes a bus event mid-drain. The peer must see its normal
  // per-event done (its `batching` flag is false). This guards against
  // the batching-skip accidentally being module-global instead of
  // per-manager.
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);

  // Bind manager A and queue an activate, then commit.
  const aRes = mockResource("mgrA");
  m.bind(aRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 7, index: 1, outputId: 0 });
  const wsResA = ctx.wsResources[ctx.wsResources.length - 1];

  // Drive a manual driver mock that fires a bus event during await
  // (mimicking the registry's workspace.shown emit when show() runs).
  ctx.state.workspaceDriver = {
    async create() { return {}; },
    async destroy() { return {}; },
    async show(_index, outputId) {
      // Emit a bus event mid-drain: this is what a real plugin would
      // do (workspace.shown fires from inside the plugin's apply).
      ctx.state.pluginBus.emit("workspace.urgency-changed",
        { workspaceId: 7, urgent: true, outputId });
    },
  };

  makeExtWorkspaceHandle(ctx).activate(wsResA);

  // Bind manager B AFTER A queues but BEFORE A commits. B is fresh,
  // batching=false. Pre-commit done count for A = 1 (bind's catch-up).
  const bRes = mockResource("mgrB");
  m.bind(bRes);
  ctx.sent.length = 0;

  m.commit(aRes);
  await flushMicrotasks();

  // Count manager_done by recipient.
  const dones = new Map();
  for (const [k, ev] of ctx.sent) {
    if (k !== "manager_done") continue;
    dones.set(ev.resource, (dones.get(ev.resource) ?? 0) + 1);
  }
  // A: one trailing done for the whole batch (the urgency-changed bus
  // event that fired mid-drain was suppressed for A).
  assert.equal(dones.get(aRes), 1,
    `mgrA: expected 1 batch-trailing done; got ${dones.get(aRes) ?? 0}`);
  // B: NOT batching, so it sees the urgency-changed event's per-event
  // done -- proving the suppression flag is per-manager, not global.
  assert.equal(dones.get(bRes), 1,
    `mgrB: expected 1 per-event done from the mid-drain bus emit; got ${dones.get(bRes) ?? 0}`);
});

// ---- Manager.stop lifecycle -----------------------------------------------

test("manager.stop emits finished + the manager stops receiving events", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.sent.length = 0;

  m.stop(mgrRes);
  assert.equal(ctx.sent.filter(([k]) => k === "finished").length, 1);

  // After stop, further bus events do NOT broadcast to this manager.
  ctx.sent.length = 0;
  ctx.state.pluginBus.emit("workspace.created", { handle: 1, index: 1, outputId: 0 });
  // No emissions to a torn-down manager: no workspace/state/done.
  assert.equal(ctx.sent.length, 0);
});

// ---- Without a workspaceDriver: inbound requests silently drop ------------

test("no workspaceDriver: activate/remove/create enqueue but commit drains to nothing (no throw, no done)", async () => {
  const ctx = mockCtx();
  delete ctx.state.workspaceDriver;
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const m = makeManager(ctx);
  const mgrRes = mockResource("mgr");
  m.bind(mgrRes);
  ctx.state.pluginBus.emit("output.added", { outputId: 0 });
  ctx.state.pluginBus.emit("workspace.created", { handle: 7, index: 3, outputId: 0 });
  const wsRes = ctx.wsResources[ctx.wsResources.length - 1];
  const groupRes = ctx.groupResources[ctx.groupResources.length - 1];
  ctx.sent.length = 0;

  const h = makeExtWorkspaceHandle(ctx);
  const g = makeExtWorkspaceGroupHandle(ctx);
  h.activate(wsRes);
  h.remove(wsRes);
  g.create_workspace(groupRes, "x");
  m.commit(mgrRes);
  await flushMicrotasks();
  // Driver is absent; the batch drain bails before dispatching. No done
  // is emitted (no state changed because no apply happened).
  assert.equal(ctx.sent.filter(([k]) => k === "manager_done").length, 0);
});

// ---- disconnect without stop() -------------------------------------------

test("a manager destroyed without stop() is skipped and pruned on the next bus event", () => {
  const ctx = mockCtx();
  ctx.addWlOutput(0);
  installExtWorkspaceBusHooks(ctx);
  const mgrRes = mockResource("ext_workspace_manager_v1");
  makeManager(ctx).bind(mgrRes);

  // Client disconnected: no stop request ran, only the destroyed flag flips.
  mgrRes.destroyed = true;
  ctx.sent.length = 0;

  // Must not throw (a mint on the dead resource would return undefined and
  // WeakMap.set(undefined) would TypeError inside the bus subscriber).
  ctx.state.pluginBus.emit("workspace.created",
    { handle: 7, outputId: 0, index: 1, name: "one" });
  assert.equal(ctx.sent.length, 0);

  // A manager bound afterwards still works.
  const mgr2 = mockResource("ext_workspace_manager_v1");
  makeManager(ctx).bind(mgr2);
  ctx.sent.length = 0;
  ctx.state.pluginBus.emit("workspace.created",
    { handle: 8, outputId: 0, index: 2, name: "two" });
  assert.ok(ctx.sent.find(([k]) => k === "workspace"));
});

test("sweepDisconnected drops destroyed managers with no bus event needed", () => {
  const ctx = mockCtx();
  installExtWorkspaceBusHooks(ctx);
  const mgrRes = mockResource("ext_workspace_manager_v1");
  makeManager(ctx).bind(mgrRes);
  mgrRes.destroyed = true;
  sweepDisconnected();
  // After the sweep, a bus event emits nothing for the dead manager.
  ctx.sent.length = 0;
  ctx.state.pluginBus.emit("output.added", { outputId: 3 });
  assert.equal(ctx.sent.filter(([k]) => k === "workspace_group").length, 0);
});
