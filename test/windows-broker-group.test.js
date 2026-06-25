// Pure-unit tests for the windows-broker's group-aware setTransform /
// setOpacity / setTint / setColorMatrix handlers. The broker resolves
// a window id to the set of surfaces visually belonging to the
// window (content + decoration + subsurface subtree) and applies the
// value to each member surface. Non-WM ids (phantoms, layer surfaces,
// etc.) fall back to single-surface application.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWindowsBroker, NOT_HANDLED,
} from '../packages/core/dist/plugins/windows-broker.js';

function mockSink() {
  const calls = {
    transform: [], opacity: [], tint: [], colorMatrix: [],
    mask: [], shape: [],
  };
  return {
    calls,
    setSurfaceTransform(id, t) { calls.transform.push({ id, t }); },
    setSurfaceOpacity(id, a) { calls.opacity.push({ id, a }); },
    setSurfaceTint(id, t) { calls.tint.push({ id, t }); },
    setSurfaceColorMatrix(id, m) { calls.colorMatrix.push({ id, m }); },
    setSurfaceMask(id, m) { calls.mask.push({ id, m }); },
    setSurfaceShape(id, s) { calls.shape.push({ id, s }); },
    setSurfaceOutputMargin() {},
    // unused-but-required sink methods.
    setSurfaceLayout() {}, setStack() {},
    removeSurface() {}, setLayerSurfaces() {},
    setSurfaceTexture() {}, commitSurfaceBuffer() {}, commitSurfaceDmabuf() {},
    takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; },
    afterCurrentFrame() {}, renderFrame() {},
  };
}

// Build a mock CompositorState with a WM that knows windows + decoration
// + subsurface tree exactly the way the real one does. `windows` is
// [{ surfaceId, decorationSurfaceId?, subsurfaceIds? }]; subsurfaces
// are turned into the state.subsurfaces Map keyed by Resource (we use
// a string-keyed mock Resource so the Map's identity works).
function mockState({ windows = [] } = {}) {
  // Mock Resource = a small object referenced by identity.
  const surfaceResources = new Map();   // surfaceId -> Resource
  const makeRes = (id) => {
    if (!surfaceResources.has(id)) {
      surfaceResources.set(id, { __id: id });
    }
    return surfaceResources.get(id);
  };

  const surfacesById = new Map();
  const surfaces = new Map();
  const subsurfaces = new Map();
  const wmWindows = [];

  for (const w of windows) {
    // Toplevel surface record.
    const tlRes = makeRes(w.surfaceId);
    const rec = { id: w.surfaceId, resource: tlRes, role: 'xdg_toplevel' };
    surfacesById.set(w.surfaceId, rec);
    surfaces.set(tlRes, rec);
    wmWindows.push({
      surfaceId: w.surfaceId,
      decorationSurfaceId: w.decorationSurfaceId,
    });
    if (w.decorationSurfaceId !== undefined) {
      const decoRes = makeRes(w.decorationSurfaceId);
      const decoRec = { id: w.decorationSurfaceId, resource: decoRes, role: 'decoration' };
      surfacesById.set(w.decorationSurfaceId, decoRec);
      surfaces.set(decoRes, decoRec);
    }
    // Subsurfaces (flat list; each is a direct child of the toplevel
    // for simplicity). The collectSubsurfaceIds walker recurses
    // through state.subsurfaces.
    for (const subId of (w.subsurfaceIds ?? [])) {
      const subRes = makeRes(subId);
      const subRec = { id: subId, resource: subRes, role: 'wl_subsurface' };
      surfacesById.set(subId, subRec);
      surfaces.set(subRes, subRec);
      subsurfaces.set(subRes, {
        surface: subRes,
        parent: tlRes,
      });
    }
  }

  const compositor = mockSink();
  const state = {
    wm: {
      state: { windows: wmWindows },
      isContentGated: () => false,
    },
    surfaces,
    surfacesById,
    subsurfaces,
  };
  // Stub the remaining broker deps not exercised by these tests.
  const broker = createWindowsBroker({
    wm: {
      ...state.wm,
      // The broker uses wm.* for a bunch of things we don't exercise;
      // just stub them to avoid Reference errors at handler-routing
      // time.
      propose: async () => null,
      setState: () => false,
      getState: () => undefined,
      deleteState: () => false,
      getStateAll: () => ({}),
      getSnapshot: () => null,
      listSnapshots: () => [],
      raiseWindow: () => {},
      windowAt: () => null,
      setContentGated: () => {},
      engageContentGate: () => {},
      releaseContentGate: () => {},
    },
    compositor,
    state,
    pluginBus: { emit: () => {}, subscribe: () => () => {} },
    bus: { emit: () => {}, on: () => () => {} },
  });
  return { broker, compositor, state };
}

// ---- setTransform: group expansion ---------------------------------------

test('setTransform on a window id applies to content + decoration', () => {
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10, decorationSurfaceId: 11 }],
  });
  const t = { translateX: 100, translateY: 0, scaleX: 1, scaleY: 1 };
  broker('test', 'windows.set-transform', { id: 10, t });
  // Both surfaces received the same transform, decoration first per
  // resolveWindowGroup's order (matches computeBaseStack draw order).
  assert.equal(compositor.calls.transform.length, 2);
  assert.deepEqual(compositor.calls.transform[0], { id: 11, t });
  assert.deepEqual(compositor.calls.transform[1], { id: 10, t });
});

test('setTransform on a window id applies to subsurfaces too', () => {
  const { broker, compositor } = mockState({
    windows: [{
      surfaceId: 10,
      decorationSurfaceId: 11,
      subsurfaceIds: [20, 21, 22],
    }],
  });
  const t = { translateX: 50, translateY: 25, scaleX: 1, scaleY: 1 };
  broker('test', 'windows.set-transform', { id: 10, t });
  // 1 decoration + 1 content + 3 subsurfaces = 5 calls, same t each.
  assert.equal(compositor.calls.transform.length, 5);
  // Decoration first, then content, then subsurfaces.
  const ids = compositor.calls.transform.map((c) => c.id);
  assert.deepEqual(ids, [11, 10, 20, 21, 22]);
  for (const call of compositor.calls.transform) {
    assert.deepEqual(call.t, t);
  }
});

test('setTransform on a non-WM id: single-surface fallback', () => {
  // Empty WM: id=999 is not a managed window. Phantom-style use.
  const { broker, compositor } = mockState({ windows: [] });
  broker('test', 'windows.set-transform',
    { id: 999, t: { translateX: 10, translateY: 0, scaleX: 1, scaleY: 1 } });
  assert.equal(compositor.calls.transform.length, 1);
  assert.equal(compositor.calls.transform[0].id, 999);
});

test('setTransform on a window without decoration or subsurfaces: just content', () => {
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10 }],
  });
  broker('test', 'windows.set-transform',
    { id: 10, t: { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 } });
  assert.equal(compositor.calls.transform.length, 1);
  assert.equal(compositor.calls.transform[0].id, 10);
});

// ---- setOpacity: group expansion ----------------------------------------

test('setOpacity on a window id applies to content + decoration', () => {
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10, decorationSurfaceId: 11 }],
  });
  broker('test', 'windows.set-opacity', { id: 10, opacity: 0.5 });
  assert.equal(compositor.calls.opacity.length, 2);
  assert.deepEqual(compositor.calls.opacity.map((c) => c.id), [11, 10]);
  for (const call of compositor.calls.opacity) {
    assert.equal(call.a, 0.5);
  }
});

// ---- setTint: group expansion -------------------------------------------

test('setTint on a window id applies to content + decoration', () => {
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10, decorationSurfaceId: 11 }],
  });
  const tint = { r: 0.8, g: 0.8, b: 0.8, a: 1 };
  broker('test', 'windows.set-tint', { id: 10, t: tint });
  assert.equal(compositor.calls.tint.length, 2);
  assert.deepEqual(compositor.calls.tint.map((c) => c.id), [11, 10]);
});

// ---- setColorMatrix: group expansion ------------------------------------

test('setColorMatrix on a window id applies to content + decoration', () => {
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10, decorationSurfaceId: 11 }],
  });
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  broker('test', 'windows.set-color-matrix', { id: 10, m });
  assert.equal(compositor.calls.colorMatrix.length, 2);
  assert.deepEqual(compositor.calls.colorMatrix.map((c) => c.id), [11, 10]);
});

// ---- setMask / setShape: per-surface (not group-aware) ------------------

test('setShape on a window id applies ONLY to the content surface', () => {
  // Shapes are inherently per-surface: the decoration uses an outer
  // shape and the content uses an inset inner shape; applying the
  // same shape to both would break the decoration plugin.
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10, decorationSurfaceId: 11 }],
  });
  broker('test', 'windows.set-shape',
    { id: 10, shape: { kind: 'rounded-rect', radius: 8 } });
  assert.equal(compositor.calls.shape.length, 1);
  assert.equal(compositor.calls.shape[0].id, 10);
});

test('setMask on a window id applies ONLY to the content surface', () => {
  const { broker, compositor } = mockState({
    windows: [{ surfaceId: 10, decorationSurfaceId: 11 }],
  });
  broker('test', 'windows.set-mask', { id: 10, mask: null });
  assert.equal(compositor.calls.mask.length, 1);
  assert.equal(compositor.calls.mask[0].id, 10);
});

// ---- non-windows.* methods fall through -------------------------------

test('broker returns NOT_HANDLED for non-windows.* methods', () => {
  const { broker } = mockState({ windows: [] });
  const r = broker('test', 'something.else', {});
  assert.equal(r, NOT_HANDLED);
});
