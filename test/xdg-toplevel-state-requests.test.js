// Unit tests for the xdg_toplevel state request wiring:
//   - set_maximized / unset_maximized -> propose presentation
//   - set_fullscreen / unset_fullscreen -> propose presentation
//   - set_minimized -> propose presentation
//   - set_min_size / set_max_size -> propose constraints (0,0 = null)
//   - set_parent -> propose parent
// The tests drive the protocol handler directly (no real wayland server).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import makeToplevel from '../packages/core/dist/protocols/xdg_toplevel.js';

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

function setupToplevelHandler() {
  const wm = createWm(mockSink(), { width: 1000, height: 600 });
  const toplevels = new Map();
  const state = { wm, toplevels, seat: null };
  const ctx = { state, events: { xdg_toplevel: {} } };
  const handler = makeToplevel(ctx);
  return { wm, toplevels, handler, ctx };
}

function addToplevel(setup, id) {
  const { resource, record } = makeFakeToplevel(id);
  setup.toplevels.set(resource, record);
  setup.wm.addWindow(id, record.xdgSurface.surface);
  return resource;
}

// --- presentation requests ---

test('set_maximized: proposes presentation=maximized', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_maximized(r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).presentation, 'maximized');
});

test('unset_maximized: proposes presentation=managed', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_maximized(r);
  await new Promise((resolve) => setImmediate(resolve));
  setup.handler.unset_maximized(r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).presentation, 'managed');
});

test('set_fullscreen: proposes presentation=fullscreen', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_fullscreen(r, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).presentation, 'fullscreen');
});

test('unset_fullscreen: proposes presentation=managed', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_fullscreen(r, null);
  await new Promise((resolve) => setImmediate(resolve));
  setup.handler.unset_fullscreen(r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).presentation, 'managed');
});

test('set_minimized: proposes presentation=minimized', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_minimized(r);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).presentation, 'minimized');
});

// --- size constraints ---

test('set_min_size: proposes constraints.minSize', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_min_size(r, 400, 300);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.wm.getWindowState(1).constraints.minSize,
    { width: 400, height: 300 });
});

test('set_min_size(0, 0): proposes constraints.minSize = null', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_min_size(r, 400, 300);
  await new Promise((resolve) => setImmediate(resolve));
  setup.handler.set_min_size(r, 0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).constraints.minSize, null);
});

test('set_max_size: proposes constraints.maxSize', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_max_size(r, 1920, 1080);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.wm.getWindowState(1).constraints.maxSize,
    { width: 1920, height: 1080 });
});

test('set_max_size(0, 0): proposes constraints.maxSize = null', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_max_size(r, 1920, 1080);
  await new Promise((resolve) => setImmediate(resolve));
  setup.handler.set_max_size(r, 0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(1).constraints.maxSize, null);
});

// --- parent ---

test('set_parent: proposes parent=parent-surfaceId', async () => {
  const setup = setupToplevelHandler();
  const parent = addToplevel(setup, 1);
  const child = addToplevel(setup, 2);
  setup.handler.set_parent(child, parent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(2).parent, 1);
});

test('set_parent(null): proposes parent=null', async () => {
  const setup = setupToplevelHandler();
  const parent = addToplevel(setup, 1);
  const child = addToplevel(setup, 2);
  setup.handler.set_parent(child, parent);
  await new Promise((resolve) => setImmediate(resolve));
  setup.handler.set_parent(child, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.wm.getWindowState(2).parent, null);
});

// --- still-noops ---

test('move / resize / show_window_menu: still no-op (no propose)', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  const before = setup.wm.getWindowState(1);
  setup.handler.move(r, null, 0);
  setup.handler.resize(r, null, 0, 0);
  setup.handler.show_window_menu(r, null, 0, 0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(setup.wm.getWindowState(1), before);
});

// --- accumulation: multiple requests before initial commit ---

test('multiple state requests accumulate; getWindowState reflects final state', async () => {
  const setup = setupToplevelHandler();
  const r = addToplevel(setup, 1);
  setup.handler.set_min_size(r, 400, 300);
  setup.handler.set_maximized(r);
  await new Promise((resolve) => setImmediate(resolve));
  const s = setup.wm.getWindowState(1);
  assert.equal(s.presentation, 'maximized');
  assert.deepEqual(s.constraints.minSize, { width: 400, height: 300 });
});
