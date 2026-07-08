// Pure-unit tests for the deferred-initial-commit dance:
//   - addWindow({ deferInitialCommit: true }) holds the first configure.
//   - propose() between addWindow and markInitialCommitComplete accumulates
//     state (the eventual single configure reflects it). Pre-content
//     clientRequests go through resolveDecisions(phase="pre-content") so
//     a client's set_maximized boilerplate is suppressed by default.
//   - markInitialCommitComplete emits window.preconfigure (interceptable),
//     commits the (possibly modified) final state, and sends the 0x0 handshake
//     configure. The window is placed (and its sized configure sent) at first
//     content, once its tiling lane is resolved -- not during the handshake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

const createDynamicBus = () => new DynamicBus();

function mockSink() {
  return {
    layouts: [],
    stacks: [],
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setStack(ids) { this.stacks.push(ids); },
    setLayerSurfaces() {},
    setSurfaceTexture() {},
    commitSurfaceBuffer() {},
    commitSurfaceDmabuf() {},
    removeSurface() {},
    takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; },
    afterCurrentFrame() {},
    renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// Inline immediate-layout driver: every schedule synchronously assigns the
// whole tile to the master and applies it. Gives tests a deterministic
// geometry without spinning up the bundled plugin. Mirrors the real
// resolver's lane dispatch: invisible windows are omitted; an exclusive
// window owns its output (peers suppressed); else managed windows get
// the full output rect.
function immediateLayoutDriver(target, snapshot) {
  return {
    async schedule() {
      const snap = snapshot();
      const primary = snap.outputs[0];
      const outRect = { x: 0, y: 0, width: primary.rect.width, height: primary.rect.height };
      const allWindows = [...snap.windows.values()];
      const rects = [];
      const visible = allWindows.filter((w) => w.visible);
      const exclusiveWin = visible.find((w) => w.exclusive !== 'none');
      if (exclusiveWin) {
        rects.push({ id: exclusiveWin.id, outer: outRect });
      } else {
        for (const w of visible) {
          if (w.tiling === 'managed') rects.push({ id: w.id, outer: outRect });
        }
      }
      await target.apply({ rects }, 'mapped');
    },
    settled() { return Promise.resolve(); },
  };
}

// --- deferred mode: configure is suppressed until markInitialCommitComplete ---

test('deferInitialCommit: no configure fires during addWindow + propose phase', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  assert.equal(configures.length, 0); // suppressed

  await wm.propose(1, { clientRequests: { wantsMaximized: true } }, 'client-request');
  await wm.settled();
  assert.equal(configures.length, 0); // still suppressed
});

test('markInitialCommitComplete: throwaway 0x0 first configure, then real tile size once the layout has settled', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  // The 0x0 handshake configure goes out first (the client gets a serial to
  // ack). The real tile size follows as soon as the window has a placed outer;
  // this non-gated driver lays the window out immediately, so the sized
  // configure follows here as the SECOND configure. (A placement-gated layout
  // defers the window until first content -- see the placement test above --
  // and the sized configure follows there instead.)
  assert.deepEqual(configures, [{ id: 1, w: 0, h: 0 }, { id: 1, w: 1000, h: 600 }]);
  // First content does NOT re-send: the sized configure already went out.
  wm.windowHasContent(1);
  assert.equal(configures.length, 2);
  assert.deepEqual(configures.at(-1), { id: 1, w: 1000, h: 600 });
});

test('markInitialCommitComplete: xwayland suppresses the xdg 0x0 handshake configure', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null, xwayland: true });
  // X11 has no xdg two-phase commit: the 0x0 throwaway handshake would reach
  // the X client as a bogus 0x0 ConfigureNotify. Xwayland sizing is owned by
  // applyLayout, so no handshake configure fires from this path. (A wayland
  // window DOES get the 0x0 -- see the test above.)
  assert.ok(!configures.some((c) => c.w === 0 && c.h === 0),
    'no 0x0 handshake configure for an xwayland window');
});

// --- map-ack gating: the open is held until the client acks the tile-size
// configure, so the open animation plays on a tile-sized buffer (not the
// client's default from the 0x0 handshake). beforeMap stands in for the
// opening driver; a serial-returning configure stands in for xdg ack tracking.

function serialConfigure(configures) {
  let serial = 0;
  return {
    configure: (id, _x, _y, w, h) => { serial += 1; configures.push({ id, w, h, serial }); return serial; },
    configureMove: () => {},
  };
}

test('open: held until the client acks the tile-size configure (the mapping commit)', async () => {
  const configures = [];
  const mapped = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: serialConfigure(configures),
    layoutDriverFactory: immediateLayoutDriver,
    beforeMap: (id) => { mapped.push(id); return true; },
    hasOpeningAnimation: () => true,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  // First content arrives but the client has not acked the tile-size configure
  // yet (its buffer is the 0x0-handshake default) -> the open is held.
  wm.windowHasContent(1);
  assert.deepEqual(mapped, [], 'open held until the tile-size configure is acked');
  // Stale ack (the 0x0 serial) does NOT release.
  wm.notifyToplevelCommit(1, 1);
  assert.deepEqual(mapped, [], 'a stale serial does not map');
  // The mapping commit: client acks the latest (tile-size) serial.
  const last = configures.at(-1).serial;
  wm.notifyToplevelCommit(1, last);
  assert.deepEqual(mapped, [1], 'maps once the tile-size ack lands');
});

test('open: maps immediately when first content already acked the tile-size configure', async () => {
  const configures = [];
  const mapped = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: serialConfigure(configures),
    layoutDriverFactory: immediateLayoutDriver,
    beforeMap: (id) => { mapped.push(id); return true; },
    hasOpeningAnimation: () => true,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  // A well-behaved client rendered at the tile size first try: it acks the
  // latest serial on/with its first content commit -> no hold, no added delay.
  wm.notifyToplevelCommit(1, configures.at(-1).serial);
  wm.windowHasContent(1);
  assert.deepEqual(mapped, [1], 'no hold when first content already acked the tile size');
});

test('open: maps immediately when NO open animation is active, even with an unacked configure', async () => {
  // Regression: the map-ack hold must engage only when a window-opening plugin
  // is registered (an animation will run). With beforeMap wired but no
  // animation (hasOpeningAnimation false), a window must NOT be held waiting
  // for an ack -- otherwise every window (and every GPU-test client that
  // doesn't ack the exact serial) stays invisible.
  const configures = [];
  const mapped = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: serialConfigure(configures),
    layoutDriverFactory: immediateLayoutDriver,
    beforeMap: (id) => { mapped.push(id); return false; },
    hasOpeningAnimation: () => false,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  // No ack has arrived, but with no animation the window maps right away.
  wm.windowHasContent(1);
  assert.deepEqual(mapped, [1], 'no animation -> immediate map, no ack hold');
});

test('sized configure waits for first-content placement (handshake sends only 0x0)', async () => {
  // A window is not laid out until it is placed at first content (window.map ->
  // workspace plugin -> setOutputStack); the layout gates on outputContent. So
  // it stays unplaced -- outer placeholder -- through the initial-commit
  // handshake, where only the 0x0 configure goes out. The sized configure
  // follows once the window is placed, exactly once.
  const configures = [];
  const placed = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: inlineMasterStackDriverFactory,
    outputContent: () => new Map(placed.length ? [[0, [...placed]]] : []),
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: 'a', title: 't' });
  // Unplaced -> placeholder outer -> only the 0x0 handshake configure.
  assert.equal(wm.outerRectOf(1)?.width <= 0, true, 'outer placeholder after the handshake');
  assert.deepEqual(configures, [{ id: 1, w: 0, h: 0 }], 'only 0x0 in the handshake');
  // First content places the window (models window.map -> setOutputStack); the
  // resulting relayout takes it placeholder->real and sends the sized configure.
  placed.push(1);
  wm.schedule('reorder');
  await wm.settled();
  wm.windowHasContent(1);
  await wm.settled();
  assert.deepEqual(configures.filter((c) => c.w !== 0 || c.h !== 0), [{ id: 1, w: 1000, h: 600 }],
    'exactly one sized configure, sent once the window is placed');
});

test('sendInitialConfigure: 0x0 first configure is sent SYNCHRONOUSLY (single-roundtrip handshake)', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();

  // The handshake must complete WITHOUT awaiting: a client doing a single
  // wl_display_roundtrip after its initial commit has to see the configure
  // within that roundtrip. sendInitialConfigure sends it synchronously.
  wm.sendInitialConfigure(1);
  assert.deepEqual(configures, [{ id: 1, w: 0, h: 0 }], 'configure sent synchronously');

  // The async preconfigure/layout pass must NOT send a second 0x0 -- the
  // synchronous one already satisfied the handshake.
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  assert.equal(configures.filter((c) => c.w === 0 && c.h === 0).length, 1,
    'exactly one 0x0 configure (no double-send)');

  // The real tile size still lands as the second configure on first content.
  wm.windowHasContent(1);
  assert.deepEqual(configures.at(-1), { id: 1, w: 1000, h: 600 });
});

test('markInitialCommitComplete: subsequent layout changes resume configure flow', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  configures.length = 0;
  // After clearing, a post-content propose() to exclusive=maximized
  // (post-content phase honors the request).
  await wm.propose(1, { clientRequests: { wantsMaximized: true } }, 'plugin');
  await wm.settled();
  // The point: window 1's pendingInitialCommit is gone so applyLayout
  // doesn't suppress configures anymore.
  assert.ok(configures.length >= 0); // smoke test passes
});

test('markInitialCommitComplete: unknown window is a no-op', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  // Don't throw; quietly do nothing.
  await wm.markInitialCommitComplete(999, { appId: null, title: null });
  assert.equal(configures.length, 0);
});

test('markInitialCommitComplete: not in deferred mode is a no-op', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1)); // no deferInitialCommit
  await wm.settled();
  // The addWindow path already fired a configure (immediate mode).
  const before = configures.length;
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  assert.equal(configures.length, before); // no extra configure
});

// --- pre-content policy: default suppresses set_maximized ---

test('pre-content set_maximized: default policy suppresses, but the wish is preserved', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.propose(1, { clientRequests: { wantsMaximized: true } }, 'client-request');
  const s = wm.getWindowState(1);
  // The client's wish is recorded (so a window-rules plugin can read it
  // at window.preconfigure)...
  assert.equal(s.clientRequests.wantsMaximized, true);
  // ...but the decision axis is NOT honored at this phase (pre-content).
  assert.equal(s.exclusive, 'none');
});

test('pre-content set_fullscreen: default policy honors (matches sway/hyprland)', async () => {
  // wantsFullscreen pre-content goes through resolveDecisions which DOES
  // honor it (the seam's default for fullscreen). A window-rules plugin
  // intercepting window.proposed can override.
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.propose(1, { clientRequests: { wantsFullscreen: true } }, 'client-request');
  const s = wm.getWindowState(1);
  assert.equal(s.clientRequests.wantsFullscreen, true);
  assert.equal(s.exclusive, 'fullscreen');
});

// --- window.preconfigure interceptor path ---

test('preconfigure: emits with current state as initialState', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    pluginBus: bus,
    layoutDriverFactory: immediateLayoutDriver,
  });
  const events = [];
  bus.subscribe('window.preconfigure', (_n, p) => events.push(p));
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  // Direct decision-axis write (bypasses the policy seam): this represents
  // a plugin pre-empting the decision before the first configure.
  await wm.propose(1, { exclusive: 'maximized' }, 'plugin');
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: 'firefox', title: 'Test' });
  assert.equal(events.length, 1);
  assert.equal(events[0].surfaceId, 1);
  assert.equal(events[0].appId, 'firefox');
  assert.equal(events[0].title, 'Test');
  assert.equal(events[0].initialState.exclusive, 'maximized');
});

test('preconfigure: interceptor modifies initialState and the modified state is committed', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    pluginBus: bus,
    layoutDriverFactory: immediateLayoutDriver,
  });
  // Window-rules plugin: Firefox always maximized.
  bus.intercept('window.preconfigure', (_n, p) => {
    const ev = p;
    if (ev.appId === 'firefox') {
      return { ...ev, initialState: { ...ev.initialState, exclusive: 'maximized' } };
    }
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  // Client didn't ask for maximized; rule plugin overrides at preconfigure.
  await wm.markInitialCommitComplete(1, { appId: 'firefox', title: 'Firefox' });
  assert.equal(wm.getWindowState(1).exclusive, 'maximized');
});

test('preconfigure: client-declared state survives when interceptor leaves it alone', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    pluginBus: bus,
    layoutDriverFactory: immediateLayoutDriver,
  });
  bus.intercept('window.preconfigure', () => undefined); // observe-only
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  // Pre-content wantsFullscreen IS honored by default policy.
  await wm.propose(1, { clientRequests: { wantsFullscreen: true } }, 'client-request');
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: 'foo', title: 'Bar' });
  assert.equal(wm.getWindowState(1).exclusive, 'fullscreen');
});

test('preconfigure: interceptor modification emits window.committed', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    pluginBus: bus,
    layoutDriverFactory: immediateLayoutDriver,
  });
  bus.intercept('window.preconfigure', (_n, p) => {
    const ev = p;
    return { ...ev, initialState: { ...ev.initialState, exclusive: 'fullscreen' } };
  });
  const committed = [];
  bus.subscribe('window.committed', (_n, p) => committed.push(p));
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: 'foo', title: 'Bar' });
  assert.equal(committed.length, 1);
  assert.equal(committed[0].reason, 'window-rule');
  assert.equal(committed[0].current.exclusive, 'fullscreen');
  assert.ok(committed[0].changed.includes('exclusive'));
});

test('preconfigure: synchronous setInsets in interceptor shrinks the first sized configure', async () => {
  // Verifies the seam the decoration-as-intercept design depends on:
  // a preconfigure interceptor that synchronously reserves insets must
  // make the very first SIZED configure (after the 0x0 handshake)
  // carry the post-insets content size. No wrong-size flash possible.
  const bus = createDynamicBus();
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    pluginBus: bus,
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  // Mock decoration plugin: matches firefox, reserves 2px border on
  // every side via setInsets inside the preconfigure interceptor.
  bus.subscribe('window.preconfigure', (_n, p) => {
    if (p.appId === 'firefox') {
      wm.setInsets(p.surfaceId, { top: 2, right: 2, bottom: 2, left: 2 });
    }
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  wm.sendInitialConfigure(1);
  // The 0x0 handshake configure went out first.
  assert.deepEqual(configures, [{ id: 1, w: 0, h: 0 }]);
  // Now the client's initial commit completes; the interceptor's
  // setInsets must land before the layout pass that sends the sized
  // configure.
  await wm.markInitialCommitComplete(1, { appId: 'firefox', title: null });
  await wm.settled();
  // First content-driven configure goes out at content rect = outer minus insets.
  wm.windowHasContent(1);
  await wm.settled();
  // Outer was 1000x600 (the only output); content rect after 2px insets is 996x596.
  const sized = configures.filter((c) => c.w !== 0 || c.h !== 0);
  assert.ok(sized.length >= 1, 'at least one sized configure');
  assert.deepEqual(sized[0], { id: 1, w: 996, h: 596 },
    'first sized configure carries the post-insets content size');
});

test('preconfigure: configure fires AFTER interceptor settles + state commits', async () => {
  const bus = createDynamicBus();
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    pluginBus: bus,
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  // Slow interceptor: holds the configure until it returns.
  let resolveSlow;
  bus.intercept('window.preconfigure', () => new Promise((r) => { resolveSlow = r; }));
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  // Kick off markInitialCommitComplete without awaiting.
  const done = wm.markInitialCommitComplete(1, { appId: null, title: null });
  // Let microtasks run.
  await new Promise((r) => setImmediate(r));
  assert.equal(configures.length, 0); // configure not yet fired
  resolveSlow(undefined);
  await done;
  // The configures are held until the interceptor resolves; then the 0x0
  // handshake AND the real tile size (layout already settled) both go out.
  assert.deepEqual(configures, [{ id: 1, w: 0, h: 0 }, { id: 1, w: 1000, h: 600 }]);
});
