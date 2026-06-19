// zwlr_layer_shell_v1.get_layer_surface honors its `output` arg: a NULL or
// unbound resource collapses to the primary outputId, a bound wl_output
// resource resolves to its outputId, and reserved zones are keyed by the
// resolved outputId so a status bar on output 1 doesn't shrink output 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeLayerShell from '../packages/core/dist/protocols/zwlr_layer_shell_v1.js';
import { createReservedZoneRegistry } from '../packages/core/dist/wm/reserved-zones.js';

const LAYER = { background: 0, bottom: 1, top: 2, overlay: 3 };

let sym = 0;
function uniqResource(name) { return { __res: name, __id: ++sym }; }

function mockSink() {
  return {
    setSurfaceLayout() {}, setStack() {},
    commitSurfaceBuffer() { return true; },
    commitSurfaceDmabuf() { return true; },
    removeSurface() {}, takeImportedSurfaces() { return []; }, takeFreedBuffers() { return []; },
    setLayerSurfaces() {},
  };
}

// State with two outputs (0 and 1) and bound wl_output resources.
function mockState() {
  const outputs = new Map();
  outputs.set(0, {
    id: 0,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1000, height: 600 },
    deviceSize: { width: 1000, height: 600 },
    scale: 1, name: "DP-1", description: "DP-1", refreshMhz: 60000,
    transform: 0, physicalWidthMm: 0, physicalHeightMm: 0, make: "x", model: "x",
  });
  outputs.set(1, {
    id: 1,
    logicalPosition: { x: 1000, y: 0 },
    logicalSize: { width: 800, height: 600 },
    deviceSize: { width: 800, height: 600 },
    scale: 1, name: "HDMI-1", description: "HDMI-1", refreshMhz: 60000,
    transform: 0, physicalWidthMm: 0, physicalHeightMm: 0, make: "x", model: "x",
  });
  const wlOutputRes0 = uniqResource("wl_output-0");
  const wlOutputRes1 = uniqResource("wl_output-1");
  const wlOutputResources = new Map();
  wlOutputResources.set(0, new Set([wlOutputRes0]));
  wlOutputResources.set(1, new Set([wlOutputRes1]));

  let serial = 0;
  return {
    state: {
      compositor: mockSink(),
      surfaces: new Map(),
      surfacesById: new Map(),
      nextSerial: 1,
      serial() { return ++serial; },
      layerSurfaces: new Map(),
      layerSurfacesBySurface: new Map(),
      reservedZones: createReservedZoneRegistry(),
      outputs, wlOutputResources,
      wm: {
        state: { outputs: new Map([[0, { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]]), windows: [] },
        primaryOutputId() { return 0; },
      },
      relayout: () => {},
    },
    events: {
      zwlr_layer_surface_v1: {
        send_configure() {}, send_closed() {},
      },
    },
    wlOutputRes0, wlOutputRes1,
  };
}

function newWlSurface(state, id) {
  const r = uniqResource("wl_surface");
  const rec = {
    id, resource: r, role: null,
    pending: {}, committed: { buffer: null },
    xdgSurface: null, layerSurface: null,
  };
  state.surfaces.set(r, rec);
  state.surfacesById.set(id, rec);
  return rec;
}

function bindLayerSurface(ctx, surfaceId, outputResource) {
  const shell = makeLayerShell(ctx);
  const surface = newWlSurface(ctx.state, surfaceId);
  const id = uniqResource("zwlr_layer_surface_v1");
  shell.get_layer_surface(uniqResource("shell"), id, surface.resource,
    outputResource, LAYER.top, "test");
  return ctx.state.layerSurfaces.get(id);
}

test('output=NULL collapses to the primary outputId', () => {
  const ctx = mockState();
  const rec = bindLayerSurface(ctx, 100, null);
  assert.equal(rec.output, 0);
});

test('output=bound wl_output resource resolves to its outputId', () => {
  const ctx = mockState();
  const rec0 = bindLayerSurface(ctx, 100, ctx.wlOutputRes0);
  const rec1 = bindLayerSurface(ctx, 101, ctx.wlOutputRes1);
  assert.equal(rec0.output, 0);
  assert.equal(rec1.output, 1);
});

test('output=unknown resource collapses to the primary', () => {
  const ctx = mockState();
  const rec = bindLayerSurface(ctx, 100, uniqResource("phantom"));
  assert.equal(rec.output, 0);
});

test('reserved zones key on the resolved outputId, NOT the primary', async () => {
  const ctx = mockState();
  // A status bar on output 1 only.
  const rec = bindLayerSurface(ctx, 100, ctx.wlOutputRes1);
  // Set the layer-surface state to anchor TOP with an exclusive zone of 30.
  // Drive it via the protocol commit path: pending -> apply.
  rec.pending = { width: 0, height: 30, anchor: 1, exclusiveZone: 30 };
  const { applyLayerSurfacePending } = await import(
    '../packages/core/dist/protocols/zwlr_layer_shell_v1.js');
  applyLayerSurfacePending(ctx, rec);

  // Output 1 should have a reservation; output 0 should NOT.
  const out0Zones = ctx.state.reservedZones.list(0);
  const out1Zones = ctx.state.reservedZones.list(1);
  assert.equal(out0Zones.length, 0);
  assert.equal(out1Zones.length, 1);
  assert.equal(out1Zones[0].edge, 'top');
  assert.equal(out1Zones[0].thickness, 30);

  // effectiveRect on output 0 still returns the full rect (no reservation
  // bleed across outputs).
  const eff0 = ctx.state.reservedZones.effectiveRect(0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(eff0, { x: 0, y: 0, width: 1000, height: 600 });
  const eff1 = ctx.state.reservedZones.effectiveRect(1, { x: 1000, y: 0, width: 800, height: 600 });
  assert.deepEqual(eff1, { x: 1000, y: 30, width: 800, height: 570 });
});
