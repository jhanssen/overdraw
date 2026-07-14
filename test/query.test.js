// Pure-unit tests for the state-query channel (src/query.ts). Builds a minimal
// CompositorState with the real WM (mock addon) plus hand-built surface/toplevel
// records, then asserts queryState() snapshots geometry / stack / focus / titles
// correctly. No GPU, no Wayland.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';
import { queryState } from '../packages/core/dist/query.js';

function mockAddon() {
  return { setSurfaceLayout() {}, setStack() {} };
}

// Build a CompositorState scaffold with the real WM and given surfaces.
function makeState(output = { width: 1920, height: 1080 }) {
  const surfaces = new Map();   // resource -> SurfaceRecord
  const toplevels = new Map();  // toplevel resource -> ToplevelRecord
  // Inline master-stack driver so addToplevel windows pick up real rects on
  // settle (otherwise the WM's no-op driver leaves them as placeholders).
  const wm = createWm(mockAddon(), [{
    id: 0,
    rect: { x: 0, y: 0, width: output.width, height: output.height },
    scale: 1,
  }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });

  const state = {
    surfaces, toplevels, nextSerial: 1,
    serial() { return this.nextSerial++; },
    wm,
    seat: { focus: null, kbFocus: null },
  };

  // Helper: create a mapped toplevel surface with title/app_id and map it.
  // Async because the inline layout driver compute() resolves on the next
  // microtask; callers `await addToplevel(...)`.
  async function addToplevel(id, { title = null, appId = null, w = 200, h = 100 } = {}) {
    const surfaceRes = { __surface: id };
    const toplevelRes = { __toplevel: id };
    const xdgSurface = { resource: { __xdg: id }, role: 'toplevel', toplevel: toplevelRes };
    const surfaceRec = {
      id, resource: surfaceRes, role: 'xdg_toplevel',
      pending: {}, committed: { buffer: null }, xdgSurface, mapped: true,
    };
    surfaces.set(surfaceRes, surfaceRec);
    (state.surfacesById ??= new Map()).set(id, surfaceRec);
    toplevels.set(toplevelRes, { resource: toplevelRes, xdgSurface, title, appId });
    wm.addWindow(id, surfaceRec);
    await wm.settled();
    wm.windowHasContent(id);
    return surfaceRec;
  }

  return { state, addToplevel };
}

test('queryState: empty compositor', () => {
  const { state } = makeState();
  const snap = queryState(state);
  assert.equal(snap.outputs.length, 1);
  assert.deepEqual(snap.outputs[0],
    { id: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, cameraX: 0, cameraY: 0 });
  assert.deepEqual(snap.windows, []);
  assert.deepEqual(snap.stack, []);
  assert.equal(snap.pointerFocus, null);
  assert.equal(snap.keyboardFocus, null);
});

test('queryState: windows with geometry, title, app_id, role', async () => {
  const { state, addToplevel } = makeState();
  await addToplevel(1, { title: 'term', appId: 'foot', w: 300, h: 200 });

  const snap = queryState(state);
  assert.equal(snap.windows.length, 1);
  const win = snap.windows[0];
  assert.equal(win.surfaceId, 1);
  assert.equal(win.title, 'term');
  assert.equal(win.appId, 'foot');
  assert.equal(win.role, 'xdg_toplevel');
  assert.equal(win.mapped, true);
  // Tiling owns geometry: a single window fills the output (content size ignored).
  assert.equal(win.rect.width, 1920);
  assert.equal(win.rect.height, 1080);
});

test('queryState: window order is layout order (master first)', async () => {
  const { state, addToplevel } = makeState();
  await addToplevel(1);
  await addToplevel(2);
  await addToplevel(3);
  const snap = queryState(state);
  // Each new window becomes master (inserted at the front); order is [3, 2, 1].
  assert.deepEqual(snap.stack, [3, 2, 1]);
  assert.deepEqual(snap.windows.map((w) => w.surfaceId), [3, 2, 1]);
});

test('queryState: reflects pointer + keyboard focus', async () => {
  const { state, addToplevel } = makeState();
  await addToplevel(1);
  await addToplevel(2);
  state.seat.focus = { surfaceId: 2 };
  state.seat.kbFocus = { surfaceId: 1 };
  const snap = queryState(state);
  assert.equal(snap.pointerFocus, 2);
  assert.equal(snap.keyboardFocus, 1);
});

test('queryState: window missing a toplevel record yields null title/appId', async () => {
  const { state, addToplevel } = makeState();
  const rec = await addToplevel(1);
  // Drop the toplevel record but keep the window mapped.
  state.toplevels.delete(rec.xdgSurface.toplevel);
  const snap = queryState(state);
  assert.equal(snap.windows[0].title, null);
  assert.equal(snap.windows[0].appId, null);
});

test('queryState: snapshot is serializable (JSON round-trips)', async () => {
  const { state, addToplevel } = makeState();
  await addToplevel(1, { title: 'a', appId: 'b' });
  const snap = queryState(state);
  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round, snap);
});
