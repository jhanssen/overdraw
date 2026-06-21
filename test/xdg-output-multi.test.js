// zxdg_output_manager_v1: get_xdg_output resolves the `output` arg to its
// real OutputRecord by reverse-walking state.wlOutputResources. The emitted
// logical_position/logical_size reflect the bound output's values, not the
// primary's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import makeXdgOutputManager from
  '../packages/core/dist/protocols/zxdg_output_manager_v1.js';

function mockResource(name, version = 2) {
  return { __resource: name, interfaceName: name, version, destroyed: false };
}

function makeRec(id, name, x, w, h) {
  return {
    id, name, description: `${name} display`,
    logicalPosition: { x, y: 0 },
    logicalSize: { width: w, height: h },
    deviceSize: { width: w, height: h },
    scale: 1, refreshMhz: 60000, transform: 0,
    physicalWidthMm: 600, physicalHeightMm: 340,
    make: "test", model: name,
  };
}

function mockCtx(records) {
  const calls = [];
  const events = {
    zxdg_output_v1: {
      send_logical_position(r, x, y) { calls.push(["pos", { r, x, y }]); },
      send_logical_size(r, w, h) { calls.push(["size", { r, w, h }]); },
      send_name(r, name) { calls.push(["name", { r, name }]); },
      send_description(r, desc) { calls.push(["desc", { r, desc }]); },
      send_done(r) { calls.push(["done", { r }]); },
    },
    wl_output: { send_done(r) { calls.push(["wl_done", { r }]); } },
  };
  // Seed wlOutputResources so the handler's reverse walk resolves the
  // wl_output resource to the right outputId.
  const wlOutputResources = new Map();
  const outputs = new Map();
  for (const rec of records) {
    outputs.set(rec.id, rec);
    wlOutputResources.set(rec.id, new Set([rec.wlOutputResource]));
  }
  const state = { outputs, wlOutputResources, events };
  return { ctx: { state, events }, calls };
}

test('get_xdg_output: emits the bound output\'s logical_position/size, not the primary\'s', () => {
  const rec0 = { ...makeRec(0, "DP-1", 0, 1000, 600), wlOutputResource: mockResource("wl_output-0") };
  const rec1 = { ...makeRec(1, "HDMI-1", 1000, 800, 600), wlOutputResource: mockResource("wl_output-1") };
  const { ctx, calls } = mockCtx([rec0, rec1]);
  const mgr = makeXdgOutputManager(ctx);
  const xo = mockResource("zxdg_output_v1");
  mgr.get_xdg_output(null, xo, rec1.wlOutputResource);
  const pos = calls.find((c) => c[0] === "pos");
  const size = calls.find((c) => c[0] === "size");
  const name = calls.find((c) => c[0] === "name");
  assert.equal(pos[1].x, 1000);
  assert.equal(pos[1].y, 0);
  assert.equal(size[1].w, 800);
  assert.equal(size[1].h, 600);
  assert.equal(name[1].name, "HDMI-1");
});

test('get_xdg_output: emits in order pos, size, name, desc, done', () => {
  const rec0 = { ...makeRec(0, "DP-1", 0, 1000, 600), wlOutputResource: mockResource("wl_output-0") };
  const { ctx, calls } = mockCtx([rec0]);
  const mgr = makeXdgOutputManager(ctx);
  mgr.get_xdg_output(null, mockResource("zxdg_output_v1"), rec0.wlOutputResource);
  const kinds = calls.map((c) => c[0]);
  // wl_done is re-emitted on the wl_output after the xdg_output burst (per
  // the existing GTK<=4.22 workaround).
  assert.deepEqual(kinds, ["pos", "size", "name", "desc", "done", "wl_done"]);
});

test('get_xdg_output: unknown wl_output resource falls back to the primary', () => {
  const rec0 = { ...makeRec(0, "DP-1", 0, 1000, 600), wlOutputResource: mockResource("wl_output-0") };
  const rec1 = { ...makeRec(1, "HDMI-1", 1000, 800, 600), wlOutputResource: mockResource("wl_output-1") };
  const { ctx, calls } = mockCtx([rec0, rec1]);
  const mgr = makeXdgOutputManager(ctx);
  const stranger = mockResource("stranger");
  mgr.get_xdg_output(null, mockResource("zxdg_output_v1"), stranger);
  // Resolves to the primary (lowest id = 0).
  const name = calls.find((c) => c[0] === "name");
  assert.equal(name[1].name, "DP-1");
});
