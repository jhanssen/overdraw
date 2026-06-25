// Pure-unit tests for the WM's behavioral state + state bag.
// Covers propose() (the single mutation entry point for WindowState) and the
// freeform per-window state-bag setters. Uses a mock CompositorSink.

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

function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  wm.windowHasContent(id);
}

// --- defaults -------------------------------------------------------------

test('windowState: new window starts with default fields', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  const s = wm.getWindowState(1);
  assert.equal(s.tiling, 'managed');
  assert.equal(s.exclusive, 'none');
  assert.equal(s.visible, true);
  assert.deepEqual(s.clientRequests, {
    wantsMaximized: false, wantsFullscreen: false, wantsMinimized: false,
  });
  assert.equal(s.layoutMode, null);
  assert.equal(s.layoutData, undefined);
  assert.deepEqual(s.constraints, { minSize: null, maxSize: null });
  assert.equal(s.parent, null);
  assert.equal(s.restoreRect, null);
});

test('getWindowState: unknown window returns null', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  assert.equal(wm.getWindowState(999), null);
});

// --- propose: basic commits -----------------------------------------------

test('propose: writes exclusive directly and returns committed state', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  const committed = await wm.propose(1, { exclusive: 'maximized' }, 'client-request');
  assert.equal(committed.exclusive, 'maximized');
  assert.equal(wm.getWindowState(1).exclusive, 'maximized');
});

test('propose: client wantsMaximized post-content -> exclusive becomes maximized', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  const r = await wm.propose(1, { clientRequests: { wantsMaximized: true } }, 'client-request');
  assert.equal(r.exclusive, 'maximized');
  assert.equal(r.clientRequests.wantsMaximized, true);
});

test('propose: unknown window returns null', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const r = await wm.propose(999, { exclusive: 'maximized' }, 'plugin');
  assert.equal(r, null);
});

test('propose: empty proposal returns current state unchanged', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  const r = await wm.propose(1, {}, 'plugin');
  assert.equal(r.tiling, 'managed');
  assert.equal(r.exclusive, 'none');
});

test('propose: identical proposal is a no-op (no committed event)', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], { pluginBus: bus });
  addMapped(wm, 1);
  const events = [];
  bus.subscribe('window.committed', (_n, p) => { events.push(p); });
  await wm.propose(1, { tiling: 'managed' }, 'plugin');
  assert.equal(events.length, 0);
});

test('propose: partial proposal merges with current state', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  await wm.propose(1, { layoutMode: 'floating' }, 'plugin');
  const after = await wm.propose(1, { constraints: { minSize: { width: 100, height: 50 } } }, 'plugin');
  assert.equal(after.layoutMode, 'floating');
  assert.deepEqual(after.constraints.minSize, { width: 100, height: 50 });
  assert.equal(after.constraints.maxSize, null);
});

test('propose: layoutData passes through as opaque value', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  const data = { tabIndex: 3, group: 'A' };
  const r = await wm.propose(1, { layoutData: data }, 'plugin');
  assert.equal(r.layoutData, data);
});

test('propose: layoutMode can be set to null to clear', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  await wm.propose(1, { layoutMode: 'tabbed' }, 'plugin');
  const r = await wm.propose(1, { layoutMode: null }, 'plugin');
  assert.equal(r.layoutMode, null);
});

test('propose: parent can be set and cleared', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  addMapped(wm, 2);
  await wm.propose(2, { parent: 1 }, 'client-request');
  assert.equal(wm.getWindowState(2).parent, 1);
  await wm.propose(2, { parent: null }, 'client-request');
  assert.equal(wm.getWindowState(2).parent, null);
});

// --- propose: events ------------------------------------------------------

test('propose: emits window.proposed and window.committed (no interceptor)', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], { pluginBus: bus });
  addMapped(wm, 1);
  const proposed = [];
  const committed = [];
  bus.subscribe('window.proposed', (_n, p) => { proposed.push(p); });
  bus.subscribe('window.committed', (_n, p) => { committed.push(p); });
  await wm.propose(1, { exclusive: 'fullscreen' }, 'client-request');
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].surfaceId, 1);
  assert.equal(proposed[0].reason, 'client-request');
  assert.equal(proposed[0].current.exclusive, 'none');
  assert.equal(proposed[0].candidate.exclusive, 'fullscreen');
  assert.equal(committed.length, 1);
  assert.equal(committed[0].previous.exclusive, 'none');
  assert.equal(committed[0].current.exclusive, 'fullscreen');
  // The exclusive transition also captures restoreRect as a side effect.
  assert.ok(committed[0].changed.includes('exclusive'));
});

test('propose: interceptor modifies candidate and the modified state is committed', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], { pluginBus: bus });
  addMapped(wm, 1);
  // Coerce any 'fullscreen' candidate to 'maximized' instead.
  bus.intercept('window.proposed', (_n, p) => {
    const ev = p;
    if (ev.candidate.exclusive === 'fullscreen') {
      return { ...ev, candidate: { ...ev.candidate, exclusive: 'maximized' } };
    }
  });
  const r = await wm.propose(1, { exclusive: 'fullscreen' }, 'client-request');
  assert.equal(r.exclusive, 'maximized');
});

test('propose: interceptor reverting a field (modify-to-revert) is a veto', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], { pluginBus: bus });
  addMapped(wm, 1);
  bus.intercept('window.proposed', (_n, p) => {
    const ev = p;
    // Revert exclusive back to current = no change to that field.
    return { ...ev, candidate: { ...ev.candidate, exclusive: ev.current.exclusive } };
  });
  const committed = [];
  bus.subscribe('window.committed', (_n, p) => { committed.push(p); });
  await wm.propose(1, { exclusive: 'maximized' }, 'client-request');
  // The veto leaves the field unchanged -> no diff -> no commit event.
  assert.equal(committed.length, 0);
  assert.equal(wm.getWindowState(1).exclusive, 'none');
});

test('propose: interceptor returning garbage candidate is ignored (fallback)', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], { pluginBus: bus });
  addMapped(wm, 1);
  bus.intercept('window.proposed', () => ({ candidate: 'not-a-state-object' }));
  const r = await wm.propose(1, { exclusive: 'maximized' }, 'plugin');
  // Fallback: use the original (unmodified) candidate.
  assert.equal(r.exclusive, 'maximized');
});

test('propose: observe-only interceptor (undefined return) does not modify', async () => {
  const bus = createDynamicBus();
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], { pluginBus: bus });
  addMapped(wm, 1);
  bus.intercept('window.proposed', () => undefined);
  const r = await wm.propose(1, { exclusive: 'maximized' }, 'plugin');
  assert.equal(r.exclusive, 'maximized');
});

// --- propose: scheduling --------------------------------------------------

test('propose: geometry-affecting field triggers layout pass', async () => {
  let scheduled = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], {
    layoutDriverFactory: (target, snapshot) => {
      void target; void snapshot;
      return {
        schedule(reason) { scheduled.push(reason); },
        settled() { return Promise.resolve(); },
      };
    },
  });
  addMapped(wm, 1);
  scheduled = [];   // ignore the schedule from addWindow
  await wm.propose(1, { exclusive: 'maximized' }, 'plugin');
  assert.deepEqual(scheduled, ['state-changed']);
});

test('propose: non-geometry field (parent) does not schedule a layout', async () => {
  let scheduled = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], {
    layoutDriverFactory: (target, snapshot) => {
      void target; void snapshot;
      return {
        schedule(reason) { scheduled.push(reason); },
        settled() { return Promise.resolve(); },
      };
    },
  });
  addMapped(wm, 1);
  addMapped(wm, 2);
  scheduled = [];
  await wm.propose(2, { parent: 1 }, 'client-request');
  assert.deepEqual(scheduled, []);
});

test('propose: layoutData change schedules a relayout', async () => {
  let scheduled = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }], {
    layoutDriverFactory: (target, snapshot) => {
      void target; void snapshot;
      return {
        schedule(reason) { scheduled.push(reason); },
        settled() { return Promise.resolve(); },
      };
    },
  });
  addMapped(wm, 1);
  scheduled = [];
  await wm.propose(1, { layoutData: { tabIndex: 2 } }, 'plugin');
  assert.deepEqual(scheduled, ['state-changed']);
});

// --- state bag ------------------------------------------------------------

test('state-bag: setState stores the value', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  wm.setState(1, 'workspace.id', 3);
  assert.equal(wm.getState(1, 'workspace.id'), 3);
});

test('state-bag: setState returns true on first set, false on identical re-set', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  assert.equal(wm.setState(1, 'k', 42), true);
  assert.equal(wm.setState(1, 'k', 42), false);
});

test('state-bag: deleteState removes the value', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  wm.setState(1, 'k', 'v');
  assert.equal(wm.deleteState(1, 'k'), true);
  assert.equal(wm.getState(1, 'k'), undefined);
});

test('state-bag: setting null is distinct from delete', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  wm.setState(1, 'k', null);
  assert.equal(wm.getState(1, 'k'), null);
  assert.deepEqual(wm.getStateAll(1), { k: null });
});

test('state-bag: getStateAll returns all entries; empty when none', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  wm.setState(1, 'a', 1);
  wm.setState(1, 'b', 'two');
  assert.deepEqual(wm.getStateAll(1), { a: 1, b: 'two' });
});

// --- snapshots ------------------------------------------------------------

test('getSnapshot: includes windowState + state bag + geometry', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  await wm.propose(1, { exclusive: 'fullscreen', layoutMode: 'floating' }, 'plugin');
  wm.setState(1, 'workspace.id', 5);
  const s = wm.getSnapshot(1);
  assert.equal(s.surfaceId, 1);
  assert.equal(s.windowState.exclusive, 'fullscreen');
  assert.equal(s.windowState.layoutMode, 'floating');
  assert.equal(s.state['workspace.id'], 5);
  assert.equal(s.hasContent, true);
  assert.equal(s.contentGated, false);
});

test('getSnapshot: returns null for unknown window', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  assert.equal(wm.getSnapshot(999), null);
});

test('listSnapshots: returns one entry per tracked window in WM order', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  addMapped(wm, 2);
  addMapped(wm, 3);
  const all = wm.listSnapshots();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((w) => w.surfaceId), [3, 2, 1]);
});

test('snapshot: state map is copied (mutations on the snapshot do not affect WM)', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  wm.setState(1, 'k', 'v');
  const s = wm.getSnapshot(1);
  s.state.k = 'changed';
  assert.equal(wm.getState(1, 'k'), 'v');
});

test('snapshot: windowState is a deep copy (mutations do not affect WM)', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  addMapped(wm, 1);
  const s = wm.getSnapshot(1);
  s.windowState.exclusive = 'maximized';
  assert.equal(wm.getWindowState(1).exclusive, 'none');
});
