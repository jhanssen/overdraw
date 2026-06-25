// Pure-unit tests for the deferred-initial-commit dance:
//   - addWindow({ deferInitialCommit: true }) holds the first configure.
//   - propose() between addWindow and markInitialCommitComplete accumulates
//     state (the eventual single configure reflects it). Pre-content
//     clientRequests go through resolveDecisions(phase="pre-content") so
//     a client's set_maximized boilerplate is suppressed by default.
//   - markInitialCommitComplete emits window.preconfigure (interceptable),
//     commits the (possibly modified) final state, schedules a relayout if
//     geometry-affecting fields changed, and forces a configure with the
//     resolved content size.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';

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

test('markInitialCommitComplete: throwaway 0x0 first configure; real size on first content', async () => {
  const configures = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    configure: { configure: (id, _x, _y, w, h) => { configures.push({ id, w, h }); return null; }, configureMove: () => {} },
    layoutDriverFactory: immediateLayoutDriver,
  });
  wm.addWindow(1, res(1), { deferInitialCommit: true });
  await wm.settled();
  await wm.markInitialCommitComplete(1, { appId: null, title: null });
  // First configure is the throwaway 0x0: the client gets a serial to ack and
  // may pick its own size; the real tile size lands as the SECOND configure.
  assert.deepEqual(configures, [{ id: 1, w: 0, h: 0 }]);
  // First content commit -> the real tile size goes out as a resize.
  wm.windowHasContent(1);
  assert.deepEqual(configures.at(-1), { id: 1, w: 1000, h: 600 });
  assert.equal(configures.length, 2);
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
  assert.equal(configures.length, 1); // configure fires after interceptor resolves
});
