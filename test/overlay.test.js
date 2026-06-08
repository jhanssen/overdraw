// Pure-unit tests for overlay geometry (placeOverlay) and the overlay broker
// (createOverlayBroker). No GPU/Wayland: a mock sink records setSurfaceLayout /
// setLayerSurfaces / removeSurface. Covers anchor placement + output clamping,
// and the broker's layer registration / destroy / reflow.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeOverlay } from '../packages/core/dist/overlay-position.js';
import { createOverlayBroker } from '../packages/core/dist/overlay.js';

const OUT = { width: 1000, height: 800 };

test('placeOverlay: corner/edge/center anchors', () => {
  const sz = { width: 100, height: 50 };
  assert.deepEqual(placeOverlay({ anchor: 'top-left', ...sz }, OUT), { x: 0, y: 0, width: 100, height: 50 });
  assert.deepEqual(placeOverlay({ anchor: 'top-right', ...sz }, OUT), { x: 900, y: 0, width: 100, height: 50 });
  assert.deepEqual(placeOverlay({ anchor: 'bottom-right', ...sz }, OUT), { x: 900, y: 750, width: 100, height: 50 });
  assert.deepEqual(placeOverlay({ anchor: 'bottom-left', ...sz }, OUT), { x: 0, y: 750, width: 100, height: 50 });
  assert.deepEqual(placeOverlay({ anchor: 'center', ...sz }, OUT), { x: 450, y: 375, width: 100, height: 50 });
  assert.deepEqual(placeOverlay({ anchor: 'top', ...sz }, OUT), { x: 450, y: 0, width: 100, height: 50 });
  assert.deepEqual(placeOverlay({ anchor: 'right', ...sz }, OUT), { x: 900, y: 375, width: 100, height: 50 });
});

test('placeOverlay: margin insets the anchored edges', () => {
  assert.deepEqual(placeOverlay({ anchor: 'top-right', width: 100, height: 50, margin: 10 }, OUT),
    { x: 890, y: 10, width: 100, height: 50 });
});

test('placeOverlay: size clamps to the output, origin stays on-screen', () => {
  const r = placeOverlay({ anchor: 'top-left', width: 5000, height: 5000 }, OUT);
  assert.deepEqual(r, { x: 0, y: 0, width: 1000, height: 800 });
});

// Mock sink: records the broker's calls.
function mockSink() {
  const calls = { layout: [], layers: {}, removed: [] };
  return {
    setSurfaceLayout(id, x, y, w, h) { calls.layout.push({ id, x, y, w, h }); },
    setLayerSurfaces(layer, ids) { calls.layers[layer] = [...ids]; },
    removeSurface(id) { calls.removed.push(id); },
    _calls: calls,
  };
}

// Minimal CompositorState for the broker: a monotonic serial() + the sink.
function mockState() {
  let n = 0;
  const compositor = mockSink();
  return { serial: () => ++n, compositor };
}

test('broker.create: decides rect, places in layer, returns handle', () => {
  const state = mockState();
  const broker = createOverlayBroker(state, OUT);
  const h = broker.create('panel', { layer: 'overlay', anchor: 'top-right', width: 200, height: 40, margin: 8 });

  assert.equal(h.layer, 'overlay');
  assert.deepEqual(h.rect, { x: 792, y: 8, width: 200, height: 40 });
  assert.equal(typeof h.surfaceId, 'number');
  // Geometry pushed; surface registered in the overlay layer.
  assert.deepEqual(state.compositor._calls.layout.at(-1),
    { id: h.surfaceId, x: 792, y: 8, w: 200, h: 40 });
  assert.deepEqual(state.compositor._calls.layers.overlay, [h.surfaceId]);
});

test('broker: multiple overlays in a layer keep insertion order', () => {
  const state = mockState();
  const broker = createOverlayBroker(state, OUT);
  const a = broker.create('p', { layer: 'above', anchor: 'top-left', width: 10, height: 10 });
  const b = broker.create('p', { layer: 'above', anchor: 'top', width: 10, height: 10 });
  assert.deepEqual(state.compositor._calls.layers.above, [a.surfaceId, b.surfaceId]);
});

test('broker.destroy: removes surface + re-pushes the layer', () => {
  const state = mockState();
  const broker = createOverlayBroker(state, OUT);
  const a = broker.create('p', { layer: 'above', anchor: 'top-left', width: 10, height: 10 });
  const b = broker.create('p', { layer: 'above', anchor: 'top', width: 10, height: 10 });
  broker.destroy(a.surfaceId);
  assert.deepEqual(state.compositor._calls.removed, [a.surfaceId]);
  assert.deepEqual(state.compositor._calls.layers.above, [b.surfaceId]);
  assert.deepEqual(broker.list().map((o) => o.surfaceId), [b.surfaceId]);
});

test('broker.destroyForPlugin: removes all of one plugin, re-pushes affected layers', () => {
  const state = mockState();
  const broker = createOverlayBroker(state, OUT);
  const a = broker.create('panel', { layer: 'overlay', anchor: 'top-left', width: 10, height: 10 });
  broker.create('panel', { layer: 'above', anchor: 'top', width: 10, height: 10 });
  const c = broker.create('other', { layer: 'overlay', anchor: 'bottom', width: 10, height: 10 });
  broker.destroyForPlugin('panel');
  assert.deepEqual(broker.list().map((o) => o.surfaceId), [c.surfaceId]);
  assert.deepEqual(state.compositor._calls.layers.overlay, [c.surfaceId]);
  assert.deepEqual(state.compositor._calls.layers.above, []);
  assert.ok(state.compositor._calls.removed.includes(a.surfaceId));
});

test('broker.reflow: recomputes rects against a new output size', () => {
  const state = mockState();
  const broker = createOverlayBroker(state, OUT);
  const h = broker.create('p', { layer: 'overlay', anchor: 'bottom-right', width: 100, height: 50 });
  assert.deepEqual(h.rect, { x: 900, y: 750, width: 100, height: 50 });
  broker.reflow({ width: 500, height: 400 });
  assert.deepEqual(broker.list()[0].rect, { x: 400, y: 350, width: 100, height: 50 });
});
