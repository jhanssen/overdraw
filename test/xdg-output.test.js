// Pure-unit tests for zxdg_output_manager_v1 / zxdg_output_v1. Drives the
// handler factories with a mock ctx and verifies the on-create burst:
// logical_position + logical_size + name + description + done, sourced
// from state.outputs.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeXdgOutputManager, { reemitXdgOutput } from
  "../packages/core/dist/protocols/zxdg_output_manager_v1.js";

function mockCtx(outputRecord) {
  const calls = [];
  const events = {
    zxdg_output_v1: {
      send_logical_position(resource, x, y) { calls.push(["logical_position", { resource, x, y }]); },
      send_logical_size(resource, w, h) { calls.push(["logical_size", { resource, w, h }]); },
      send_name(resource, name) { calls.push(["name", { resource, name }]); },
      send_description(resource, description) { calls.push(["description", { resource, description }]); },
      send_done(resource) { calls.push(["done", { resource }]); },
    },
    wl_output: {
      // get_xdg_output re-sends wl_output.done after the xdg_output burst so
      // GTK <= 4.22 recomputes the monitor scale with a valid logical size.
      send_done(resource) { calls.push(["wl_output_done", { resource }]); },
    },
  };
  return {
    addon: { clientId: () => 1 },
    state: {
      outputs: outputRecord ? new Map([[outputRecord.id, outputRecord]]) : new Map(),
      // reemitXdgOutput reads from state.events; the ctx already has events,
      // but reemit takes state directly so we stash a reference there too.
      events,
    },
    events,
    _calls: calls,
  };
}

function mockResource(name = "res") {
  return { __resource: name, interfaceName: name, version: 3, destroyed: false };
}

function defaultRecord() {
  return {
    id: 0,
    logicalPosition: { x: 0, y: 0 },
    logicalSize: { width: 1920, height: 1080 },
    scale: 1,
    name: "overdraw-0",
    description: "overdraw nested output",
    refreshMhz: 60000,
    transform: 0,
    physicalWidthMm: 0,
    physicalHeightMm: 0,
    make: "overdraw",
    model: "overdraw nested output",
  };
}

test("get_xdg_output emits the full burst then done", () => {
  const ctx = mockCtx(defaultRecord());
  const mgr = makeXdgOutputManager(ctx);
  const wlOutput = mockResource("wl_output");
  const xdgOutput = mockResource("zxdg_output_v1");
  mgr.get_xdg_output(mockResource("mgr"), xdgOutput, wlOutput);
  const names = ctx._calls.map(([k]) => k);
  // The xdg_output burst, then a re-sent wl_output.done (so GTK <= 4.22
  // recomputes the monitor scale now that the logical size has arrived).
  assert.deepEqual(names,
    ["logical_position", "logical_size", "name", "description", "done", "wl_output_done"]);
  // Spot-check the values.
  assert.deepEqual(ctx._calls[0][1], { resource: xdgOutput, x: 0, y: 0 });
  assert.deepEqual(ctx._calls[1][1], { resource: xdgOutput, w: 1920, h: 1080 });
  assert.equal(ctx._calls[2][1].name, "overdraw-0");
  assert.equal(ctx._calls[3][1].description, "overdraw nested output");
  // The trailing wl_output.done targets the wl_output, not the xdg_output.
  assert.deepEqual(ctx._calls[5][1], { resource: wlOutput });
});

test("get_xdg_output reads the current OutputRecord values", () => {
  // A custom record (simulating a later reconfiguration) drives the emitted
  // values: the handler is a translator, not a snapshot.
  const ctx = mockCtx({
    id: 0,
    logicalPosition: { x: 100, y: 200 },
    logicalSize: { width: 2560, height: 1440 },
    scale: 1,
    name: "DP-1",
    description: "Dell U2718Q",
    refreshMhz: 144000,
    transform: 0,
    physicalWidthMm: 600,
    physicalHeightMm: 340,
    make: "Dell",
    model: "U2718Q",
  });
  const mgr = makeXdgOutputManager(ctx);
  mgr.get_xdg_output(mockResource("mgr"), mockResource("xdg"), mockResource("wl_output"));
  const byKind = new Map(ctx._calls);
  assert.equal(byKind.get("logical_position").x, 100);
  assert.equal(byKind.get("logical_position").y, 200);
  assert.equal(byKind.get("logical_size").w, 2560);
  assert.equal(byKind.get("logical_size").h, 1440);
  assert.equal(byKind.get("name").name, "DP-1");
  assert.equal(byKind.get("description").description, "Dell U2718Q");
});

test("get_xdg_output silently drops when no OUTPUT_DEFAULT entry is registered", () => {
  // Defensive: state.outputs absent (e.g. a half-built test fixture).
  const ctx = mockCtx(null);
  const mgr = makeXdgOutputManager(ctx);
  mgr.get_xdg_output(mockResource("mgr"), mockResource("xdg"), mockResource("wl_output"));
  assert.deepEqual(ctx._calls, []);
});

test("manager destroy is accepted", () => {
  const ctx = mockCtx(defaultRecord());
  const mgr = makeXdgOutputManager(ctx);
  // destructor: trampoline normally tears down the resource. We just
  // check the handler shape accepts the call without throwing.
  mgr.destroy(mockResource("mgr"));
});

test("reemitXdgOutput re-sends the full burst to every bound resource", () => {
  const ctx = mockCtx(defaultRecord());
  const mgr = makeXdgOutputManager(ctx);
  const a = mockResource("xdg-a");
  const b = mockResource("xdg-b");
  mgr.get_xdg_output(mockResource("mgr"), a, mockResource("wl_output-a"));
  mgr.get_xdg_output(mockResource("mgr"), b, mockResource("wl_output-b"));
  // Bind sent 5 events per resource = 10 events. Clear and re-emit.
  ctx._calls.length = 0;
  // Simulate a reconfiguration: mutate the OutputRecord in place (this is
  // what main.ts's onOutputDescriptor handler does).
  const rec = ctx.state.outputs.get(0);
  rec.logicalSize = { width: 2400, height: 1300 };
  rec.scale = 2;
  reemitXdgOutput(ctx.state, 0);
  // Both resources should receive the burst again (5 events each).
  const kinds = ctx._calls.map(([k]) => k);
  assert.deepEqual(kinds,
    ["logical_position", "logical_size", "name", "description", "done",
     "logical_position", "logical_size", "name", "description", "done"]);
  // Both saw the NEW logical_size.
  const sizes = ctx._calls.filter(([k]) => k === "logical_size").map(([, v]) => v);
  assert.deepEqual(sizes, [
    { resource: a, w: 2400, h: 1300 },
    { resource: b, w: 2400, h: 1300 },
  ]);
});

test("reemitXdgOutput skips destroyed resources and removes them from tracking", () => {
  const ctx = mockCtx(defaultRecord());
  const mgr = makeXdgOutputManager(ctx);
  const a = mockResource("xdg-a");
  const b = mockResource("xdg-b");
  mgr.get_xdg_output(mockResource("mgr"), a, mockResource("wl_output-a"));
  mgr.get_xdg_output(mockResource("mgr"), b, mockResource("wl_output-b"));
  ctx._calls.length = 0;
  // Mark `a` destroyed (client disconnect / explicit destroy).
  a.destroyed = true;
  reemitXdgOutput(ctx.state, 0);
  // Only b should receive the burst (5 events).
  const kinds = ctx._calls.map(([k]) => k);
  assert.deepEqual(kinds,
    ["logical_position", "logical_size", "name", "description", "done"]);
  assert.equal(ctx._calls[0][1].resource, b);
  // A second re-emit (with no further changes) should still only target b;
  // the prior re-emit's lazy scrub cleared a from the tracking set.
  ctx._calls.length = 0;
  reemitXdgOutput(ctx.state, 0);
  const kinds2 = ctx._calls.map(([k]) => k);
  assert.equal(kinds2.length, 5);
  assert.equal(ctx._calls[0][1].resource, b);
});

test("reemitXdgOutput is a no-op when no resources are bound", () => {
  const ctx = mockCtx(defaultRecord());
  // No get_xdg_output calls => empty tracking set.
  reemitXdgOutput(ctx.state, 0);
  assert.deepEqual(ctx._calls, []);
});

test("reemitXdgOutput is a no-op when state.events is missing", () => {
  const ctx = mockCtx(defaultRecord());
  const mgr = makeXdgOutputManager(ctx);
  mgr.get_xdg_output(mockResource("mgr"), mockResource("xdg"), mockResource("wl_output"));
  ctx._calls.length = 0;
  // Simulate mid-bring-up: events not yet attached.
  ctx.state.events = undefined;
  reemitXdgOutput(ctx.state, 0);
  assert.deepEqual(ctx._calls, []);
});
