// Pure-unit tests for the merged layer-stack push. Two producers (overlay
// broker + zwlr_layer_surface_v1) write into the same compositor non-content
// layers; the rebuild merges them into one ordered push per layer.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rebuildLayerStack,
  protocolLayerToCompositorLayer,
} from "../packages/core/dist/layer-stack.js";

function mockSink() {
  const layers = {};
  return {
    layers,
    setLayerSurfaces(layer, ids) { layers[layer] = [...ids]; },
    setSurfaceLayout() {}, removeSurface() {},
  };
}

function makeLayerSurface(id, layer = "top", mapped = true, destroyed = false) {
  return {
    surface: { id },
    applied: { layer },
    mapped,
    destroyed,
  };
}

function mockState() {
  const compositor = mockSink();
  return {
    compositor,
    layerSurfaces: new Map(),
  };
}

test("protocolLayerToCompositorLayer: protocol bottom maps to compositor below", () => {
  assert.equal(protocolLayerToCompositorLayer("background"), "background");
  assert.equal(protocolLayerToCompositorLayer("bottom"), "below");
  assert.equal(protocolLayerToCompositorLayer("top"), "above");
  assert.equal(protocolLayerToCompositorLayer("overlay"), "overlay");
});

test("rebuildLayerStack: empty state -> empty pushes per layer", () => {
  const s = mockState();
  rebuildLayerStack(s);
  assert.deepEqual(s.compositor.layers, {
    background: [], below: [], above: [], overlay: [],
  });
});

test("rebuildLayerStack: overlay-only -> overlay ids on their layer", () => {
  const s = mockState();
  s.overlayLayerIds = (layer) => layer === "above" ? [100, 101] : [];
  rebuildLayerStack(s);
  assert.deepEqual(s.compositor.layers.above, [100, 101]);
  assert.deepEqual(s.compositor.layers.overlay, []);
});

test("rebuildLayerStack: layer-shell-only -> layer-shell ids on the mapped compositor layer", () => {
  const s = mockState();
  // protocol top -> compositor above
  s.layerSurfaces.set({}, makeLayerSurface(200, "top"));
  s.layerSurfaces.set({}, makeLayerSurface(201, "overlay"));
  rebuildLayerStack(s);
  assert.deepEqual(s.compositor.layers.above, [200]);
  assert.deepEqual(s.compositor.layers.overlay, [201]);
});

test("rebuildLayerStack: both -> overlay ids first, then layer-shell ids", () => {
  const s = mockState();
  s.overlayLayerIds = (layer) => layer === "above" ? [100, 101] : [];
  s.layerSurfaces.set({}, makeLayerSurface(200, "top"));
  s.layerSurfaces.set({}, makeLayerSurface(201, "top"));
  rebuildLayerStack(s);
  assert.deepEqual(s.compositor.layers.above, [100, 101, 200, 201]);
});

test("rebuildLayerStack: skips unmapped + destroyed layer surfaces", () => {
  const s = mockState();
  s.layerSurfaces.set({}, makeLayerSurface(200, "top", true, false));
  s.layerSurfaces.set({}, makeLayerSurface(201, "top", false, false)); // unmapped
  s.layerSurfaces.set({}, makeLayerSurface(202, "top", true, true));   // destroyed
  rebuildLayerStack(s);
  assert.deepEqual(s.compositor.layers.above, [200]);
});

test("rebuildLayerStack: protocol layer mapping (bottom -> below)", () => {
  const s = mockState();
  s.layerSurfaces.set({}, makeLayerSurface(300, "bottom"));
  s.layerSurfaces.set({}, makeLayerSurface(301, "background"));
  rebuildLayerStack(s);
  assert.deepEqual(s.compositor.layers.below, [300]);
  assert.deepEqual(s.compositor.layers.background, [301]);
});

test("rebuildLayerStack(state, layer): only pushes the named layer", () => {
  const s = mockState();
  s.layerSurfaces.set({}, makeLayerSurface(200, "top"));
  s.layerSurfaces.set({}, makeLayerSurface(300, "bottom"));
  rebuildLayerStack(s, "above");
  assert.deepEqual(s.compositor.layers, { above: [200] });
});
