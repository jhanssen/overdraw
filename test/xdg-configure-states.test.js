// Unit test for configureToplevel's states-array contents. The states array
// in xdg_toplevel.configure must reflect the window's current presentation
// (maximized -> [1], fullscreen -> [2], managed -> []) plus 'activated' (4)
// when this window has keyboard focus.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWm } from '../packages/core/dist/wm/index.js';
import { configureToplevel } from '../packages/core/dist/protocols/xdg_surface.js';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
  };
}

function unpackStates(packed) {
  // packed is a Uint8Array with N*4 bytes; reinterpret as uint32 host-endian.
  const buf = packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength);
  return Array.from(new Uint32Array(buf));
}

function setup() {
  const wm = createWm(mockSink(), { width: 1000, height: 600 });
  let serial = 0;
  let lastConfigure = null;
  let lastSurfaceConfigure = null;
  const ctx = {
    state: {
      wm,
      nextSerial: 1,
      serial: () => ++serial,
      seat: null,
    },
    events: {
      xdg_toplevel: {
        send_configure(_resource, w, h, states) {
          lastConfigure = { w, h, states: unpackStates(states) };
        },
      },
      xdg_surface: {
        send_configure(_resource, serial) {
          lastSurfaceConfigure = { serial };
        },
      },
    },
  };
  const surface = { id: 1 };
  const toplevel = { id: 100 };
  const xs = {
    resource: { id: 50 },
    toplevel,
    surface,
  };
  return { wm, ctx, xs, getConfigure: () => lastConfigure, getSurfaceConfigure: () => lastSurfaceConfigure };
}

const STATE_MAXIMIZED = 1;
const STATE_FULLSCREEN = 2;
const STATE_ACTIVATED = 4;

test('managed window with no focus: states is empty', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  configureToplevel(s.ctx, s.xs, 800, 600);
  assert.deepEqual(s.getConfigure().states, []);
  assert.deepEqual(s.getConfigure(), { w: 800, h: 600, states: [] });
});

test('maximized window: states contains maximized', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  await s.wm.propose(1, { presentation: 'maximized' }, 'client-request');
  configureToplevel(s.ctx, s.xs, 1000, 600);
  assert.deepEqual(s.getConfigure().states, [STATE_MAXIMIZED]);
});

test('fullscreen window: states contains fullscreen', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  await s.wm.propose(1, { presentation: 'fullscreen' }, 'client-request');
  configureToplevel(s.ctx, s.xs, 1000, 600);
  assert.deepEqual(s.getConfigure().states, [STATE_FULLSCREEN]);
});

test('focused window: states contains activated', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  s.ctx.state.seat = { kbFocus: { surfaceId: 1 } };
  configureToplevel(s.ctx, s.xs, 800, 600);
  assert.deepEqual(s.getConfigure().states, [STATE_ACTIVATED]);
});

test('maximized + focused: states contains both', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  await s.wm.propose(1, { presentation: 'maximized' }, 'client-request');
  s.ctx.state.seat = { kbFocus: { surfaceId: 1 } };
  configureToplevel(s.ctx, s.xs, 1000, 600);
  // Order: presentation first, then activated.
  assert.deepEqual(s.getConfigure().states.sort(),
    [STATE_MAXIMIZED, STATE_ACTIVATED].sort());
});

test('minimized window: states is empty (minimized has no xdg state)', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  await s.wm.propose(1, { presentation: 'minimized' }, 'client-request');
  configureToplevel(s.ctx, s.xs, 0, 0);
  assert.deepEqual(s.getConfigure().states, []);
});

test('configure records serial on the xdg_surface and fires both events', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  configureToplevel(s.ctx, s.xs, 800, 600);
  assert.equal(s.xs.lastConfigureSerial, 1);
  assert.equal(s.getSurfaceConfigure().serial, 1);
});
