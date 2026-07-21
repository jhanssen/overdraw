// The _NET_WM_STATE stale-reply guard. The xwm re-reads _NET_WM_STATE on
// PropertyNotify; the async reply may have been serviced by the X server
// BEFORE a net-wm-state ClientMessage the xwm has since applied. Applying
// that stale reply rolls the atom cache back and reverts the WM's exclusive
// decision (the fullscreen "flap": a game fullscreens, the stale reply
// un-fullscreens it milliseconds later, nondeterministic per launch).
// The guard drops any _NET_WM_STATE reply whose issue-time sequence no
// longer matches the cache's local-mutation sequence.
//
// Driven entirely through the mocked addon: xwmStart captures the event
// callback; property writes record so the cache's content is observable via
// a toggle ClientMessage (toggle removes the atom only if the cache kept it).

import { test } from "node:test";
import assert from "node:assert/strict";

import { startXwm } from "../packages/core/dist/xwayland/xwm.js";

const A_STATE = 101;
const A_FULLSCREEN = 102;
const A_FOCUSED = 103;

function makeMockAddon() {
  const writes = [];   // { kind: "change"|"delete", window, atom, data: number[] }
  let nextCookie = 1;
  const reads = [];    // { cookie, window, atom }
  let onEvent = null;
  const addon = {
    writes, reads,
    deliver: (ev) => onEvent(ev),
    xwmStart(_fd, cb) {
      onEvent = cb;
      return {
        atoms: {
          _NET_WM_STATE: A_STATE,
          _NET_WM_STATE_FULLSCREEN: A_FULLSCREEN,
          _NET_WM_STATE_FOCUSED: A_FOCUSED,
        },
        root: 1,
        bookkeeper: 2,
      };
    },
    xwmStop() {},
    xwmGetProperty(window, atom) {
      const cookie = nextCookie++;
      reads.push({ cookie, window, atom });
      return cookie;
    },
    xwmChangeProperty(window, atom, _type, _format, data, _len) {
      writes.push({ kind: "change", window, atom, data: [...data] });
    },
    xwmDeleteProperty(window, atom) {
      writes.push({ kind: "delete", window, atom, data: [] });
    },
    xwmMapWindow() {},
    xwmConfigureWindow() {},
    xwmSendConfigureNotify() {},
    xwmSendWmProtocol() {},
    xwmSetInputFocus() { return 0; },
    xwmKillClient() {},
  };
  return addon;
}

const XWIN = 100;
const CREATE = {
  type: "create", window: XWIN, x: 0, y: 0, width: 640, height: 480,
  overrideRedirect: false, serialLo: 0, serialHi: 0,
};

// The last _NET_WM_STATE write for the window (change or delete), or null.
function lastStateWrite(addon) {
  for (let i = addon.writes.length - 1; i >= 0; i--) {
    const w = addon.writes[i];
    if (w.window === XWIN && w.atom === A_STATE) return w;
  }
  return null;
}

test("xwm: stale _NET_WM_STATE reply does not roll back a newer ClientMessage", () => {
  const addon = makeMockAddon();
  startXwm({}, addon, 0);
  addon.deliver(CREATE);

  // PropertyNotify -> the xwm issues an async read (cookie captured at
  // cache seq 0).
  addon.deliver({ type: "property-notify", window: XWIN, atom: A_STATE,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });
  const staleCookie = addon.reads.at(-1).cookie;

  // ClientMessage ADD fullscreen lands first: cache = {FULLSCREEN}, seq 1.
  addon.deliver({ type: "net-wm-state", window: XWIN,
    stateAction: 1, stateAtom1: A_FULLSCREEN, stateAtom2: 0,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });
  assert.deepEqual(lastStateWrite(addon),
    { kind: "change", window: XWIN, atom: A_STATE, data: [A_FULLSCREEN] },
    "ClientMessage republished the property with FULLSCREEN");

  // The stale reply arrives (property content from BEFORE the add: only
  // FOCUSED). Without the guard this clobbers the cache.
  const data = new Uint8Array(new Uint32Array([A_FOCUSED]).buffer);
  addon.deliver({ type: "property-reply", window: XWIN, cookieId: staleCookie,
    atom: A_STATE, replyType: 4, format: 32, data,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });

  // Observable probe: TOGGLE fullscreen. If the cache kept FULLSCREEN the
  // toggle REMOVES it (property becomes empty -> delete). If the stale
  // reply clobbered the cache ({FOCUSED}), the toggle would ADD it and the
  // write would carry FULLSCREEN again.
  addon.deliver({ type: "net-wm-state", window: XWIN,
    stateAction: 2, stateAtom1: A_FULLSCREEN, stateAtom2: 0,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });
  const w = lastStateWrite(addon);
  assert.equal(w.kind, "delete",
    `toggle after the stale reply must EMPTY the state (cache kept FULLSCREEN); `
    + `got ${JSON.stringify(w)}`);
});

test("xwm: a fresh _NET_WM_STATE reply (no local mutation since) still applies", () => {
  const addon = makeMockAddon();
  startXwm({}, addon, 0);
  addon.deliver(CREATE);

  addon.deliver({ type: "property-notify", window: XWIN, atom: A_STATE,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });
  const cookie = addon.reads.at(-1).cookie;

  // Reply carries FULLSCREEN (a spec-violating but real client wrote the
  // property directly). No local mutation happened -> it must apply.
  const data = new Uint8Array(new Uint32Array([A_FULLSCREEN]).buffer);
  addon.deliver({ type: "property-reply", window: XWIN, cookieId: cookie,
    atom: A_STATE, replyType: 4, format: 32, data,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });

  // Probe: toggle removes it -> delete write (cache adopted the reply).
  addon.deliver({ type: "net-wm-state", window: XWIN,
    stateAction: 2, stateAtom1: A_FULLSCREEN, stateAtom2: 0,
    x: 0, y: 0, width: 0, height: 0, overrideRedirect: false, serialLo: 0, serialHi: 0 });
  const w = lastStateWrite(addon);
  assert.equal(w.kind, "delete",
    `toggle after an applied reply must EMPTY the state; got ${JSON.stringify(w)}`);
});
