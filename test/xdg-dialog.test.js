// Unit tests for the xdg_wm_dialog_v1 protocol handler:
//   - get_xdg_dialog creates a dialog object; second call on the same
//     toplevel posts the already_used protocol error.
//   - xdg_dialog_v1.set_modal routes through wm.propose with
//     clientRequests.wantsModal=true; default policy resolves to modal=true.
//   - unset_modal clears the wish (modal=false).
//   - Destroying the dialog object clears the modal hint.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import makeWmDialog, { makeXdgDialog } from '../packages/core/dist/protocols/xdg_dialog_v1.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function makeFakeToplevel(id) {
  const surface = { id, resource: { id, version: 1, destroyed: false } };
  const xdgSurface = { surface };
  const resource = { id, version: 1, destroyed: false };
  return { resource, record: { resource, xdgSurface, title: null, appId: null } };
}

function setup() {
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const toplevels = new Map();
  const postErrorCalls = [];
  const state = {
    wm, toplevels, seat: null,
  };
  const addon = {
    postError(resource, code, message) {
      postErrorCalls.push({ resource, code, message });
    },
  };
  const ctx = { state, addon, events: {} };
  const wmDialog = makeWmDialog(ctx);
  const dialog = makeXdgDialog(ctx);
  return { wm, toplevels, wmDialog, dialog, ctx, postErrorCalls };
}

function addToplevel(s, id) {
  const { resource, record } = makeFakeToplevel(id);
  s.toplevels.set(resource, record);
  s.wm.addWindow(id, record.xdgSurface.surface);
  s.wm.windowHasContent(id);
  return resource;
}

test('get_xdg_dialog: creates a dialog object', () => {
  const s = setup();
  const tl = addToplevel(s, 1);
  const dialogResource = { id: 'd1', version: 1, destroyed: false };
  const mgrResource = { id: 'm1', version: 1, destroyed: false };
  s.wmDialog.get_xdg_dialog(mgrResource, dialogResource, tl);
  // No error posted.
  assert.equal(s.postErrorCalls.length, 0);
});

test('get_xdg_dialog: already_used on second create for same toplevel', () => {
  const s = setup();
  const tl = addToplevel(s, 1);
  const d1 = { id: 'd1', version: 1, destroyed: false };
  const d2 = { id: 'd2', version: 1, destroyed: false };
  const mgr = { id: 'm', version: 1, destroyed: false };
  s.wmDialog.get_xdg_dialog(mgr, d1, tl);
  s.wmDialog.get_xdg_dialog(mgr, d2, tl);
  assert.equal(s.postErrorCalls.length, 1);
  assert.equal(s.postErrorCalls[0].code, 0); // already_used
});

test('set_modal: routes through wm.propose with wantsModal=true', async () => {
  const s = setup();
  const tl = addToplevel(s, 1);
  const dialogResource = { id: 'd1', version: 1, destroyed: false };
  const mgr = { id: 'm', version: 1, destroyed: false };
  s.wmDialog.get_xdg_dialog(mgr, dialogResource, tl);
  s.dialog.set_modal(dialogResource);
  // wm.propose is async; let it run.
  await new Promise((r) => setImmediate(r));
  const ws = s.wm.getWindowState(1);
  assert.equal(ws.clientRequests.wantsModal, true);
  assert.equal(ws.modal, true);
});

test('unset_modal: clears wantsModal and modal', async () => {
  const s = setup();
  const tl = addToplevel(s, 1);
  const dialogResource = { id: 'd1', version: 1, destroyed: false };
  const mgr = { id: 'm', version: 1, destroyed: false };
  s.wmDialog.get_xdg_dialog(mgr, dialogResource, tl);
  s.dialog.set_modal(dialogResource);
  await new Promise((r) => setImmediate(r));
  s.dialog.unset_modal(dialogResource);
  await new Promise((r) => setImmediate(r));
  const ws = s.wm.getWindowState(1);
  assert.equal(ws.clientRequests.wantsModal, false);
  assert.equal(ws.modal, false);
});

test('xdg_dialog.destroy: clears the modal hint', async () => {
  const s = setup();
  const tl = addToplevel(s, 1);
  const dialogResource = { id: 'd1', version: 1, destroyed: false };
  const mgr = { id: 'm', version: 1, destroyed: false };
  s.wmDialog.get_xdg_dialog(mgr, dialogResource, tl);
  s.dialog.set_modal(dialogResource);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.wm.getWindowState(1).modal, true);
  s.dialog.destroy(dialogResource);
  await new Promise((r) => setImmediate(r));
  assert.equal(s.wm.getWindowState(1).modal, false);
});
