// Pure-unit tests for wl_output: bind emits the full burst sourced from
// state.outputs, and reemitWlOutput resends the burst to every bound
// resource (the slice-3b output-reconfigure path).

import { test } from "node:test";
import assert from "node:assert/strict";

import makeOutput, { reemitWlOutput } from
  "../packages/core/dist/protocols/wl_output.js";

function mockCtx(outputRecord) {
  const calls = [];
  const events = {
    wl_output: {
      send_geometry(resource, x, y, pw, ph, sub, make, model, transform) {
        calls.push(["geometry", { resource, x, y, pw, ph, sub, make, model, transform }]);
      },
      send_mode(resource, flags, w, h, refresh) {
        calls.push(["mode", { resource, flags, w, h, refresh }]);
      },
      send_scale(resource, factor) { calls.push(["scale", { resource, factor }]); },
      send_name(resource, name) { calls.push(["name", { resource, name }]); },
      send_description(resource, desc) { calls.push(["description", { resource, desc }]); },
      send_done(resource) { calls.push(["done", { resource }]); },
    },
  };
  return {
    addon: { clientId: () => 1 },
    state: {
      outputs: outputRecord ? new Map([[outputRecord.id, outputRecord]]) : new Map(),
      events,
    },
    events,
    _calls: calls,
  };
}

function mockResource(name = "res") {
  return { __resource: name, interfaceName: name, version: 4, destroyed: false };
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

test("bind emits the full burst then done", () => {
  const ctx = mockCtx(defaultRecord());
  const handler = makeOutput(ctx);
  handler.bind(mockResource("wl_output"));
  const kinds = ctx._calls.map(([k]) => k);
  assert.deepEqual(kinds,
    ["geometry", "mode", "scale", "name", "description", "done"]);
});

test("bind sources values from the current OutputRecord", () => {
  const ctx = mockCtx({
    id: 0,
    logicalPosition: { x: 10, y: 20 },
    logicalSize: { width: 2560, height: 1440 },
    scale: 2,
    name: "DP-1",
    description: "Dell U2718Q",
    refreshMhz: 144000,
    transform: 1,  // 90 degrees
    physicalWidthMm: 600,
    physicalHeightMm: 340,
    make: "Dell",
    model: "U2718Q",
  });
  const handler = makeOutput(ctx);
  handler.bind(mockResource("wl_output"));
  const byKind = new Map(ctx._calls);
  const g = byKind.get("geometry");
  assert.equal(g.x, 10);
  assert.equal(g.y, 20);
  assert.equal(g.pw, 600);
  assert.equal(g.ph, 340);
  assert.equal(g.make, "Dell");
  assert.equal(g.model, "U2718Q");
  assert.equal(g.transform, 1);
  const m = byKind.get("mode");
  assert.equal(m.w, 2560);
  assert.equal(m.h, 1440);
  assert.equal(m.refresh, 144000);
  assert.equal(byKind.get("scale").factor, 2);
  assert.equal(byKind.get("name").name, "DP-1");
  assert.equal(byKind.get("description").desc, "Dell U2718Q");
});

test("bind falls back when state.outputs is empty (defensive)", () => {
  // GPU-free harness that skipped seeding the registry: bind must still
  // emit something (clients like foot abort with no wl_output present).
  const ctx = mockCtx(null);
  const handler = makeOutput(ctx);
  handler.bind(mockResource("wl_output"));
  const kinds = ctx._calls.map(([k]) => k);
  assert.deepEqual(kinds,
    ["geometry", "mode", "scale", "name", "description", "done"]);
});

test("reemitWlOutput resends the full burst to every bound resource", () => {
  const ctx = mockCtx(defaultRecord());
  const handler = makeOutput(ctx);
  const a = mockResource("wl_output-a");
  const b = mockResource("wl_output-b");
  handler.bind(a);
  handler.bind(b);
  // Each bind sent 6 events = 12 total. Clear and re-emit.
  ctx._calls.length = 0;
  // Simulate a reconfigure: mutate the record in place (what main.ts does).
  const rec = ctx.state.outputs.get(0);
  rec.logicalSize = { width: 2400, height: 1300 };
  rec.refreshMhz = 120000;
  reemitWlOutput(ctx.state, 0);
  // Both resources see the burst again.
  const kinds = ctx._calls.map(([k]) => k);
  assert.deepEqual(kinds,
    ["geometry", "mode", "scale", "name", "description", "done",
     "geometry", "mode", "scale", "name", "description", "done"]);
  const modes = ctx._calls.filter(([k]) => k === "mode").map(([, v]) => v);
  assert.deepEqual(modes, [
    { resource: a, flags: 0x3, w: 2400, h: 1300, refresh: 120000 },
    { resource: b, flags: 0x3, w: 2400, h: 1300, refresh: 120000 },
  ]);
});

test("reemitWlOutput skips destroyed resources and lazily prunes them", () => {
  const ctx = mockCtx(defaultRecord());
  const handler = makeOutput(ctx);
  const a = mockResource("wl_output-a");
  const b = mockResource("wl_output-b");
  handler.bind(a);
  handler.bind(b);
  ctx._calls.length = 0;
  a.destroyed = true;
  reemitWlOutput(ctx.state, 0);
  const kinds = ctx._calls.map(([k]) => k);
  assert.equal(kinds.length, 6);
  assert.equal(ctx._calls[0][1].resource, b);
  // A second re-emit should still only target b.
  ctx._calls.length = 0;
  reemitWlOutput(ctx.state, 0);
  assert.equal(ctx._calls.length, 6);
  assert.equal(ctx._calls[0][1].resource, b);
});

test("release drops the resource from tracking (no later re-emit to it)", () => {
  const ctx = mockCtx(defaultRecord());
  const handler = makeOutput(ctx);
  const a = mockResource("wl_output-a");
  const b = mockResource("wl_output-b");
  handler.bind(a);
  handler.bind(b);
  handler.release(a);
  ctx._calls.length = 0;
  reemitWlOutput(ctx.state, 0);
  assert.equal(ctx._calls.length, 6);
  assert.equal(ctx._calls[0][1].resource, b);
});

test("reemitWlOutput is a no-op when no resources are bound", () => {
  const ctx = mockCtx(defaultRecord());
  reemitWlOutput(ctx.state, 0);
  assert.deepEqual(ctx._calls, []);
});

test("reemitWlOutput is a no-op when state.events is missing", () => {
  const ctx = mockCtx(defaultRecord());
  const handler = makeOutput(ctx);
  handler.bind(mockResource("wl_output"));
  ctx._calls.length = 0;
  ctx.state.events = undefined;
  reemitWlOutput(ctx.state, 0);
  assert.deepEqual(ctx._calls, []);
});
