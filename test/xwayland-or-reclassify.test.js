// The override-redirect attribute is mutable and X emits no event for
// attribute changes; the current value rides CreateNotify, MapNotify,
// (real) ConfigureNotify, and ReparentNotify. The XWM re-syncs from those
// events -- the map-time value decides manage-vs-overlay, so a window
// created with OR set and cleared pre-map (or the reverse) is classified
// by what it IS at map, not what it was at create. Also covered: the
// overlay store must not resurrect a previous mapping's dead surface id
// (Xwayland mints a fresh wl_surface per map), and an output-covering OR
// overlay is re-placed through the current camera on retellPositions so a
// camera pan doesn't strand it.
//
// Driven entirely through the mocked addon + a minimal CompositorState.

import { test } from "node:test";
import assert from "node:assert/strict";

import { startXwm } from "../packages/core/dist/xwayland/xwm.js";

const ATOMS = {
  WM_CLASS: 1,
  _NET_WM_NAME: 2,
  WM_NAME: 3,
  _NET_WM_STATE: 4,
  _NET_WM_STATE_FULLSCREEN: 5,
  _NET_WM_STATE_FOCUSED: 6,
  UTF8_STRING: 7,
  WM_PROTOCOLS: 8,
};
const CRITICAL_ATOMS = [ATOMS.WM_CLASS, ATOMS._NET_WM_NAME, ATOMS.WM_NAME];
const ROOT = 1;

function makeMockAddon() {
  let nextCookie = 1;
  const reads = [];    // { cookie, window, atom }
  let onEvent = null;
  return {
    reads,
    deliver: (ev) => onEvent(ev),
    xwmStart(_fd, cb) {
      onEvent = cb;
      return { atoms: { ...ATOMS }, root: ROOT, bookkeeper: 2 };
    },
    xwmStop() {},
    xwmGetProperty(window, atom) {
      const cookie = nextCookie++;
      reads.push({ cookie, window, atom });
      return cookie;
    },
    xwmChangeProperty() {},
    xwmDeleteProperty() {},
    xwmMapWindow() {},
    xwmConfigureWindow() {},
    xwmSendConfigureNotify() {},
    xwmSendWmProtocol() {},
    xwmSetInputFocus() { return 0; },
    xwmKillClient() {},
  };
}

// Minimal CompositorState: enough for maybeManage (wm + surfacesById),
// placeOverlay (surfacesById + overrideRedirects + glass mapping), and
// rebuildStackWithPopups (wm.state.windows + compositor.setStack).
function makeState({ camera } = {}) {
  const wmCalls = { added: [], removed: [] };
  const state = {
    xwaylandScale: 1,
    surfacesById: new Map(),
    xwayland: { byResource: new Map(), bySerial: new Map() },
    outputs: new Map([[0, {
      id: 0,
      logicalPosition: { x: 0, y: 0 },
      logicalSize: { width: 800, height: 600 },
    }]]),
    outputCameras: camera ? new Map([[0, camera]]) : new Map(),
    wm: {
      state: { windows: [] },
      addWindow(surfaceId) { wmCalls.added.push(surfaceId); },
      unmapWindow(surfaceId) { wmCalls.removed.push(surfaceId); },
      markInitialCommitComplete() {},
      propose() { return Promise.resolve(); },
      primaryOutputId() { return 0; },
    },
    compositor: {
      setStack() {},
      setSurfaceLayout() {},
      redeliverImported() {},
    },
  };
  return { state, wmCalls };
}

const XWIN = 100;
function baseEv(type, window, extra = {}) {
  return {
    type, window, x: 0, y: 0, width: 0, height: 0,
    overrideRedirect: false, serialLo: 0, serialHi: 0, ...extra,
  };
}

// Register a wl_surface for the window and deliver its serial association.
function associate(addon, state, serial, surfaceId) {
  state.surfacesById.set(surfaceId, { id: surfaceId, resource: {} });
  state.xwayland.bySerial.set(BigInt(serial), surfaceId);
  addon.deliver(baseEv("surface-serial", XWIN, { serialLo: serial, serialHi: 0 }));
}

// Reply (empty property) to every outstanding critical-identity read for
// the window, so the manage gate drains.
function drainCriticalReads(addon) {
  for (const r of addon.reads.splice(0)) {
    if (!CRITICAL_ATOMS.includes(r.atom)) continue;
    addon.deliver(baseEv("property-reply", r.window, {
      cookieId: r.cookie, atom: r.atom, replyType: 0, format: 0,
      data: new Uint8Array(0),
    }));
  }
}

test("OR set at create, cleared before map: the window manages", () => {
  const addon = makeMockAddon();
  const { state, wmCalls } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: true, width: 640, height: 480 }));
  associate(addon, state, 1, 501);
  assert.equal(wmCalls.added.length, 0, "no manage while the record says OR");

  addon.deliver(baseEv("map", XWIN, { overrideRedirect: false, width: 640, height: 480 }));
  // The associate-time batch was issued while the window looked OR, so the
  // identity gate re-arms from the still-outstanding reads: managed only
  // after they land.
  assert.equal(wmCalls.added.length, 0, "manage held until identity reads land");
  drainCriticalReads(addon);
  assert.deepEqual(wmCalls.added, [501], "managed after the map-time OR clear");
  assert.equal((state.overrideRedirects ?? new Map()).size, 0,
    "no overlay placement for a non-OR-at-map window");
});

test("OR set at create, cleared before map, association after map", () => {
  const addon = makeMockAddon();
  const { state, wmCalls } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: true, width: 640, height: 480 }));
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: false, width: 640, height: 480 }));
  assert.equal(wmCalls.added.length, 0, "nothing to manage before association");

  associate(addon, state, 1, 501);
  assert.equal(wmCalls.added.length, 0,
    "manage held for the identity gate (armed at associate for non-OR)");
  drainCriticalReads(addon);
  assert.deepEqual(wmCalls.added, [501]);
});

test("non-OR at create, OR set before map: overlay, not managed", () => {
  const addon = makeMockAddon();
  const { state, wmCalls } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: false, width: 200, height: 150 }));
  associate(addon, state, 1, 501);
  drainCriticalReads(addon);
  assert.equal(wmCalls.added.length, 0, "not yet mapped");

  addon.deliver(baseEv("map", XWIN, {
    overrideRedirect: true, x: 30, y: 40, width: 200, height: 150,
  }));
  assert.equal(wmCalls.added.length, 0, "OR-at-map window never manages");
  assert.deepEqual(state.overrideRedirects?.get(501),
    { x: 30, y: 40, width: 200, height: 150 }, "placed as an overlay instead");
});

test("managed window flipping to OR via real ConfigureNotify leaves the WM", () => {
  const addon = makeMockAddon();
  const { state, wmCalls } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: false, width: 200, height: 150 }));
  associate(addon, state, 1, 501);
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: false, width: 200, height: 150 }));
  drainCriticalReads(addon);
  assert.deepEqual(wmCalls.added, [501]);

  // A synthetic ConfigureNotify fabricates overrideRedirect=false...
  // deliver one claiming OR on a managed window? No: synthetics must be
  // IGNORED for the attribute. Flip via a real one.
  addon.deliver(baseEv("configure-notify", XWIN, {
    overrideRedirect: true, x: 10, y: 20, width: 200, height: 150, synthetic: false,
  }));
  assert.deepEqual(wmCalls.removed, [501], "left the WM on the OR flip");
  assert.deepEqual(state.overrideRedirects?.get(501),
    { x: 10, y: 20, width: 200, height: 150 }, "re-placed as an overlay");
});

test("synthetic ConfigureNotify does not adopt its fabricated OR value", () => {
  const addon = makeMockAddon();
  const { state, wmCalls } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: true, width: 200, height: 150 }));
  associate(addon, state, 1, 501);
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: true, width: 200, height: 150 }));
  assert.equal(state.overrideRedirects?.size, 1);

  // Synthetics carry overrideRedirect=false; adopting it would demote the
  // overlay into a manage candidate.
  addon.deliver(baseEv("configure-notify", XWIN, {
    overrideRedirect: false, width: 200, height: 150, synthetic: true,
  }));
  drainCriticalReads(addon);
  assert.equal(wmCalls.added.length, 0, "still an overlay");
  assert.equal(state.overrideRedirects?.size, 1);
});

test("remap does not resurrect the previous mapping's dead surface id", () => {
  const addon = makeMockAddon();
  const { state } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: true, width: 100, height: 80 }));
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: true, width: 100, height: 80 }));
  associate(addon, state, 1, 501);
  assert.deepEqual([...state.overrideRedirects.keys()], [501]);

  // Unmap: overlay removed; the wayland side tears the wl_surface down.
  addon.deliver(baseEv("unmap", XWIN));
  assert.equal(state.overrideRedirects.size, 0);
  state.surfacesById.delete(501);

  // Remap before the fresh association: the record still holds the dead
  // id 501; placing it would put a dead entry in the draw stack forever.
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: true, width: 100, height: 80 }));
  assert.equal(state.overrideRedirects.size, 0, "dead surface id not re-placed");

  // The fresh association places the new surface.
  associate(addon, state, 2, 502);
  assert.deepEqual([...state.overrideRedirects.keys()], [502]);

  addon.deliver(baseEv("unmap", XWIN));
  assert.equal(state.overrideRedirects.size, 0, "no leaked entries after the cycle");
});

test("output-covering OR overlay follows the camera on retellPositions", () => {
  const addon = makeMockAddon();
  const { state } = makeState({ camera: { x: 100, y: 50, zoom: 1 } });
  startXwm(state, addon, 0);

  // Covers the 800x600 output; placed through the camera at map time.
  addon.deliver(baseEv("create", XWIN, { overrideRedirect: true, width: 800, height: 600 }));
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: true, width: 800, height: 600 }));
  associate(addon, state, 1, 501);
  assert.deepEqual(state.overrideRedirects.get(501),
    { x: 100, y: 50, width: 800, height: 600 });

  // A small OR (a menu) placed at the same time stays world-pinned.
  const MENU = 101;
  addon.deliver(baseEv("create", MENU, {
    overrideRedirect: true, x: 10, y: 10, width: 50, height: 40,
  }));
  addon.deliver(baseEv("map", MENU, {
    overrideRedirect: true, x: 10, y: 10, width: 50, height: 40,
  }));
  state.surfacesById.set(601, { id: 601, resource: {} });
  state.xwayland.bySerial.set(2n, 601);
  addon.deliver(baseEv("surface-serial", MENU, { serialLo: 2, serialHi: 0 }));
  assert.deepEqual(state.overrideRedirects.get(601),
    { x: 110, y: 60, width: 50, height: 40 });

  // Camera pans; the covering overlay re-places, the menu does not.
  state.outputCameras.set(0, { x: 300, y: 50, zoom: 1 });
  state.xwm.retellPositions();
  assert.deepEqual(state.overrideRedirects.get(501),
    { x: 300, y: 50, width: 800, height: 600 },
    "covering overlay glued to the output's glass");
  assert.deepEqual(state.overrideRedirects.get(601),
    { x: 110, y: 60, width: 50, height: 40 },
    "menu overlay keeps its placement-time world position");
});

test("reparent away from the root unmanages; back to the root re-manages", () => {
  const addon = makeMockAddon();
  const { state, wmCalls } = makeState();
  startXwm(state, addon, 0);

  addon.deliver(baseEv("create", XWIN, { overrideRedirect: false, width: 200, height: 150 }));
  associate(addon, state, 1, 501);
  addon.deliver(baseEv("map", XWIN, { overrideRedirect: false, width: 200, height: 150 }));
  drainCriticalReads(addon);
  assert.deepEqual(wmCalls.added, [501]);

  addon.deliver(baseEv("reparent", XWIN, { parent: 999 }));
  assert.deepEqual(wmCalls.removed, [501], "left the WM when it left the root");

  addon.deliver(baseEv("reparent", XWIN, { parent: ROOT }));
  assert.deepEqual(wmCalls.added, [501, 501], "re-managed on return to the root");
});
