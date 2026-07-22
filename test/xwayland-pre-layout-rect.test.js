// A managed X window's WM rect is a sizeless placeholder ({0,0,-1,-1})
// until the first layout pass. Telling that rect to the X client is never
// valid: a zero-size ConfigureWindow is a BadValue error, and the synthetic
// ConfigureNotify makes clients that feed the size into their render target
// abort (gibbon/netflix asserts on a 0x0 ConfigureNotify). The xwm must
// suppress rect narration until layout assigns a real size:
//  - retellPositions skips placeholder-rect windows;
//  - a configure-request echoes the client's requested rect (not the
//    placeholder) until the WM rect has size;
//  - tellXRect refuses any zero-size tell outright.
//
// Driven entirely through the mocked addon: configure/notify calls record
// so the wire-visible tells are observable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { startXwm } from "../packages/core/dist/xwayland/xwm.js";
import { tellXRect } from "../packages/core/dist/xwayland/glass-map.js";

const XWIN = 100;
const SURFACE_ID = 7;
const SERIAL = 1n;

function makeMockAddon() {
  const tells = [];  // { kind: "configure"|"notify", window, x, y, w, h }
  let nextCookie = 1;
  let onEvent = null;
  return {
    tells,
    deliver: (ev) => onEvent(ev),
    xwmStart(_fd, cb) {
      onEvent = cb;
      return {
        atoms: { _NET_WM_STATE: 101, _NET_WM_STATE_FULLSCREEN: 102 },
        root: 1,
        bookkeeper: 2,
      };
    },
    xwmStop() {},
    xwmGetProperty() { return nextCookie++; },
    xwmChangeProperty() {},
    xwmDeleteProperty() {},
    xwmMapWindow() {},
    xwmConfigureWindow(window, x, y, w, h) {
      tells.push({ kind: "configure", window, x, y, w, h });
    },
    xwmSendConfigureNotify(window, x, y, w, h) {
      tells.push({ kind: "notify", window, x, y, w, h });
    },
    xwmSendWmProtocol() {},
    xwmSetInputFocus() { return 0; },
    xwmKillClient() {},
  };
}

// Minimal state with a mocked WM whose rectOf serves `rect.value`, plus the
// serial registry entry the surface-serial event resolves through.
function makeState(rect) {
  return {
    surfacesById: new Map([[SURFACE_ID, { role: "xwayland" }]]),
    xwayland: { byResource: new Map(), bySerial: new Map([[SERIAL, SURFACE_ID]]) },
    compositor: {},
    wm: {
      addWindow() { return { ...rect.value }; },
      primaryOutputId() { return 1; },
      rectOf() { return { ...rect.value }; },
      unmapWindow() {},
      markInitialCommitComplete() {},
      propose() {},
      getWindowState() { return undefined; },
      islandOf() { return null; },
    },
  };
}

const EV = { x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 };

// create -> map -> surface-serial: the window ends managed (addedToWm) with
// whatever rect the mocked WM serves.
function manageWindow(addon) {
  addon.deliver({ ...EV, type: "create", window: XWIN, width: 1280, height: 720 });
  addon.deliver({ ...EV, type: "map", window: XWIN, width: 1280, height: 720 });
  addon.deliver({ ...EV, type: "surface-serial", window: XWIN, serialLo: 1 });
}

test("xwm: retellPositions skips windows whose WM rect is still placeholder", () => {
  const addon = makeMockAddon();
  const rect = { value: { x: 3, y: 4, width: -1, height: -1 } };
  const state = makeState(rect);
  startXwm(state, addon, 0);
  manageWindow(addon);

  addon.tells.length = 0;
  state.xwm.retellPositions();
  assert.deepEqual(addon.tells, [],
    "placeholder rect must not be narrated to the X client");

  // Layout assigned a real rect: the retell now goes out sized.
  rect.value = { x: 3, y: 4, width: 640, height: 480 };
  state.xwm.retellPositions();
  assert.deepEqual(addon.tells, [
    { kind: "configure", window: XWIN, x: 3, y: 4, w: 640, h: 480 },
    { kind: "notify", window: XWIN, x: 3, y: 4, w: 640, h: 480 },
  ]);
});

test("xwm: configure-request honors the client until the WM rect has size", () => {
  const addon = makeMockAddon();
  const rect = { value: { x: 3, y: 4, width: -1, height: -1 } };
  const state = makeState(rect);
  startXwm(state, addon, 0);
  manageWindow(addon);

  // Pre-layout: echo the client's requested rect, not the placeholder.
  addon.tells.length = 0;
  addon.deliver({ ...EV, type: "configure-request", window: XWIN,
    x: 10, y: 20, width: 640, height: 480 });
  assert.deepEqual(addon.tells, [
    { kind: "configure", window: XWIN, x: 10, y: 20, w: 640, h: 480 },
    { kind: "notify", window: XWIN, x: 10, y: 20, w: 640, h: 480 },
  ]);

  // Post-layout: the WM rect is authoritative again.
  rect.value = { x: 3, y: 4, width: 800, height: 600 };
  addon.tells.length = 0;
  addon.deliver({ ...EV, type: "configure-request", window: XWIN,
    x: 10, y: 20, width: 640, height: 480 });
  assert.deepEqual(addon.tells, [
    { kind: "configure", window: XWIN, x: 3, y: 4, w: 800, h: 600 },
    { kind: "notify", window: XWIN, x: 3, y: 4, w: 800, h: 600 },
  ]);
});

test("tellXRect: refuses zero- and negative-size tells", () => {
  const addon = makeMockAddon();
  tellXRect(addon, XWIN, 2, 32, 0, 0);
  tellXRect(addon, XWIN, 2, 32, -2, -2);
  tellXRect(addon, XWIN, 2, 32, 640, 0.4);  // rounds to 0 height
  assert.deepEqual(addon.tells, []);

  tellXRect(addon, XWIN, 2, 32, 640, 480);
  assert.deepEqual(addon.tells, [
    { kind: "configure", window: XWIN, x: 2, y: 32, w: 640, h: 480 },
    { kind: "notify", window: XWIN, x: 2, y: 32, w: 640, h: 480 },
  ]);
});
