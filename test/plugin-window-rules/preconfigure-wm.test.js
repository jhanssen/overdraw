// Integration test (GPU-free): the real WM preconfigure path -> a real
// DynamicBus -> the real window-rules plugin interceptor -> committed window
// state. Proves a rule applies BEFORE the window maps (markInitialCommitComplete
// is the pre-map handshake) and that the xwayland flag reaches a predicate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../../packages/core/dist/wm/index.js';
import { DynamicBus } from '../../packages/core/dist/events/dynamic-bus.js';
import init from '../../packages/plugin-window-rules/dist/index.js';

// Fake sdk that routes events.intercept into the real bus, like the in-thread
// plugin runtime does for bundled plugins.
function sdkFor(bus) {
  return {
    name: 'window-rules',
    log() {},
    events: {
      intercept(pattern, cb) {
        const sub = bus.intercept(pattern, cb);
        return { unregister: () => sub.off() };
      },
    },
  };
}

async function setup(rules) {
  const bus = new DynamicBus();
  await init(sdkFor(bus), rules);
  const comp = { setSurfaceLayout() {}, setStack() {} };
  const wm = createWm(
    comp,
    [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }],
    { pluginBus: bus },
  );
  return wm;
}

// Mimic the protocol layer's pre-map handshake for a toplevel.
async function premap(wm, id, info) {
  wm.addWindow(id, { resource: { __id: id } }, { deferInitialCommit: true });
  await wm.markInitialCommitComplete(id, info);
}

test('matching float rule: window maps floating (pre-map)', async () => {
  const wm = await setup([{ match: { appId: '^Netflix$' }, float: true }]);
  await premap(wm, 1, { appId: 'Netflix', title: null, xwayland: false });
  assert.equal(wm.getWindowState(1).tiling, 'floating');
});

test('float rule: the window is sized (floatingRect) at first content so it is visible', async () => {
  const wm = await setup([{ match: { appId: '^Netflix$' }, float: true }]);
  await premap(wm, 1, { appId: 'Netflix', title: null, xwayland: true });
  assert.equal(wm.getWindowState(1).tiling, 'floating');
  // No rect until the client commits its first content.
  assert.equal(wm.getFloatingRect(1), null);
  // First content: the WM sizes the floating window from its natural size and
  // centers it on the 1000x600 output. Without this a rule-floated window has
  // no rect and the layout driver falls back to the addWindow placeholder --
  // the window renders invisible.
  wm.windowHasContent(1, { width: 400, height: 300 });
  assert.deepEqual(wm.getFloatingRect(1), { x: 300, y: 150, width: 400, height: 300 });
});

test('non-matching window stays managed', async () => {
  const wm = await setup([{ match: { appId: '^Netflix$' }, float: true }]);
  await premap(wm, 2, { appId: 'firefox', title: null, xwayland: false });
  assert.equal(wm.getWindowState(2).tiling, 'managed');
});

test('title regex matches against the real preconfigure title', async () => {
  const wm = await setup([{ match: { title: 'LAN Mouse' }, float: true }]);
  await premap(wm, 3, { appId: 'lan-mouse', title: 'LAN Mouse', xwayland: false });
  assert.equal(wm.getWindowState(3).tiling, 'floating');
});

test('xwayland flag from markInitialCommitComplete reaches a predicate', async () => {
  const wm = await setup([{ match: (w) => w.xwayland && w.appId === 'steam', float: true }]);
  // same appId but wayland -> no float
  await premap(wm, 4, { appId: 'steam', title: null, xwayland: false });
  assert.equal(wm.getWindowState(4).tiling, 'managed');
  // xwayland -> float
  await premap(wm, 5, { appId: 'steam', title: null, xwayland: true });
  assert.equal(wm.getWindowState(5).tiling, 'floating');
});

test('apply lambda runs against the live window pre-map', async () => {
  const wm = await setup([{ match: { appId: 'mpv' }, apply: (win) => { win.state.tiling = 'floating'; } }]);
  await premap(wm, 6, { appId: 'mpv', title: 'video', xwayland: false });
  assert.equal(wm.getWindowState(6).tiling, 'floating');
});

test('apply lambda can set a non-tiling axis (exclusive) committed by the WM', async () => {
  const wm = await setup([{ match: { appId: 'player' }, apply: (win) => {
    win.state.tiling = 'floating';
    win.state.sizeMode = 'maximized';
  } }]);
  await premap(wm, 7, { appId: 'player', title: null, xwayland: false });
  const s = wm.getWindowState(7);
  assert.equal(s.tiling, 'floating');
  assert.equal(s.sizeMode, 'maximized');
});
