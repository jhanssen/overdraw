// Pure-unit tests for zxdg_output_manager_v1 / zxdg_output_v1. Drives the
// handler factories with a mock ctx and verifies the on-create burst:
// logical_position + logical_size + name + description + done, sourced
// from state.outputs.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeXdgOutputManager from
  "../packages/core/dist/protocols/zxdg_output_manager_v1.js";

function mockCtx(outputRecord) {
  const calls = [];
  return {
    addon: { clientId: () => 1 },
    state: {
      outputs: outputRecord ? new Map([[outputRecord.id, outputRecord]]) : new Map(),
    },
    events: {
      zxdg_output_v1: {
        send_logical_position(resource, x, y) { calls.push(["logical_position", { resource, x, y }]); },
        send_logical_size(resource, w, h) { calls.push(["logical_size", { resource, w, h }]); },
        send_name(resource, name) { calls.push(["name", { resource, name }]); },
        send_description(resource, description) { calls.push(["description", { resource, description }]); },
        send_done(resource) { calls.push(["done", { resource }]); },
      },
    },
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
  };
}

test("get_xdg_output emits the full burst then done", () => {
  const ctx = mockCtx(defaultRecord());
  const mgr = makeXdgOutputManager(ctx);
  const wlOutput = mockResource("wl_output");
  const xdgOutput = mockResource("zxdg_output_v1");
  mgr.get_xdg_output(mockResource("mgr"), xdgOutput, wlOutput);
  const names = ctx._calls.map(([k]) => k);
  assert.deepEqual(names,
    ["logical_position", "logical_size", "name", "description", "done"]);
  // Spot-check the values.
  assert.deepEqual(ctx._calls[0][1], { resource: xdgOutput, x: 0, y: 0 });
  assert.deepEqual(ctx._calls[1][1], { resource: xdgOutput, w: 1920, h: 1080 });
  assert.equal(ctx._calls[2][1].name, "overdraw-0");
  assert.equal(ctx._calls[3][1].description, "overdraw nested output");
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
