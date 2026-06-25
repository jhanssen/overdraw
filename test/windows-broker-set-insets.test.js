// Pure-unit tests for windows.set-insets: the plugin-facing path the
// decoration-as-intercept design depends on. Authorization is mediated by
// the intercept broker (only the assigned intercept's owner can move a
// window's insets); a malformed payload throws; unknown windows return
// null.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowsBroker } from '../packages/core/dist/plugins/windows-broker.js';
import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../packages/core/dist/events/window-bus.js';
import { inlineMasterStackDriverFactory } from './wm-helpers.mjs';

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
  };
}

function res(id) { return { resource: { id, version: 1, destroyed: false } }; }

// Add a window AND wait for its layout to settle so wm.setInsets has
// a real outer rect to subtract from. Without this, `outer` stays at the
// placeholder and setInsets produces a zero-content rect.
async function addMapped(wm, id) {
  wm.addWindow(id, res(id));
  await wm.settled();
  wm.windowHasContent(id);
  await wm.settled();
}

// Stub intercept broker. Returns the plugin name we tell it to (or
// undefined). Tests use this to flip authorization on and off.
function stubIntercept(assignments = {}) {
  return {
    pluginNameForSurface(surfaceId) {
      return assignments[surfaceId];
    },
  };
}

function setup({ assignments = {}, withIntercept = true } = {}) {
  const sink = mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 1000, height: 800 }, scale: 1 }], {
    layoutDriverFactory: inlineMasterStackDriverFactory,
  });
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const state = { bus, wm, surfaces: new Map(), seat: null, compositor: null, decorationResize: null };
  const broker = createWindowsBroker({
    wm, compositor: sink, state, pluginBus, bus,
    ...(withIntercept ? { interceptBroker: stubIntercept(assignments) } : {}),
  });
  return { broker, wm };
}

// ---- authorization ----------------------------------------------------------

test('set-insets: rejects when interceptBroker is absent', async () => {
  const { broker, wm } = setup({ withIntercept: false });
  await addMapped(wm, 1);
  assert.throws(() => broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: 2, right: 2, bottom: 2, left: 2 } }),
    /intercept broker not configured/);
});

test('set-insets: rejects when no intercept is assigned to the surface', async () => {
  // No matching intercept means the broker doesn't know who owns this
  // window; without an owner, no plugin is authorized.
  const { broker, wm } = setup({ assignments: {} });
  await addMapped(wm, 1);
  assert.throws(() => broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: 2, right: 2, bottom: 2, left: 2 } }),
    /no intercept assigned/);
});

test('set-insets: rejects when the caller is not the assigned intercept owner', async () => {
  // Surface 1 is owned by plugin-b's intercept, not plugin-a.
  const { broker, wm } = setup({ assignments: { 1: 'plugin-b' } });
  await addMapped(wm, 1);
  assert.throws(() => broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: 2, right: 2, bottom: 2, left: 2 } }),
    /assigned to intercept owned by 'plugin-b', not 'plugin-a'/);
});

test('set-insets: accepts when the caller owns the assigned intercept', async () => {
  const { broker, wm } = setup({ assignments: { 1: 'plugin-a' } });
  await addMapped(wm, 1);
  const result = broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: 2, right: 2, bottom: 2, left: 2 } });
  // The grant carries the (clamped) insets + the resulting outer+content rects.
  assert.ok(result !== null && typeof result === 'object');
  assert.deepEqual(result.insets, { top: 2, right: 2, bottom: 2, left: 2 });
});

test('set-insets: returns null when the window is unknown', () => {
  const { broker } = setup({ assignments: { 99: 'plugin-a' } });
  // No addWindow(99) -> wm.setInsets returns undefined; the broker
  // translates undefined to null at the wire boundary.
  const result = broker('plugin-a', 'windows.set-insets',
    { id: 99, insets: { top: 1, right: 1, bottom: 1, left: 1 } });
  assert.equal(result, null);
});

// ---- payload validation -----------------------------------------------------

test('set-insets: missing id throws malformed payload', () => {
  const { broker } = setup({ assignments: { 1: 'plugin-a' } });
  assert.throws(() => broker('plugin-a', 'windows.set-insets',
    { insets: { top: 1, right: 1, bottom: 1, left: 1 } }),
    /malformed payload/);
});

test('set-insets: missing insets throws malformed payload', () => {
  const { broker } = setup({ assignments: { 1: 'plugin-a' } });
  assert.throws(() => broker('plugin-a', 'windows.set-insets', { id: 1 }),
    /malformed payload/);
});

test('set-insets: non-finite inset value throws', async () => {
  const { broker, wm } = setup({ assignments: { 1: 'plugin-a' } });
  await addMapped(wm, 1);
  assert.throws(() => broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: NaN, right: 0, bottom: 0, left: 0 } }),
    /malformed payload/);
});

test('set-insets: missing field in insets throws', async () => {
  const { broker, wm } = setup({ assignments: { 1: 'plugin-a' } });
  await addMapped(wm, 1);
  assert.throws(() => broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: 1, right: 1 } }),
    /malformed payload/);
});

// ---- shrinking math ---------------------------------------------------------

test('set-insets: shrinks content rect inside the outer tile', async () => {
  const { broker, wm } = setup({ assignments: { 1: 'plugin-a' } });
  await addMapped(wm, 1);
  const result = broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: 30, right: 5, bottom: 5, left: 5 } });
  // Outer is the full 1000x800 tile; content = outer minus insets.
  assert.equal(result.contentRect.width, 1000 - 5 - 5);
  assert.equal(result.contentRect.height, 800 - 30 - 5);
});

test('set-insets: clamps negative insets to zero', async () => {
  const { broker, wm } = setup({ assignments: { 1: 'plugin-a' } });
  await addMapped(wm, 1);
  const result = broker('plugin-a', 'windows.set-insets',
    { id: 1, insets: { top: -10, right: 0, bottom: 0, left: 0 } });
  assert.equal(result.insets.top, 0);
});
