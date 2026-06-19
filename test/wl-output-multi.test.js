// makeOutputForOutput: per-output bind handler binds the right output's
// burst, and the same handler routes a wl_output resource to the right
// outputId in the tracked-resources reverse map.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeOutputForOutput, reemitWlOutput } from
  '../packages/core/dist/protocols/wl_output.js';

function mockCtx(records) {
  const calls = [];
  const events = {
    wl_output: {
      send_geometry(r, x, y, pw, ph, sub, make, model, transform) {
        calls.push(["geometry", { r, x, y, make, model, transform }]);
      },
      send_mode(r, flags, w, h, refresh) { calls.push(["mode", { r, w, h, refresh }]); },
      send_scale(r, factor) { calls.push(["scale", { r, factor }]); },
      send_name(r, name) { calls.push(["name", { r, name }]); },
      send_description(r, desc) { calls.push(["description", { r, desc }]); },
      send_done(r) { calls.push(["done", { r }]); },
    },
  };
  const outputs = new Map();
  for (const rec of records) outputs.set(rec.id, rec);
  return {
    ctx: { state: { outputs, events }, events, addon: { clientId: () => 1 } },
    state: { outputs, events },
    calls,
  };
}

function makeRec(id, name, x) {
  return {
    id, name, description: `${name} display`,
    logicalPosition: { x, y: 0 },
    logicalSize: { width: 1000, height: 600 },
    deviceSize: { width: 1000, height: 600 },
    scale: 1, refreshMhz: 60000, transform: 0,
    physicalWidthMm: 600, physicalHeightMm: 340,
    make: "test", model: name,
  };
}

function mockResource(id) {
  return { __resource: id, interfaceName: "wl_output", version: 4, destroyed: false };
}

test('makeOutputForOutput: bind emits the matching outputId burst', () => {
  const { ctx, calls } = mockCtx([makeRec(0, "DP-1", 0), makeRec(1, "HDMI-1", 1000)]);
  const h0 = makeOutputForOutput(ctx, 0);
  const h1 = makeOutputForOutput(ctx, 1);
  const r0 = mockResource("r0");
  const r1 = mockResource("r1");
  h0.bind(r0);
  h1.bind(r1);
  // Output 0 burst -> r0; output 1 burst -> r1.
  const r0Calls = calls.filter((c) => c[1].r === r0);
  const r1Calls = calls.filter((c) => c[1].r === r1);
  assert.equal(r0Calls.find((c) => c[0] === "name")[1].name, "DP-1");
  assert.equal(r1Calls.find((c) => c[0] === "name")[1].name, "HDMI-1");
  assert.equal(r0Calls.find((c) => c[0] === "geometry")[1].x, 0);
  assert.equal(r1Calls.find((c) => c[0] === "geometry")[1].x, 1000);
});

test('makeOutputForOutput: bind tracks the resource against the right outputId', () => {
  const { ctx, state } = mockCtx([makeRec(0, "DP-1", 0), makeRec(1, "HDMI-1", 1000)]);
  const h0 = makeOutputForOutput(ctx, 0);
  const h1 = makeOutputForOutput(ctx, 1);
  const r0 = mockResource("r0");
  const r1 = mockResource("r1");
  h0.bind(r0);
  h1.bind(r1);
  // wlOutputResources is populated by outputId: state-scoped, set by bind.
  assert.ok(state.outputs);
  // state.wlOutputResources is the addon's side; mocked ctx doesn't seed it,
  // but the handler creates it on-demand.
  const wlOR = ctx.state.wlOutputResources;
  assert.ok(wlOR);
  assert.ok(wlOR.get(0).has(r0));
  assert.ok(wlOR.get(1).has(r1));
  assert.equal(wlOR.get(0).has(r1), false);
});

test('reemitWlOutput: per-outputId; output 0 reemit does not hit output 1 resources', () => {
  const { ctx, state, calls } = mockCtx([makeRec(0, "DP-1", 0), makeRec(1, "HDMI-1", 1000)]);
  const h0 = makeOutputForOutput(ctx, 0);
  const h1 = makeOutputForOutput(ctx, 1);
  const r0 = mockResource("r0");
  const r1 = mockResource("r1");
  h0.bind(r0);
  h1.bind(r1);
  calls.length = 0;
  reemitWlOutput(state, 0);
  // Only r0 sees events.
  for (const c of calls) assert.equal(c[1].r, r0);
});

test('makeOutputForOutput: release on the per-output handler scrubs only its outputId', () => {
  const { ctx } = mockCtx([makeRec(0, "DP-1", 0), makeRec(1, "HDMI-1", 1000)]);
  const h0 = makeOutputForOutput(ctx, 0);
  const h1 = makeOutputForOutput(ctx, 1);
  const r0 = mockResource("r0");
  const r1 = mockResource("r1");
  h0.bind(r0);
  h1.bind(r1);
  h0.release(r0);
  const wlOR = ctx.state.wlOutputResources;
  assert.equal(wlOR.get(0).has(r0), false);
  assert.equal(wlOR.get(1).has(r1), true);
});
