// Pure-unit tests for the windows broker's per-surface render-state setters:
// windows.set-opacity / set-transform / set-output-margin. Verifies the
// broker forwards typed payloads to the compositor sink, rejects malformed
// payloads, and reports "not supported" when the sink lacks the method.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWindowsBroker } from '../packages/core/dist/plugins/windows-broker.js';
import { createWm } from '../packages/core/dist/wm/index.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';
import { createCompositorBus } from '../packages/core/dist/events/window-bus.js';

function mockSink() {
  const calls = [];
  return {
    calls,
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    setOutputStack() {},
    setSurfaceOpacity(id, opacity) {
      calls.push({ method: 'setSurfaceOpacity', id, opacity });
    },
    setSurfaceTransform(id, t) {
      calls.push({ method: 'setSurfaceTransform', id, t });
    },
    setSurfaceOutputMargin(id, m) {
      calls.push({ method: 'setSurfaceOutputMargin', id, m });
    },
    setSurfaceMask(id, mask) {
      calls.push({ method: 'setSurfaceMask', id, mask });
    },
    setSurfaceTint(id, t) {
      calls.push({ method: 'setSurfaceTint', id, t });
    },
    setSurfaceColorMatrix(id, m) {
      calls.push({ method: 'setSurfaceColorMatrix', id, m });
    },
    setSurfaceBackdropEffect(id, e) {
      calls.push({ method: 'setSurfaceBackdropEffect', id, e });
    },
  };
}

function makeBroker(sinkOverride) {
  const sink = sinkOverride ?? mockSink();
  const wm = createWm(sink, [{ id: 0, rect: { x: 0, y: 0, width: 800, height: 600 }, scale: 1 }]);
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const state = { bus, wm, surfaces: new Map(), seat: null, compositor: null,
                  decorationResize: null };
  const broker = createWindowsBroker({ wm, compositor: sink, state, pluginBus, bus });
  return { broker, sink };
}

// ---- set-opacity ------------------------------------------------------------

test('set-opacity: forwards id + opacity to the sink', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-opacity', { id: 7, opacity: 0.5 });
  assert.deepEqual(sink.calls[0], { method: 'setSurfaceOpacity', id: 7, opacity: 0.5 });
});

test('set-opacity: opacity 0 and 1 are accepted', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-opacity', { id: 1, opacity: 0 });
  broker('p', 'windows.set-opacity', { id: 2, opacity: 1 });
  assert.equal(sink.calls.length, 2);
  assert.equal(sink.calls[0].opacity, 0);
  assert.equal(sink.calls[1].opacity, 1);
});

test('set-opacity: missing id throws malformed payload', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-opacity', { opacity: 0.5 }),
    /malformed payload/);
});

test('set-opacity: non-finite opacity throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-opacity', { id: 1, opacity: NaN }),
    /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-opacity', { id: 1, opacity: Infinity }),
    /malformed payload/);
});

test('set-opacity: sink without setSurfaceOpacity -> not supported', () => {
  const bare = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setSurfaceOpacity
  };
  const { broker } = makeBroker(bare);
  assert.throws(() => broker('p', 'windows.set-opacity', { id: 1, opacity: 0.5 }),
    /not supported/);
});

// ---- set-transform ----------------------------------------------------------

test('set-transform: forwards the full transform object', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-transform',
    { id: 7, t: { translateX: 10, translateY: -5, scaleX: 1.5, scaleY: 1.5 } });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceTransform', id: 7,
      t: { translateX: 10, translateY: -5, scaleX: 1.5, scaleY: 1.5 } });
});

test('set-transform: partial transform (only translate) is accepted', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-transform', { id: 7, t: { translateX: 20 } });
  assert.deepEqual(sink.calls[0].t, { translateX: 20 });
});

test('set-transform: empty object (identity) is accepted', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-transform', { id: 7, t: {} });
  assert.deepEqual(sink.calls[0].t, {});
});

test('set-transform: non-finite field throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-transform',
    { id: 1, t: { translateX: NaN } }), /malformed payload/);
});

test('set-transform: non-number scale throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-transform',
    { id: 1, t: { scaleX: 'big' } }), /malformed payload/);
});

test('set-transform: missing id throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-transform', { t: {} }),
    /malformed payload/);
});

// ---- set-output-margin ------------------------------------------------------

test('set-output-margin: forwards the full margin object', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-output-margin',
    { id: 7, m: { top: 10, right: 5, bottom: 10, left: 5 } });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceOutputMargin', id: 7,
      m: { top: 10, right: 5, bottom: 10, left: 5 } });
});

test('set-output-margin: partial margin (only top) is accepted', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-output-margin', { id: 7, m: { top: 8 } });
  assert.deepEqual(sink.calls[0].m, { top: 8 });
});

test('set-output-margin: negative margin throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-output-margin',
    { id: 1, m: { top: -1 } }), /malformed payload/);
});

test('set-output-margin: non-finite margin throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-output-margin',
    { id: 1, m: { left: NaN } }), /malformed payload/);
});

// ---- set-mask ---------------------------------------------------------------

test('set-mask: forwards GPUTexture stand-in to the sink', () => {
  const { broker, sink } = makeBroker();
  // GPUTexture is an opaque interface; any object passes the structural
  // check in the broker. The real GPU integration test uses a real texture.
  const fakeTexture = { __kind: 'fake-gpu-texture' };
  broker('p', 'windows.set-mask', { id: 7, mask: fakeTexture });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceMask', id: 7, mask: fakeTexture });
});

test('set-mask: null clears the mask', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-mask', { id: 7, mask: null });
  assert.deepEqual(sink.calls[0], { method: 'setSurfaceMask', id: 7, mask: null });
});

test('set-mask: missing id throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-mask', { mask: null }),
    /malformed payload/);
});

test('set-mask: non-object/non-null mask throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-mask', { id: 1, mask: 'oops' }),
    /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-mask', { id: 1, mask: 42 }),
    /malformed payload/);
});

test('set-mask: sink without setSurfaceMask -> not supported', () => {
  const bare = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setSurfaceMask
  };
  const { broker } = makeBroker(bare);
  assert.throws(() => broker('p', 'windows.set-mask', { id: 1, mask: null }),
    /not supported/);
});

// ---- set-tint ---------------------------------------------------------------

test('set-tint: forwards the full tint object', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-tint', { id: 7, t: { r: 0.5, g: 0.6, b: 0.7, a: 0.8 } });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceTint', id: 7, t: { r: 0.5, g: 0.6, b: 0.7, a: 0.8 } });
});

test('set-tint: partial tint (only r) is accepted', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-tint', { id: 7, t: { r: 0 } });
  assert.deepEqual(sink.calls[0].t, { r: 0 });
});

test('set-tint: empty object (identity) is accepted', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-tint', { id: 7, t: {} });
  assert.deepEqual(sink.calls[0].t, {});
});

test('set-tint: non-finite channel throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-tint', { id: 1, t: { r: NaN } }),
    /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-tint', { id: 1, t: { g: Infinity } }),
    /malformed payload/);
});

test('set-tint: non-number channel throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-tint', { id: 1, t: { b: 'dark' } }),
    /malformed payload/);
});

test('set-tint: missing id throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-tint', { t: {} }), /malformed payload/);
});

test('set-tint: sink without setSurfaceTint -> not supported', () => {
  const bare = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setSurfaceTint
  };
  const { broker } = makeBroker(bare);
  assert.throws(() => broker('p', 'windows.set-tint', { id: 1, t: {} }),
    /not supported/);
});

// ---- set-color-matrix -------------------------------------------------------

const IDENTITY_MAT = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

test('set-color-matrix: forwards a 16-number array', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-color-matrix', { id: 7, m: IDENTITY_MAT });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceColorMatrix', id: 7, m: IDENTITY_MAT });
});

test('set-color-matrix: null clears (identity)', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-color-matrix', { id: 7, m: null });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceColorMatrix', id: 7, m: null });
});

test('set-color-matrix: wrong length throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-color-matrix',
    { id: 1, m: [1, 2, 3] }), /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-color-matrix',
    { id: 1, m: new Array(17).fill(0) }), /malformed payload/);
});

test('set-color-matrix: non-array throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-color-matrix',
    { id: 1, m: { 0: 1 } }), /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-color-matrix',
    { id: 1, m: 'identity' }), /malformed payload/);
});

test('set-color-matrix: non-finite entry throws', () => {
  const { broker } = makeBroker();
  const bad = [...IDENTITY_MAT];
  bad[5] = NaN;
  assert.throws(() => broker('p', 'windows.set-color-matrix', { id: 1, m: bad }),
    /malformed payload/);
});

test('set-color-matrix: missing id throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-color-matrix', { m: IDENTITY_MAT }),
    /malformed payload/);
});

test('set-color-matrix: sink without setSurfaceColorMatrix -> not supported', () => {
  const bare = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setSurfaceColorMatrix
  };
  const { broker } = makeBroker(bare);
  assert.throws(() => broker('p', 'windows.set-color-matrix', { id: 1, m: null }),
    /not supported/);
});

// ---- set-backdrop-effect ----------------------------------------------------

test('set-backdrop-effect: forwards kind + params to the sink', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-backdrop-effect',
    { id: 7, e: { kind: 'blur', params: { radius: 24 } } });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceBackdropEffect', id: 7,
      e: { kind: 'blur', params: { radius: 24 } } });
});

test('set-backdrop-effect: params are optional', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-backdrop-effect', { id: 7, e: { kind: 'blur' } });
  assert.deepEqual(sink.calls[0].e, { kind: 'blur' });
});

test('set-backdrop-effect: null clears', () => {
  const { broker, sink } = makeBroker();
  broker('p', 'windows.set-backdrop-effect', { id: 7, e: null });
  assert.deepEqual(sink.calls[0],
    { method: 'setSurfaceBackdropEffect', id: 7, e: null });
});

test('set-backdrop-effect: missing or empty kind throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-backdrop-effect',
    { id: 1, e: {} }), /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-backdrop-effect',
    { id: 1, e: { kind: '' } }), /malformed payload/);
});

test('set-backdrop-effect: non-finite or non-number param throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-backdrop-effect',
    { id: 1, e: { kind: 'blur', params: { radius: NaN } } }), /malformed payload/);
  assert.throws(() => broker('p', 'windows.set-backdrop-effect',
    { id: 1, e: { kind: 'blur', params: { radius: 'big' } } }), /malformed payload/);
});

test('set-backdrop-effect: missing id throws', () => {
  const { broker } = makeBroker();
  assert.throws(() => broker('p', 'windows.set-backdrop-effect',
    { e: { kind: 'blur' } }), /malformed payload/);
});

test('set-backdrop-effect: sink without setSurfaceBackdropEffect -> not supported', () => {
  const bare = {
    setSurfaceLayout() {}, setStack() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    removeSurface() {}, takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; }, afterCurrentFrame() {}, renderFrame() {},
    // no setSurfaceBackdropEffect
  };
  const { broker } = makeBroker(bare);
  assert.throws(() => broker('p', 'windows.set-backdrop-effect', { id: 1, e: null }),
    /not supported/);
});
