// Pure-unit tests for the WM's floating tiling lane:
//   - The resolver dispatches floating windows in core (plugin not called).
//   - First transition into the floating lane captures the current outer
//     as the initial floating rect.
//   - setFloatingRect updates the stored rect and schedules a relayout.
//   - The bundled master-stack plugin doesn't see floating windows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { createLayoutDriver } from '../packages/core/dist/wm/layout-driver.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockSink() {
  return {
    layouts: [],
    stacks: [],
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setStack(ids) { this.stacks.push(ids); },
    setLayerSurfaces() {}, setSurfaceTexture() {},
    commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

async function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  await wm.settled();
  wm.windowHasContent(id);
}

// Driver that runs a fake master-stack synchronously, but verifies which
// windows the plugin actually sees.
function recordingDriver(pluginVisible) {
  return (target, snapshot) => createLayoutDriver({
    target, snapshot,
    compute: async (inputs) => {
      pluginVisible.push(inputs.windows.map((w) => w.id));
      return {
        rects: inputs.windows.map((w) => ({
          id: w.id,
          outer: { x: 0, y: 0, width: 500, height: 600 },
        })),
      };
    },
  });
}

// --- tiling lane dispatch -----------------------------------------------

test('floating window: captures initial rect from current outer on first transition', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  // Currently no floatingRect.
  assert.equal(wm.getFloatingRect(1), null);

  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  const fr = wm.getFloatingRect(1);
  assert.ok(fr);
  // Initial floating rect = current outer at the time of transition.
  // With single-window master-stack: full output.
  assert.deepEqual(fr, { x: 0, y: 0, width: 1000, height: 600 });
});

test('setFloatingRect: updates stored rect', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  wm.setFloatingRect(1, { x: 100, y: 200, width: 400, height: 300 });
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 100, y: 200, width: 400, height: 300 });
});

test('setFloatingRect: schedules a layout pass', () => {
  let scheduled = 0;
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: (target, snapshot) => {
      void target; void snapshot;
      return {
        schedule() { scheduled++; },
        settled() { return Promise.resolve(); },
      };
    },
  });
  wm.addWindow(1, res(1));  // sync; driver is fake
  const before = scheduled;
  wm.setFloatingRect(1, { x: 10, y: 20, width: 100, height: 80 });
  assert.equal(scheduled, before + 1);
});

test('resolver: floating window uses its floatingRect, not the plugin output', async () => {
  const visible = [];
  const layouts = [];
  const sink = {
    ...mockSink(),
    setSurfaceLayout(id, x, y, w, h) { layouts.push({ id, x, y, w, h }); },
  };
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: recordingDriver(visible),
  });
  await addMapped(wm, 1);
  layouts.length = 0;

  // Transition to floating with an explicit rect.
  wm.setFloatingRect(1, { x: 100, y: 50, width: 300, height: 200 });
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  await wm.settled();
  // The plugin should NOT have been called for the floating window (no
  // managed windows). The resolver assigned the floating rect.
  const lastLayout = layouts.at(-1);
  assert.deepEqual(lastLayout, { id: 1, x: 100, y: 50, w: 300, h: 200 });
});

test('resolver: layout plugin only sees managed windows, not floating', async () => {
  const visible = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: recordingDriver(visible),
  });
  await addMapped(wm, 1);
  await addMapped(wm, 2);
  visible.length = 0;

  await wm.propose(2, { tiling: 'floating' }, 'user-input');
  await wm.settled();
  // The plugin's last invocation saw only window 1 (managed); window 2 is
  // floating and resolved in core.
  assert.deepEqual(visible.at(-1), [1]);
});

test('resolver: empty managed set with floating window: plugin not called', async () => {
  const visible = [];
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: recordingDriver(visible),
  });
  await addMapped(wm, 1);
  visible.length = 0;
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  await wm.settled();
  // No managed windows -> plugin not called.
  assert.equal(visible.length, 0);
});

test('floating rect preserved across floating -> managed -> floating', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  // First float at default rect (= current outer at transition).
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  const initial = wm.getFloatingRect(1);
  // User drags to a new position.
  wm.setFloatingRect(1, { x: 200, y: 100, width: 500, height: 400 });
  // Back to managed.
  await wm.propose(1, { tiling: 'managed' }, 'user-input');
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 200, y: 100, width: 500, height: 400 });
  // Float again -- rect is preserved (no re-capture).
  await wm.propose(1, { tiling: 'floating' }, 'user-input');
  assert.deepEqual(wm.getFloatingRect(1),
    { x: 200, y: 100, width: 500, height: 400 });
  assert.notDeepEqual(wm.getFloatingRect(1), initial);
});

test('getFloatingRect: unknown window returns null', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]);
  assert.equal(wm.getFloatingRect(999), null);
});

test('setFloatingRect: unknown window is a no-op (no throw)', () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]);
  wm.setFloatingRect(999, { x: 0, y: 0, width: 1, height: 1 });
  // Just confirms no throw.
  assert.equal(wm.getFloatingRect(999), null);
});

// --- tiling-lane propose accepted ---------------------------------------

test('propose: tiling=floating is accepted', async () => {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  await addMapped(wm, 1);
  const r = await wm.propose(1, { tiling: 'floating' }, 'user-input');
  assert.equal(r.tiling, 'floating');
});
