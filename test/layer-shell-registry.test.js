// Pure-unit tests for the zwlr_layer_surface_v1 registry + state machine.
// Constructs the handler factories directly with a mocked Ctx (no real
// trampoline / Wayland server) and drives them through the configure
// handshake, double-buffered state apply, reserved-zone interaction, and
// destroy / unmap teardown.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeLayerShell, {
  makeLayerSurface,
  applyLayerSurfaceInitial,
  applyLayerSurfacePending,
  markLayerSurfaceMapped,
  teardownLayerSurface,
  isLayerSurfaceInitialCommit,
} from "../packages/core/dist/protocols/zwlr_layer_shell_v1.js";
import { createReservedZoneRegistry } from "../packages/core/dist/wm/reserved-zones.js";

// Anchor bits from the protocol enum.
const A = { top: 1, bottom: 2, left: 4, right: 8 };
const KBI = { none: 0, exclusive: 1, on_demand: 2 };
const LAYER = { background: 0, bottom: 1, top: 2, overlay: 3 };

function mockSink() {
  return {
    layouts: [],
    layers: {},
    setSurfaceLayout(id, x, y, w, h) { this.layouts.push({ id, x, y, w, h }); },
    setLayerSurfaces(layer, ids) { this.layers[layer] = [...ids]; },
    removeSurface() {},
    takeImportedSurfaces() { return []; },
    takeFreedBuffers() { return []; },
  };
}

function mockResource(name = "res") {
  const r = { __resource: name, interfaceName: name, version: 5, destroyed: false };
  return r;
}

function mockState(opts = {}) {
  let n = 0;
  const compositor = mockSink();
  // Seed both `outputs` (the per-output record map the layer-shell handler
  // reads logical dims from) and a WM-like stub with primaryOutputId / outputs.
  const outputs = new Map([[0, {
    id: 0,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1000, height: 600 },
    deviceSize: { width: 1000, height: 600 },
    scale: 1,
    name: "test-0", description: "test", refreshMhz: 60000,
    transform: 0, physicalWidthMm: 0, physicalHeightMm: 0,
    make: "test", model: "test",
  }]]);
  const state = {
    compositor,
    surfaces: new Map(),
    surfacesById: new Map(),
    nextSerial: 1,
    serial() { return ++n; },
    layerSurfaces: new Map(),
    layerSurfacesBySurface: new Map(),
    reservedZones: opts.withReservedZones ? createReservedZoneRegistry() : undefined,
    outputs,
    wm: {
      state: {
        outputs: new Map([[0, { id: 0, rect: { x: 0, y: 0, width: 1000, height: 600 }, scale: 1 }]]),
        windows: [],
      },
      primaryOutputId() { return 0; },
    },
    relayoutCalls: [],
  };
  state.relayout = (reason) => state.relayoutCalls.push(reason);
  return state;
}

function configureCalls(events) {
  return events.zwlr_layer_surface_v1.calls;
}

function mockCtx(opts = {}) {
  const state = mockState(opts);
  const events = {
    zwlr_layer_surface_v1: {
      calls: [],
      send_configure(resource, serial, w, h) {
        this.calls.push({ resource, serial, w, h });
      },
      send_closed(resource) { this.calls.push({ resource, closed: true }); },
    },
  };
  return { state, events, addon: { clientId: () => 1 } };
}

// Helper: create a wl_surface record in state.
function newWlSurface(state, id) {
  const r = mockResource("wl_surface");
  const rec = {
    id, resource: r, role: null,
    pending: {}, committed: { buffer: null },
    xdgSurface: null, layerSurface: null,
  };
  state.surfaces.set(r, rec);
  state.surfacesById.set(id, rec);
  return rec;
}

// Helper: simulate the get_layer_surface request, returning the LayerSurfaceRecord.
function createLayerSurface(ctx, surfaceId, layer = "top", namespace = "test") {
  const shell = makeLayerShell(ctx);
  const surface = newWlSurface(ctx.state, surfaceId);
  const id = mockResource("zwlr_layer_surface_v1");
  shell.get_layer_surface(mockResource("shell"), id, surface.resource, null,
    layer === "top" ? LAYER.top : layer === "overlay" ? LAYER.overlay
      : layer === "bottom" ? LAYER.bottom : LAYER.background,
    namespace);
  return { surfaceRecord: surface, layerSurface: ctx.state.layerSurfaces.get(id), resource: id };
}

// ---- get_layer_surface ---------------------------------------------------

test("get_layer_surface creates a LayerSurfaceRecord with deferred first configure", () => {
  const ctx = mockCtx();
  const { layerSurface, surfaceRecord } = createLayerSurface(ctx, 100);
  assert.ok(layerSurface);
  assert.equal(layerSurface.lastConfigureSerial, null,
    "first configure is deferred to initial commit");
  assert.equal(layerSurface.mapped, false);
  assert.equal(surfaceRecord.role, "layer_surface");
  assert.equal(surfaceRecord.layerSurface, layerSurface);
  // Registry contains the record.
  assert.equal(ctx.state.layerSurfaces.size, 1);
  assert.equal(ctx.state.layerSurfacesBySurface.size, 1);
});

test("get_layer_surface drops the request when the wl_surface already has a role", () => {
  const ctx = mockCtx();
  const shell = makeLayerShell(ctx);
  const surface = newWlSurface(ctx.state, 100);
  surface.role = "xdg_toplevel"; // already roled
  shell.get_layer_surface(mockResource("shell"), mockResource("ls"), surface.resource, null,
    LAYER.top, "test");
  // Silent drop: no record created (no post_error path).
  assert.equal(ctx.state.layerSurfaces.size, 0);
  assert.equal(surface.role, "xdg_toplevel"); // unchanged
});

test("get_layer_surface drops the request when the wl_surface has a committed buffer", () => {
  const ctx = mockCtx();
  const shell = makeLayerShell(ctx);
  const surface = newWlSurface(ctx.state, 100);
  surface.hasContent = true;
  shell.get_layer_surface(mockResource("shell"), mockResource("ls"), surface.resource, null,
    LAYER.top, "test");
  assert.equal(ctx.state.layerSurfaces.size, 0);
});

test("get_layer_surface drops the request when layer is out of range", () => {
  const ctx = mockCtx();
  const shell = makeLayerShell(ctx);
  const surface = newWlSurface(ctx.state, 100);
  shell.get_layer_surface(mockResource("shell"), mockResource("ls"), surface.resource, null,
    99 /* invalid */, "test");
  assert.equal(ctx.state.layerSurfaces.size, 0);
});

// ---- double-buffered state -----------------------------------------------

test("set_size / set_anchor / set_margin accumulate in pending before commit", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_margin(resource, 0, 5, 0, 10);
  // Applied state is still the default until commit.
  assert.deepEqual(layerSurface.applied.margin, { top: 0, right: 0, bottom: 0, left: 0 });
  assert.equal(layerSurface.applied.anchor, 0);
  // Pending carries the proposed values.
  assert.equal(layerSurface.pending.width, 0);
  assert.equal(layerSurface.pending.height, 30);
  assert.equal(layerSurface.pending.anchor, A.top | A.left | A.right);
  assert.deepEqual(layerSurface.pending.margin, { top: 0, right: 5, bottom: 0, left: 10 });
});

test("set_anchor with invalid bitfield bits is silently dropped (no post_error path)", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_anchor(resource, 0xFF); // bits above 0xF invalid
  assert.equal(layerSurface.pending.anchor, undefined, "invalid anchor was not accepted");
});

test("set_keyboard_interactivity out of range is dropped", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_keyboard_interactivity(resource, 99);
  assert.equal(layerSurface.pending.keyboardInteractivity, undefined);
});

// ---- configure handshake ------------------------------------------------

test("initial commit sends a sized configure, records the serial", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_exclusive_zone(resource, 30);

  // Drive the initial-commit path (the wl_surface.commit hook does this).
  assert.equal(isLayerSurfaceInitialCommit(layerSurface), true);
  applyLayerSurfaceInitial(ctx, layerSurface);

  const calls = configureCalls(ctx.events);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].w, 1000); // width spans top edge
  assert.equal(calls[0].h, 30);
  assert.equal(layerSurface.lastConfigureSerial, calls[0].serial);
  assert.equal(layerSurface.acked, false);
  // Applied state now reflects the pending merge.
  assert.equal(layerSurface.applied.anchor, A.top | A.left | A.right);
  assert.equal(layerSurface.applied.exclusiveZone, 30);
});

test("ack_configure with matching serial sets acked=true", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  applyLayerSurfaceInitial(ctx, layerSurface);
  const serial = layerSurface.lastConfigureSerial;
  ls.ack_configure(resource, serial);
  assert.equal(layerSurface.acked, true);
});

test("ack_configure with stale serial is ignored", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  applyLayerSurfaceInitial(ctx, layerSurface);
  ls.ack_configure(resource, 999);
  assert.equal(layerSurface.acked, false);
});

test("apply after first configure: same size -> no new configure", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  applyLayerSurfaceInitial(ctx, layerSurface);
  const before = configureCalls(ctx.events).length;
  // Subsequent commit with no pending change should not send a configure.
  applyLayerSurfacePending(ctx, layerSurface);
  assert.equal(configureCalls(ctx.events).length, before);
});

test("apply after first configure: size change -> new configure", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  applyLayerSurfaceInitial(ctx, layerSurface);
  // Now change the height; the next apply should send a fresh configure.
  ls.set_size(resource, 0, 40);
  applyLayerSurfacePending(ctx, layerSurface);
  const calls = configureCalls(ctx.events);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].h, 40);
});

// ---- reserved-zone registration -----------------------------------------

test("zone > 0 with a valid edge registers a reservation", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_exclusive_zone(resource, 30);
  applyLayerSurfaceInitial(ctx, layerSurface);
  const eff = ctx.state.reservedZones.effectiveRect(0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(eff, { x: 0, y: 30, width: 1000, height: 570 });
});

test("zone <= 0 does not register a reservation", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_exclusive_zone(resource, 0);
  applyLayerSurfaceInitial(ctx, layerSurface);
  const eff = ctx.state.reservedZones.effectiveRect(0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(eff, { x: 0, y: 0, width: 1000, height: 600 });
});

test("corner anchor with no explicit exclusive edge: zone has no reservation effect", () => {
  // top + left without set_exclusive_edge -> ambiguous; zone treated as 0.
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 100, 100);
  ls.set_anchor(resource, A.top | A.left);
  ls.set_exclusive_zone(resource, 30);
  applyLayerSurfaceInitial(ctx, layerSurface);
  const eff = ctx.state.reservedZones.effectiveRect(0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(eff, { x: 0, y: 0, width: 1000, height: 600 });
});

test("destroying a layer surface clears its reservation", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_exclusive_zone(resource, 30);
  applyLayerSurfaceInitial(ctx, layerSurface);
  // Before destroy: zone is in effect.
  let eff = ctx.state.reservedZones.effectiveRect(0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.equal(eff.y, 30);
  // Destroy.
  ls.destroy(resource);
  eff = ctx.state.reservedZones.effectiveRect(0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(eff, { x: 0, y: 0, width: 1000, height: 600 });
  // Record gone from both registries.
  assert.equal(ctx.state.layerSurfaces.size, 0);
  assert.equal(ctx.state.layerSurfacesBySurface.size, 0);
});

test("apply triggers state.relayout('reserved-zones-changed')", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_exclusive_zone(resource, 30);
  applyLayerSurfaceInitial(ctx, layerSurface);
  assert.ok(ctx.state.relayoutCalls.includes("reserved-zones-changed"));
});

// ---- mapping (layer-stack push) -----------------------------------------

test("markLayerSurfaceMapped pushes the surface into the layer stack", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100, "top");
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  applyLayerSurfaceInitial(ctx, layerSurface);
  markLayerSurfaceMapped(ctx.state, layerSurface);
  // protocol top -> compositor above
  assert.deepEqual(ctx.state.compositor.layers.above, [100]);
});

// ---- zone-mode interaction (multi-surface reflow) -----------------------

test("two surfaces: zone>0 reserves; zone==0 sibling re-places against effective rect", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);

  // First: a 30px top panel reserving its zone.
  const { layerSurface: panel, resource: panelRes } = createLayerSurface(ctx, 100);
  ls.set_size(panelRes, 0, 30);
  ls.set_anchor(panelRes, A.top | A.left | A.right);
  ls.set_exclusive_zone(panelRes, 30);
  applyLayerSurfaceInitial(ctx, panel);
  markLayerSurfaceMapped(ctx.state, panel);

  // Second: a notification anchored top with zone==0 -> placed below the panel.
  const { layerSurface: notif, resource: notifRes } = createLayerSurface(ctx, 200);
  ls.set_size(notifRes, 300, 40);
  ls.set_anchor(notifRes, A.top);
  ls.set_exclusive_zone(notifRes, 0);
  applyLayerSurfaceInitial(ctx, notif);

  assert.equal(notif.rect.y, 30, "notification placed below the panel's reservation");
});

test("re-applying a reserving surface excludes only its own reservation", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);

  // A 30px top panel reserving its zone.
  const { layerSurface: panel, resource: panelRes } = createLayerSurface(ctx, 100);
  ls.set_size(panelRes, 0, 30);
  ls.set_anchor(panelRes, A.top | A.left | A.right);
  ls.set_exclusive_zone(panelRes, 30);
  applyLayerSurfaceInitial(ctx, panel);
  assert.equal(panel.rect.y, 0);

  // A 20px bottom dock reserving its own zone.
  const { layerSurface: dock, resource: dockRes } = createLayerSurface(ctx, 200);
  ls.set_size(dockRes, 0, 20);
  ls.set_anchor(dockRes, A.bottom | A.left | A.right);
  ls.set_exclusive_zone(dockRes, 20);
  applyLayerSurfaceInitial(ctx, dock);

  // Re-apply the panel while its own zone is registered: it must not be
  // displaced by its own 30px reservation, but the dock's still applies
  // to the height available to a stretch-anchored surface.
  ls.set_size(panelRes, 0, 32);
  ls.set_exclusive_zone(panelRes, 32);
  applyLayerSurfacePending(ctx, panel);
  assert.equal(panel.rect.y, 0, "panel not pushed down by its own zone");
  assert.equal(panel.rect.width, 1000, "panel spans the full output width");

  // The temporary drop-compute-restore left the panel's zone registered:
  // the effective rect still reflects both reservations.
  const eff = ctx.state.reservedZones.effectiveRect(
    0, { x: 0, y: 0, width: 1000, height: 600 });
  assert.deepEqual(eff, { x: 0, y: 32, width: 1000, height: 548 });
});

test("destroying the panel reflows the notification back up", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);

  const { layerSurface: panel, resource: panelRes } = createLayerSurface(ctx, 100);
  ls.set_size(panelRes, 0, 30);
  ls.set_anchor(panelRes, A.top | A.left | A.right);
  ls.set_exclusive_zone(panelRes, 30);
  applyLayerSurfaceInitial(ctx, panel);

  const { layerSurface: notif, resource: notifRes } = createLayerSurface(ctx, 200);
  ls.set_size(notifRes, 300, 40);
  ls.set_anchor(notifRes, A.top);
  ls.set_exclusive_zone(notifRes, 0);
  applyLayerSurfaceInitial(ctx, notif);
  assert.equal(notif.rect.y, 30);

  // Destroy the panel; notif's effective rect now allows y=0.
  ls.destroy(panelRes);
  assert.equal(notif.rect.y, 0);
});

// ---- isLayerSurfaceInitialCommit helper ---------------------------------

test("isLayerSurfaceInitialCommit: true before first apply, false after", () => {
  const ctx = mockCtx();
  const ls = makeLayerSurface(ctx);
  const { layerSurface } = createLayerSurface(ctx, 100);
  assert.equal(isLayerSurfaceInitialCommit(layerSurface), true);
  applyLayerSurfaceInitial(ctx, layerSurface);
  assert.equal(isLayerSurfaceInitialCommit(layerSurface), false);
});

// ---- teardown idempotence -----------------------------------------------

test("teardownLayerSurface is idempotent", () => {
  const ctx = mockCtx({ withReservedZones: true });
  const ls = makeLayerSurface(ctx);
  const { layerSurface, resource } = createLayerSurface(ctx, 100);
  ls.set_size(resource, 0, 30);
  ls.set_anchor(resource, A.top | A.left | A.right);
  ls.set_exclusive_zone(resource, 30);
  applyLayerSurfaceInitial(ctx, layerSurface);
  teardownLayerSurface(ctx.state, layerSurface);
  // Second call is a no-op.
  teardownLayerSurface(ctx.state, layerSurface);
  assert.equal(ctx.state.layerSurfaces.size, 0);
});
