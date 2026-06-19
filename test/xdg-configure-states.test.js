// Unit test for configureToplevel's states-array contents. The states array
// in xdg_toplevel.configure reflects the window's current presentation
// (maximized -> [1], fullscreen -> [2], managed -> the four tiled states on a
// v2+ toplevel) plus 'activated' (4) when this window has keyboard focus.

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
  const wm = createWm(mockSink(), [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]);
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
  const toplevel = { id: 100, version: 6 };
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
const STATE_TILED_LEFT = 5;
const STATE_TILED_RIGHT = 6;
const STATE_TILED_TOP = 7;
const STATE_TILED_BOTTOM = 8;
const TILED = [STATE_TILED_LEFT, STATE_TILED_RIGHT, STATE_TILED_TOP, STATE_TILED_BOTTOM];

test('managed window (v2+): maximized (size is binding) plus the four tiled edges', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  configureToplevel(s.ctx, s.xs, 800, 600);
  assert.deepEqual(s.getConfigure().states.slice().sort(),
    [STATE_MAXIMIZED, ...TILED].slice().sort());
  assert.equal(s.getConfigure().w, 800);
  assert.equal(s.getConfigure().h, 600);
});

test('managed window on a v1 toplevel: maximized only (tiled states are v2+)', async () => {
  const s = setup();
  s.xs.toplevel.version = 1;
  s.wm.addWindow(1, { resource: {} });
  configureToplevel(s.ctx, s.xs, 800, 600);
  assert.deepEqual(s.getConfigure().states, [STATE_MAXIMIZED]);
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

test('focused managed window: maximized + tiled states + activated', async () => {
  const s = setup();
  s.wm.addWindow(1, { resource: {} });
  s.ctx.state.seat = { kbFocus: { surfaceId: 1 } };
  configureToplevel(s.ctx, s.xs, 800, 600);
  assert.deepEqual(s.getConfigure().states.slice().sort(),
    [STATE_MAXIMIZED, ...TILED, STATE_ACTIVATED].slice().sort());
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
