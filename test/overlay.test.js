// Pure-unit tests for overlay geometry (placeOverlay) and the overlay broker
// (createOverlayBroker). No GPU/Wayland: a mock sink records setSurfaceLayout /
// setLayerSurfaces / removeSurface. Covers anchor placement + output clamping,
// global-coordinate placement on a target output, the broker's layer
// registration / destroy / reflow, and the output hotplug hooks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeOverlay } from '../packages/core/dist/overlay-position.js';
import { createOverlayBroker, installOverlayOutputHooks } from '../packages/core/dist/overlay.js';
import { DynamicBus } from '../packages/core/dist/events/dynamic-bus.js';

const OUT = { width: 1000, height: 800 };

// Minimal OutputRecord: just the fields the broker's geometry lookup reads.
function outRec(id, x, y, width, height) {
  return { id, logicalPosition: { x, y }, logicalSize: { width, height } };
}

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

test('placeOverlay: output origin offsets the rect into global space', () => {
  assert.deepEqual(
    placeOverlay({ anchor: 'top-left', width: 100, height: 50 }, { x: 1920, y: 100, width: 1000, height: 800 }),
    { x: 1920, y: 100, width: 100, height: 50 });
});

test('broker.reflow: recomputes rects against the output\'s current geometry', () => {
  const state = mockState();
  const broker = createOverlayBroker(state, OUT);
  const h = broker.create('p', { layer: 'overlay', anchor: 'bottom-right', width: 100, height: 50 });
  assert.deepEqual(h.rect, { x: 900, y: 750, width: 100, height: 50 });
  state.outputs = new Map([[0, outRec(0, 0, 0, 500, 400)]]);
  broker.reflow();
  assert.deepEqual(broker.list()[0].rect, { x: 400, y: 350, width: 100, height: 50 });
});

test('broker.create: output option places in that output\'s global rect', () => {
  const state = mockState();
  state.outputs = new Map([
    [0, outRec(0, 0, 0, 1000, 800)],
    [1, outRec(1, 1000, 0, 600, 400)],
  ]);
  const broker = createOverlayBroker(state, OUT);
  const a = broker.create('p', { layer: 'background', anchor: 'top-left', width: 600, height: 400, output: 1 });
  assert.equal(a.outputId, 1);
  assert.deepEqual(a.rect, { x: 1000, y: 0, width: 600, height: 400 });
  // Default output = primary (lowest id).
  const b = broker.create('p', { layer: 'background', anchor: 'top-left', width: 10, height: 10 });
  assert.equal(b.outputId, 0);
  assert.deepEqual(b.rect, { x: 0, y: 0, width: 10, height: 10 });
});

test('output hooks: pre-remove destroys that output\'s overlays; changed reflows survivors', () => {
  const state = mockState();
  state.outputs = new Map([
    [0, outRec(0, 0, 0, 1000, 800)],
    [1, outRec(1, 1000, 0, 600, 400)],
  ]);
  const broker = createOverlayBroker(state, OUT);
  const bus = new DynamicBus();
  installOverlayOutputHooks(bus, broker);

  const a = broker.create('p', { layer: 'background', anchor: 'top-left', width: 600, height: 400, output: 1 });
  const b = broker.create('p', { layer: 'background', anchor: 'top-right', width: 100, height: 50, output: 0 });

  bus.emit('output.pre-remove', { outputId: 1 });
  assert.deepEqual(broker.list().map((o) => o.surfaceId), [b.surfaceId]);
  assert.ok(state.compositor._calls.removed.includes(a.surfaceId));
  assert.deepEqual(state.compositor._calls.layers.background, [b.surfaceId]);

  // Output 0 grows; the survivor re-anchors on output.changed.
  state.outputs.set(0, outRec(0, 0, 0, 1920, 1080));
  state.outputs.delete(1);
  bus.emit('output.changed', { outputId: 0 });
  assert.deepEqual(broker.list()[0].rect, { x: 1820, y: 0, width: 100, height: 50 });
});
