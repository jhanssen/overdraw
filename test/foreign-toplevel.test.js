// Pure-unit tests for zwlr_foreign_toplevel_manager_v1 +
// zwlr_foreign_toplevel_handle_v1. Drives the handler factories with a mock
// ctx and bus; verifies the on-bind catch-up, per-toplevel emissions on
// window.map / window.change / window.committed / window.unmap, and that
// inbound state requests route through wm.propose / seat.applyKeyboardFocus
// / xdg_toplevel.send_close.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import makeManager, {
  makeForeignToplevelHandle,
  installForeignToplevelBusHooks,
  sweepDisconnected,
  _resetForTests,
} from "../packages/core/dist/protocols/zwlr_foreign_toplevel_manager_v1.js";

// state enum values (per the protocol spec).
const STATE = { maximized: 0, minimized: 1, activated: 2, fullscreen: 3 };

// Minimal typed bus mirror. Tests emit map/unmap/change directly.
function makeTypedBus() {
  const handlers = new Map();
  return {
    on(name, cb) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(cb); },
    emit(name, ev) {
      const hs = handlers.get(name);
      if (hs) for (const h of hs) h(ev);
    },
  };
}

// Minimal dynamic-bus mirror for subscribe/emit on string names.
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

function mockResource(name = "res") {
  return { __resource: name, interfaceName: name, version: 3, destroyed: false };
}

// Toplevel registry: store the synthetic mapping of toplevel resource ->
// {xdgSurface.surface.id, title, appId}. The handler reads these directly
// (titleAppIdOf walks state.toplevels.values()).
function makeToplevels() {
  return new Map();
}

function mockCtx() {
  const sent = [];
  const minted = [];
  const events = {
    zwlr_foreign_toplevel_manager_v1: {
      send_toplevel(resource, _placeholder) {
        // Mirror the trampoline: posting to a destroyed resource is a
        // no-op that mints no server-side new_id.
        if (resource.destroyed) return undefined;
        const handle = mockResource("zwlr_foreign_toplevel_handle_v1");
        minted.push(handle);
        sent.push(["toplevel", { resource, handle }]);
        return handle;
      },
      send_finished(resource) { sent.push(["finished", { resource }]); },
    },
    zwlr_foreign_toplevel_handle_v1: {
      send_title(handle, title) { sent.push(["title", { handle, title }]); },
      send_app_id(handle, appId) { sent.push(["app_id", { handle, appId }]); },
      send_output_enter(handle, output) { sent.push(["output_enter", { handle, output }]); },
      send_output_leave(handle, output) { sent.push(["output_leave", { handle, output }]); },
      send_state(handle, state) { sent.push(["state", { handle, state: [...new Uint32Array(state.buffer)] }]); },
      send_done(handle) { sent.push(["done", { handle }]); },
      send_closed(handle) { sent.push(["closed", { handle }]); },
      send_parent(handle, parent) { sent.push(["parent", { handle, parent }]); },
    },
    xdg_toplevel: {
      send_close(resource) { sent.push(["xdg_close", { resource }]); },
    },
  };
  const toplevels = makeToplevels();
  const propose = [];
  const focusCalls = [];
  const state = {
    bus: makeTypedBus(),
    pluginBus: makeDynamicBus(),
    surfaces: new Map(),
    toplevels,
    events,    // closeSurface() reads state.events.xdg_toplevel.send_close
    wm: {
      state: { windows: [] },
      getWindowState(id) {
        const ws = state._wmStates.get(id);
        return ws ?? null;
      },
      propose(id, partial, reason) {
        propose.push({ id, partial, reason });
        // Merge into the recorded state so the test can observe the result.
        const cur = state._wmStates.get(id) ?? {
          tiling: "managed", sizeMode: "none", visible: true, modal: false,
          clientRequests: {
            wantsMaximized: false, wantsFullscreen: false,
            wantsMinimized: false, wantsModal: false,
          },
          parent: null,
        };
        const next = { ...cur, ...partial };
        state._wmStates.set(id, next);
        return Promise.resolve(next);
      },
    },
    seat: {
      kbFocus: null,
      applyKeyboardFocus(id) {
        focusCalls.push(id);
        if (id === null) { state.seat.kbFocus = null; return; }
        state.seat.kbFocus = { surfaceId: id };
      },
    },
    _wmStates: new Map(),
    _sent: sent,
    _minted: minted,
    _propose: propose,
    _focusCalls: focusCalls,
  };
  return { addon: { clientId: () => 1 }, state, events };
}

// Add a toplevel entry that the handler can walk via query.titleAppId. The
// helper looks up the SurfaceRecord first (state.surfaces) and follows its
// xdgSurface.toplevel into state.toplevels, so we mirror both sides here.
function recordToplevel(ctx, surfaceId, { title = null, appId = null } = {}) {
  const xdgToplevel = mockResource("xdg_toplevel");
  const surfaceRes = mockResource("wl_surface");
  ctx.state.toplevels.set(xdgToplevel, {
    resource: xdgToplevel,
    xdgSurface: { surface: { id: surfaceId }, toplevel: xdgToplevel },
    title,
    appId,
  });
  ctx.state.surfaces.set(surfaceRes, {
    id: surfaceId,
    resource: surfaceRes,
    role: "xdg_toplevel",
    xdgSurface: { toplevel: xdgToplevel },
  });
  return xdgToplevel;
}

beforeEach(() => { _resetForTests(); });

// ---- bind catch-up ------------------------------------------------------

test("bind emits the initial burst for every currently-mapped toplevel", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 100, { title: "App A", appId: "com.example.a" });
  recordToplevel(ctx, 101, { title: "App B", appId: "com.example.b" });
  ctx.state.wm.state.windows.push(
    { surfaceId: 100, hasContent: true },
    { surfaceId: 101, hasContent: true });

  const mgr = makeManager(ctx);
  const managerResource = mockResource("zwlr_foreign_toplevel_manager_v1");
  mgr.bind(managerResource);

  // Two toplevels -> two handles, each with the full burst (app_id, title,
  // state, done). The order is per-window: toplevel, app_id, title, state, done.
  const calls = ctx.state._sent.map(([k]) => k);
  assert.deepEqual(calls,
    ["toplevel", "app_id", "title", "state", "done",
     "toplevel", "app_id", "title", "state", "done"]);
});

test("bind skips windows that have no content yet", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 100, { title: "T", appId: "a" });
  ctx.state.wm.state.windows.push({ surfaceId: 100, hasContent: false });
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("mgr"));
  assert.equal(ctx.state._sent.length, 0);
});

// ---- window.map / window.unmap ------------------------------------------

test("window.map emits initial burst on every bound manager", () => {
  const ctx = mockCtx();
  // Two managers bound first.
  const m1 = makeManager(ctx);
  const m2 = makeManager(ctx);
  m1.bind(mockResource("m1"));
  m2.bind(mockResource("m2"));
  installForeignToplevelBusHooks(ctx);
  ctx.state._sent.length = 0; // drop catch-up (empty here anyway)

  recordToplevel(ctx, 200, { title: "T", appId: "a" });
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "T",
  });

  // Two managers -> two toplevel events + two complete bursts (4 events each
  // after the toplevel).
  const toplevelCount = ctx.state._sent.filter(([k]) => k === "toplevel").length;
  const doneCount = ctx.state._sent.filter(([k]) => k === "done").length;
  assert.equal(toplevelCount, 2);
  assert.equal(doneCount, 2);
});

test("window.map with role 'layer-shell' is ignored (only toplevels go through)", () => {
  const ctx = mockCtx();
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state._sent.length = 0;

  ctx.state.bus.emit("window.map", {
    surfaceId: 300, rect: { x: 0, y: 0, width: 100, height: 30 },
    appId: null, title: null, role: "layer-shell",
  });
  assert.equal(ctx.state._sent.length, 0);
});

test("window.unmap emits closed on every manager's handle for that surface", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const m1 = makeManager(ctx);
  const m2 = makeManager(ctx);
  m1.bind(mockResource("m1"));
  m2.bind(mockResource("m2"));
  installForeignToplevelBusHooks(ctx);

  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  ctx.state._sent.length = 0;

  ctx.state.bus.emit("window.unmap", { surfaceId: 200 });
  // Two managers -> two closed events.
  const closeds = ctx.state._sent.filter(([k]) => k === "closed");
  assert.equal(closeds.length, 2);
});

// ---- window.change -------------------------------------------------------

test("window.change(title): handle re-emits title + done", () => {
  const ctx = mockCtx();
  const tl = recordToplevel(ctx, 200, { title: "Old", appId: "a" });
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "Old",
  });
  ctx.state._sent.length = 0;

  // The protocol/handler reads from state.toplevels directly; mutate the
  // record to match what set_title would do.
  ctx.state.toplevels.get(tl).title = "New";
  ctx.state.bus.emit("window.change", {
    surfaceId: 200, changed: ["title"], appId: "a", title: "New", activated: false,
  });

  const kinds = ctx.state._sent.map(([k]) => k);
  assert.deepEqual(kinds, ["title", "done"]);
  const title = ctx.state._sent.find(([k]) => k === "title")[1];
  assert.equal(title.title, "New");
});

test("window.change(activated): handle re-emits state + done", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200, { title: "T", appId: "a" });
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "T",
  });
  ctx.state._sent.length = 0;

  // Simulate kbFocus moving to this surface.
  ctx.state.seat.kbFocus = { surfaceId: 200 };
  ctx.state.bus.emit("window.change", {
    surfaceId: 200, changed: ["activated"], appId: "a", title: "T", activated: true,
  });

  const kinds = ctx.state._sent.map(([k]) => k);
  assert.deepEqual(kinds, ["state", "done"]);
  const stateEv = ctx.state._sent.find(([k]) => k === "state")[1];
  assert.deepEqual(stateEv.state, [STATE.activated]);
});

// ---- window.committed (tiling/exclusive/visible / parent) ---------------

function ws(over = {}) {
  return {
    tiling: "managed", sizeMode: "none", visible: true, modal: false,
    clientRequests: {
      wantsMaximized: false, wantsFullscreen: false,
      wantsMinimized: false, wantsModal: false,
    },
    parent: null,
    ...over,
  };
}

test("window.committed(exclusive maximized): handle emits state + done", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200, { title: "T", appId: "a" });
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "T",
  });
  ctx.state._sent.length = 0;

  ctx.state.pluginBus.emit("window.committed", {
    surfaceId: 200,
    previous: ws(),
    current: ws({ sizeMode: "maximized" }),
  });

  const stateEv = ctx.state._sent.find(([k]) => k === "state");
  assert.ok(stateEv, "state event sent");
  assert.deepEqual(stateEv[1].state, [STATE.maximized]);
  const done = ctx.state._sent.find(([k]) => k === "done");
  assert.ok(done, "done sent after");
});

test("window.committed(parent change): handle emits parent + done", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200, { title: "child", appId: "a" });
  recordToplevel(ctx, 201, { title: "parent", appId: "a" });
  const mgr = makeManager(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 201, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "parent",
  });
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "child",
  });
  ctx.state._sent.length = 0;

  ctx.state.pluginBus.emit("window.committed", {
    surfaceId: 200,
    previous: ws(),
    current: ws({ parent: 201 }),
  });

  const parentEv = ctx.state._sent.find(([k]) => k === "parent");
  assert.ok(parentEv, "parent emitted");
  // Should be the handle the manager minted for surface 201 (mapped before 200).
  assert.equal(typeof parentEv[1].parent, "object");
  assert.equal(parentEv[1].parent.interfaceName, "zwlr_foreign_toplevel_handle_v1");
});

// ---- inbound state requests --------------------------------------------

test("set_maximized: routes through wm.propose with clientRequests.wantsMaximized=true", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200, { title: "T", appId: "a" });
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: "a", title: "T",
  });
  const handleResource = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  ctx.state._propose.length = 0;

  handle.set_maximized(handleResource);
  assert.equal(ctx.state._propose.length, 1);
  assert.deepEqual(ctx.state._propose[0],
    { id: 200, partial: { clientRequests: { wantsMaximized: true } }, reason: "plugin" });
});

test("unset_maximized routes to clientRequests.wantsMaximized=false", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const h = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  handle.unset_maximized(h);
  assert.deepEqual(ctx.state._propose.at(-1).partial,
    { clientRequests: { wantsMaximized: false } });
});

test("set_fullscreen / unset_fullscreen / set_minimized / unset_minimized all route through propose", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const h = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  ctx.state._propose.length = 0;

  handle.set_fullscreen(h, null);
  handle.unset_fullscreen(h);
  handle.set_minimized(h);
  handle.unset_minimized(h);
  assert.deepEqual(ctx.state._propose.map((p) => p.partial), [
    { clientRequests: { wantsFullscreen: true } },
    { clientRequests: { wantsFullscreen: false } },
    { clientRequests: { wantsMinimized: true } },
    { clientRequests: { wantsMinimized: false } },
  ]);
});

test("activate: calls seat.applyKeyboardFocus(surfaceId), bypassing the focus driver", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const h = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  handle.activate(h, mockResource("wl_seat"));
  assert.deepEqual(ctx.state._focusCalls, [200]);
});

test("close: emits xdg_toplevel.close on the target toplevel resource", () => {
  const ctx = mockCtx();
  const tl = recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const h = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  ctx.state._sent.length = 0;
  handle.close(h);
  const closes = ctx.state._sent.filter(([k]) => k === "xdg_close");
  assert.equal(closes.length, 1);
  assert.equal(closes[0][1].resource, tl);
});

test("set_rectangle: accepted, no observable effect", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  mgr.bind(mockResource("m"));
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const h = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  ctx.state._sent.length = 0;
  handle.set_rectangle(h, mockResource("wl_surface"), 0, 0, 32, 32);
  // No additional events.
  assert.equal(ctx.state._sent.length, 0);
});

// ---- destroy + stop ----------------------------------------------------

test("handle destroy drops the per-manager mapping", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const handle = makeForeignToplevelHandle(ctx);
  const mgrResource = mockResource("m");
  mgr.bind(mgrResource);
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const h = ctx.state._sent.find(([k]) => k === "toplevel")[1].handle;
  handle.destroy(h);

  // Now requests on the destroyed handle don't propose (the handler
  // can't find the surfaceId).
  ctx.state._propose.length = 0;
  handle.set_maximized(h);
  assert.equal(ctx.state._propose.length, 0);
});

// ---- client disconnect (no stop, no destroy handlers) --------------------

test("manager client disconnect: window.map neither throws nor emits, and prunes the manager", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const mgrResource = mockResource("m");
  mgr.bind(mgrResource);
  installForeignToplevelBusHooks(ctx);
  ctx.state._sent.length = 0;

  // Simulate the client vanishing: libwayland marks the wrapper destroyed
  // without running any request handler.
  mgrResource.destroyed = true;

  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  assert.equal(ctx.state._sent.length, 0);

  // The dead manager was pruned during fan-out: a second manager binding
  // and mapping still works, and only that manager receives events.
  const mgr2 = makeManager(ctx);
  mgr2.bind(mockResource("m2"));
  recordToplevel(ctx, 201);
  ctx.state.bus.emit("window.map", {
    surfaceId: 201, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  const toplevels = ctx.state._sent.filter(([k]) => k === "toplevel");
  assert.equal(toplevels.length, 1);
});

test("manager disconnect mid-lifetime: sweepDisconnected drops it with no events", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const mgrResource = mockResource("m");
  mgr.bind(mgrResource);
  installForeignToplevelBusHooks(ctx);
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  ctx.state._sent.length = 0;

  mgrResource.destroyed = true;
  sweepDisconnected();

  // Unmap after the sweep: nothing addresses the dead manager's handle.
  ctx.state.bus.emit("window.unmap", { surfaceId: 200 });
  assert.equal(ctx.state._sent.length, 0);
});

test("manager.stop: emits finished, no further events", () => {
  const ctx = mockCtx();
  recordToplevel(ctx, 200);
  const mgr = makeManager(ctx);
  const mgrResource = mockResource("m");
  mgr.bind(mgrResource);
  installForeignToplevelBusHooks(ctx);
  mgr.stop(mgrResource);
  const finished = ctx.state._sent.find(([k]) => k === "finished");
  assert.ok(finished, "finished emitted");

  ctx.state._sent.length = 0;
  ctx.state.bus.emit("window.map", {
    surfaceId: 200, rect: { x: 0, y: 0, width: 100, height: 50 },
    appId: null, title: null,
  });
  // No new events; the manager was removed.
  assert.equal(ctx.state._sent.length, 0);
});
