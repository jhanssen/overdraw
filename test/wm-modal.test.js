// Modality unit tests.
//   - Z-order: modal child raises with parent; non-modal floating child
//     of a floating parent does NOT raise with parent; non-modal child
//     of a managed parent raises with parent (the tile owns the dialog).
//   - Focus tethering: modal map steals focus iff the parent chain has
//     focus; modal unmap returns focus to parent.
//   - Input gating: windowAt redirects a hit on a parent (or non-modal
//     ancestor) to its topmost modal descendant.
//   - clientRequests.wantsModal goes through the policy seam.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }
const OUT = [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }];

// Build a WM with optional seat-focus hooks. `seat` is { focused, applyKeyboardFocus }.
function setup(seat) {
  const opts = {};
  if (seat) {
    opts.currentFocusedSurfaceId = () => seat.focused;
    opts.requestFocus = (id) => { seat.applyKeyboardFocus(id); };
  }
  return createWm(mockSink(), OUT, opts);
}

function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  wm.windowHasContent(id);
}

// ---- defaults ------------------------------------------------------------

test('defaults: modal=false, clientRequests.wantsModal=false', () => {
  const wm = setup();
  addMapped(wm, 1);
  const s = wm.getWindowState(1);
  assert.equal(s.modal, false);
  assert.equal(s.clientRequests.wantsModal, false);
});

// ---- policy seam ---------------------------------------------------------

test('wantsModal post-content -> modal=true (default policy honors)', async () => {
  const wm = setup();
  addMapped(wm, 1);
  const r = await wm.propose(1, { clientRequests: { wantsModal: true } }, 'client-request');
  assert.equal(r.modal, true);
  assert.equal(r.clientRequests.wantsModal, true);
});

test('wantsModal cleared -> modal=false', async () => {
  const wm = setup();
  addMapped(wm, 1);
  await wm.propose(1, { clientRequests: { wantsModal: true } }, 'client-request');
  const r = await wm.propose(1, { clientRequests: { wantsModal: false } }, 'client-request');
  assert.equal(r.modal, false);
});

// ---- z-order: raise-with rule -------------------------------------------

test('modal child raises with parent (floating parent)', async () => {
  const wm = setup();
  addMapped(wm, 1);
  // window 1 is floating
  await wm.propose(1, { tiling: 'floating' }, 'plugin');
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  wm.windowHasContent(2);
  // window 3 is unrelated floating, raised on top
  addMapped(wm, 3);
  await wm.propose(3, { tiling: 'floating' }, 'plugin');
  wm.raiseWindow(3);
  // Now click on window 1 (modal's parent): both 1 and 2 should rise.
  wm.raiseWindow(1);
  const z1 = wm.getSnapshot(1).windowState; void z1;
  // Snapshot doesn't expose z; query the WM internals via state.windows.
  const win1 = wm.state.windows.find((w) => w.surfaceId === 1);
  const win2 = wm.state.windows.find((w) => w.surfaceId === 2);
  const win3 = wm.state.windows.find((w) => w.surfaceId === 3);
  assert.ok(win2.z > win1.z, 'modal above parent');
  assert.ok(win1.z > win3.z, 'parent raised above 3');
  assert.ok(win2.z > win3.z, 'modal also above 3');
});

test('non-modal floating child of floating parent: does NOT raise with parent', async () => {
  const wm = setup();
  // Build: 1 floating, 2 floating child of 1 (non-modal), 3 floating unrelated.
  addMapped(wm, 1);
  await wm.propose(1, { tiling: 'floating' }, 'plugin');
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, tiling: 'floating' }, 'plugin');
  wm.windowHasContent(2);
  addMapped(wm, 3);
  await wm.propose(3, { tiling: 'floating' }, 'plugin');
  // Raise child 2 to the peak, then raise parent 1.
  wm.raiseWindow(2);
  wm.raiseWindow(1);
  const win1 = wm.state.windows.find((w) => w.surfaceId === 1);
  const win2 = wm.state.windows.find((w) => w.surfaceId === 2);
  // Parent went above; child stayed where it was (still above 3 but below 1
  // because 1's raise didn't drag 2 with it).
  assert.ok(win1.z > win2.z, 'parent now above child (child did not raise with parent)');
});

test('non-modal child of managed (tiled) parent: raises with parent', async () => {
  const wm = setup();
  // window 1 is tiled (managed). window 2 is a floating dialog of 1
  // (non-modal). window 3 is unrelated floating on top.
  addMapped(wm, 1); // managed
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, tiling: 'floating' }, 'plugin');
  wm.windowHasContent(2);
  addMapped(wm, 3);
  await wm.propose(3, { tiling: 'floating' }, 'plugin');
  // Now click the managed parent: raise-with should drag the dialog
  // (because parent is managed -> raises-with applies).
  wm.raiseWindow(1);
  const win1 = wm.state.windows.find((w) => w.surfaceId === 1);
  const win2 = wm.state.windows.find((w) => w.surfaceId === 2);
  const win3 = wm.state.windows.find((w) => w.surfaceId === 3);
  assert.ok(win2.z > win1.z, 'dialog above tile');
  assert.ok(win1.z > win3.z, 'tile (parent) raised above unrelated floater');
  assert.ok(win2.z > win3.z, 'dialog raised with parent above unrelated floater');
});

// ---- live re-stack on modal/parent change -------------------------------

test('setting modal on a live window restacks above parent', async () => {
  const wm = setup();
  addMapped(wm, 1);
  await wm.propose(1, { tiling: 'floating' }, 'plugin');
  wm.addWindow(2, res(2));
  // Non-modal dialog, parent=1, floating.
  await wm.propose(2, { parent: 1, tiling: 'floating' }, 'plugin');
  wm.windowHasContent(2);
  // Raise parent above child.
  wm.raiseWindow(1);
  const before = wm.state.windows.find((w) => w.surfaceId === 2).z;
  const parentZBefore = wm.state.windows.find((w) => w.surfaceId === 1).z;
  assert.ok(parentZBefore > before, 'parent above child initially');
  // Now mark the dialog modal: it should restack above parent live.
  await wm.propose(2, { modal: true }, 'plugin');
  const win1 = wm.state.windows.find((w) => w.surfaceId === 1);
  const win2 = wm.state.windows.find((w) => w.surfaceId === 2);
  assert.ok(win2.z > win1.z, 'modal restacked above parent');
});

// ---- focus tethering -----------------------------------------------------

function mockSeat() {
  return {
    focused: null,
    appliedCalls: [],
    applyKeyboardFocus(id) {
      this.appliedCalls.push(id);
      this.focused = id;
    },
  };
}

test('modal map: focus tethered if parent has focus', async () => {
  const seat = mockSeat();
  const wm = setup(seat);
  addMapped(wm, 1);
  // Parent has focus.
  seat.focused = 1;
  // Map modal child.
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  wm.windowHasContent(2);
  // Focus should have moved to 2.
  assert.deepEqual(seat.appliedCalls, [2]);
  assert.equal(seat.focused, 2);
});

test('modal map: focus NOT tethered if parent does not have focus', async () => {
  const seat = mockSeat();
  const wm = setup(seat);
  addMapped(wm, 1);
  addMapped(wm, 3);
  // Focus is on window 3, not the modal's parent (1).
  seat.focused = 3;
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  wm.windowHasContent(2);
  // No tether: focus stays on 3.
  assert.deepEqual(seat.appliedCalls, []);
  assert.equal(seat.focused, 3);
});

test('modal unmap: focus returned to parent if modal had focus', async () => {
  const seat = mockSeat();
  const wm = setup(seat);
  addMapped(wm, 1);
  seat.focused = 1;
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  wm.windowHasContent(2);
  // After map: focus on 2.
  assert.equal(seat.focused, 2);
  seat.appliedCalls.length = 0;
  wm.unmapWindow(2);
  assert.deepEqual(seat.appliedCalls, [1]);
  assert.equal(seat.focused, 1);
});

test('modal=false on focused modal: focus returned to parent', async () => {
  const seat = mockSeat();
  const wm = setup(seat);
  addMapped(wm, 1);
  seat.focused = 1;
  wm.addWindow(2, res(2));
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  wm.windowHasContent(2);
  assert.equal(seat.focused, 2);
  seat.appliedCalls.length = 0;
  await wm.propose(2, { modal: false }, 'plugin');
  assert.deepEqual(seat.appliedCalls, [1]);
});

test('modal with no parent (orphan): no tether, no untether on unmap', async () => {
  const seat = mockSeat();
  const wm = setup(seat);
  addMapped(wm, 1);
  seat.focused = 1;
  // System-alert-style: modal with no parent.
  wm.addWindow(2, res(2));
  await wm.propose(2, { modal: true }, 'plugin');
  wm.windowHasContent(2);
  // No parent in chain, no tether. Focus stays on 1.
  assert.deepEqual(seat.appliedCalls, []);
});

// ---- input gating --------------------------------------------------------

test('windowAt: click on parent of open modal redirects to modal', async () => {
  const wm = setup();
  // Two non-overlapping rects so we can deterministically test.
  // window 1: 0..100 x 0..100. window 2 (modal child): 200..300 x 0..100.
  wm.addWindow(1, res(1));
  // Force its rect manually via a direct mutation -- the layout driver
  // would otherwise assign default geometry. The simplest approach: feed
  // through a non-default layout factory. For unit-test simplicity, just
  // use windowHasContent (which sets a default rect from the layout) and
  // then manipulate. Since createWm without a layoutDriverFactory uses a
  // no-op driver, the rect stays at the addWindow placeholder. We need a
  // real test rect: tweak the window directly. windows is a public
  // (state.windows) array.
  const w1 = wm.state.windows.find((w) => w.surfaceId === 1);
  w1.rect = { x: 0, y: 0, width: 100, height: 100 };
  w1.outer = { ...w1.rect };
  w1.hasContent = true;
  wm.addWindow(2, res(2));
  const w2 = wm.state.windows.find((w) => w.surfaceId === 2);
  w2.rect = { x: 200, y: 0, width: 100, height: 100 };
  w2.outer = { ...w2.rect };
  w2.hasContent = true;
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  // Click on parent (50, 50): should redirect to modal (w2).
  const hit = wm.windowAt(50, 50);
  assert.ok(hit, 'hit something');
  assert.equal(hit.surfaceId, 2, 'click on parent redirected to modal');
  // Click on modal directly (250, 50): obviously stays on modal.
  const hit2 = wm.windowAt(250, 50);
  assert.equal(hit2.surfaceId, 2);
});

test('windowAt: non-modal child does not gate parent clicks', async () => {
  const wm = setup();
  wm.addWindow(1, res(1));
  const w1 = wm.state.windows.find((w) => w.surfaceId === 1);
  w1.rect = { x: 0, y: 0, width: 100, height: 100 };
  w1.outer = { ...w1.rect };
  w1.hasContent = true;
  wm.addWindow(2, res(2));
  const w2 = wm.state.windows.find((w) => w.surfaceId === 2);
  w2.rect = { x: 200, y: 0, width: 100, height: 100 };
  w2.outer = { ...w2.rect };
  w2.hasContent = true;
  // Non-modal child.
  await wm.propose(2, { parent: 1 }, 'plugin');
  // Click on parent (50, 50): NOT redirected -- non-modal doesn't gate.
  const hit = wm.windowAt(50, 50);
  assert.equal(hit.surfaceId, 1);
});

test('windowAt: nested modal -- topmost modal in subtree wins', async () => {
  const wm = setup();
  // root 1, modal child 2 (parent=1), nested modal 3 (parent=2).
  wm.addWindow(1, res(1));
  const w1 = wm.state.windows.find((w) => w.surfaceId === 1);
  w1.rect = { x: 0, y: 0, width: 100, height: 100 };
  w1.outer = { ...w1.rect };
  w1.hasContent = true;
  wm.addWindow(2, res(2));
  const w2 = wm.state.windows.find((w) => w.surfaceId === 2);
  w2.rect = { x: 200, y: 0, width: 100, height: 100 };
  w2.outer = { ...w2.rect };
  w2.hasContent = true;
  await wm.propose(2, { parent: 1, modal: true }, 'plugin');
  wm.addWindow(3, res(3));
  const w3 = wm.state.windows.find((w) => w.surfaceId === 3);
  w3.rect = { x: 400, y: 0, width: 100, height: 100 };
  w3.outer = { ...w3.rect };
  w3.hasContent = true;
  await wm.propose(3, { parent: 2, modal: true }, 'plugin');
  // Click on root (50,50): should redirect to topmost modal in chain,
  // which is 3 (nested modal). 3 has higher z than 2.
  const hit = wm.windowAt(50, 50);
  assert.equal(hit.surfaceId, 3);
  // Click on the inner modal's parent (250,50 = window 2): also gated
  // to its modal descendant, which is 3.
  const hit2 = wm.windowAt(250, 50);
  assert.equal(hit2.surfaceId, 3);
  // Click on the innermost modal directly (450,50): stays.
  const hit3 = wm.windowAt(450, 50);
  assert.equal(hit3.surfaceId, 3);
});
