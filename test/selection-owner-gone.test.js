// Selection-owner lifecycle, GPU-free: when the source that owns a
// selection slot goes away (explicit destroy OR client disconnect), the
// slot must be relinquished -- X-side claim rescinded via the Xwayland
// bridge hook, data-control observers notified, and the focused client
// re-pushed a null (or X-backed) selection so it drops the dangling
// offer. Previously only the explicit-destroy path cleared the slot, and
// even that skipped the bridge: an owner crash left every paste EOF-ing
// forever and X clients seeing a phantom clipboard owner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  selectionOwnerGone, sweepDataDeviceState, makeDataSource,
} from "../packages/core/dist/protocols/wl_data_device_manager.js";

let nextId = 0;
function res(name, { destroyed = false } = {}) {
  return { __resource: `${name}#${nextId++}`, interfaceName: name, version: 1, destroyed };
}

function makeCtx({ focusClient = 100 } = {}) {
  const sent = [];
  const bridgeCalls = [];
  const busEmits = [];
  const events = {
    wl_data_device: {
      send_data_offer: (device) => {
        const offer = res("wl_data_offer");
        sent.push(["data_offer", { device, offer }]);
        return offer;
      },
      send_offer: () => {},
      send_selection: (device, offer) => sent.push(["selection", { device, offer }]),
    },
    wl_data_offer: { send_offer: (offer, mime) => sent.push(["offer.mime", { offer, mime }]) },
    zwp_primary_selection_device_v1: {
      send_data_offer: (device) => {
        const offer = res("zwp_primary_selection_offer_v1");
        sent.push(["primary.data_offer", { device, offer }]);
        return offer;
      },
      send_selection: (device, offer) => sent.push(["primary.selection", { device, offer }]),
    },
    zwp_primary_selection_offer_v1: { send_offer: () => {} },
    wl_data_source: { send_cancelled: () => {} },
  };
  const ctx = {
    events,
    addon: { clientId: () => focusClient },
    state: {
      selection: null,
      primarySelection: null,
      dataSources: new Map(),
      primarySources: new Map(),
      dataDevices: new Map(),
      primaryDevices: new Map(),
      seat: { kbFocus: focusClient != null ? { clientId: focusClient } : null },
      bus: { emit: (name, payload) => busEmits.push([name, payload]), on: () => {} },
      onWlSelectionChanged: (kind, source, protocol) =>
        bridgeCalls.push([kind, source, protocol]),
    },
  };
  return { ctx, sent, bridgeCalls, busEmits };
}

function addDevice(ctx, clientId) {
  const device = res("wl_data_device");
  let set = ctx.state.dataDevices.get(clientId);
  if (!set) { set = new Set(); ctx.state.dataDevices.set(clientId, set); }
  set.add(device);
  return device;
}

test("selectionOwnerGone clears the slot, notifies the bridge, pushes null to the focused client", () => {
  const { ctx, sent, bridgeCalls, busEmits } = makeCtx();
  const source = res("wl_data_source");
  ctx.state.selection = source;
  addDevice(ctx, 100);

  selectionOwnerGone(ctx, "clipboard");

  assert.equal(ctx.state.selection, null);
  assert.deepEqual(bridgeCalls, [["clipboard", null, "data"]]);
  assert.ok(busEmits.find(([n, p]) => n === "selection.changed" && p.kind === "clipboard"));
  // No wl source and no X source -> selection(null) to the focused client.
  const sel = sent.filter(([k]) => k === "selection");
  assert.equal(sel.length, 1);
  assert.equal(sel[0][1].offer, null);
});

test("explicit wl_data_source.destroy of the owner routes through the owner-gone path", () => {
  const { ctx, bridgeCalls } = makeCtx();
  const source = res("wl_data_source");
  ctx.state.dataSources.set(source, { mimes: ["text/plain"] });
  ctx.state.selection = source;

  makeDataSource(ctx).destroy(source);

  assert.equal(ctx.state.selection, null);
  assert.equal(ctx.state.dataSources.has(source), false);
  assert.deepEqual(bridgeCalls, [["clipboard", null, "data"]]);
});

test("destroy of a non-owner source does not disturb the selection", () => {
  const { ctx, bridgeCalls } = makeCtx();
  const owner = res("wl_data_source");
  const other = res("wl_data_source");
  ctx.state.selection = owner;
  ctx.state.dataSources.set(other, { mimes: [] });

  makeDataSource(ctx).destroy(other);

  assert.equal(ctx.state.selection, owner);
  assert.equal(bridgeCalls.length, 0);
});

test("sweep: a destroyed selection owner (disconnect) is relinquished", () => {
  const { ctx, bridgeCalls } = makeCtx();
  const source = res("wl_data_source", { destroyed: true });
  ctx.state.selection = source;
  ctx.state.dataSources.set(source, { mimes: ["text/plain"] });

  sweepDataDeviceState(ctx);

  assert.equal(ctx.state.selection, null);
  assert.deepEqual(bridgeCalls, [["clipboard", null, "data"]]);
  assert.equal(ctx.state.dataSources.size, 0);
});

test("sweep: a destroyed primary owner is relinquished via the primary path", () => {
  const { ctx, bridgeCalls } = makeCtx();
  const source = res("zwp_primary_selection_source_v1", { destroyed: true });
  ctx.state.primarySelection = source;

  sweepDataDeviceState(ctx);

  assert.equal(ctx.state.primarySelection, null);
  assert.deepEqual(bridgeCalls, [["primary", null, "primary"]]);
});

test("sweep prunes destroyed devices and drops empty client entries", () => {
  const { ctx } = makeCtx();
  const live = addDevice(ctx, 100);
  const dead = addDevice(ctx, 100);
  dead.destroyed = true;
  const deadOnly = addDevice(ctx, 200);
  deadOnly.destroyed = true;

  sweepDataDeviceState(ctx);

  assert.deepEqual([...ctx.state.dataDevices.get(100)], [live]);
  assert.equal(ctx.state.dataDevices.has(200), false);
});

test("sweep with live owner and live devices is a no-op", () => {
  const { ctx, sent, bridgeCalls } = makeCtx();
  const source = res("wl_data_source");
  ctx.state.selection = source;
  ctx.state.dataSources.set(source, { mimes: [] });
  addDevice(ctx, 100);

  sweepDataDeviceState(ctx);

  assert.equal(ctx.state.selection, source);
  assert.equal(sent.length, 0);
  assert.equal(bridgeCalls.length, 0);
});
