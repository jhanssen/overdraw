// Pure-unit tests for zxdg_decoration_manager_v1 / zxdg_toplevel_decoration_v1.
// The handler is policy-fixed (always server-side) and decoupled from the
// actual decoration drawing (which lives in the per-app_id decoration broker
// in packages/core/src/decorations.ts). These tests pin the wire-level
// handshake: initial configure on get_toplevel_decoration, set_mode reply,
// unset_mode reply, already_constructed silent-drop, destroy releases the
// per-toplevel slot.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeDecorationManager, {
  makeToplevelDecoration,
} from "../packages/core/dist/protocols/zxdg_decoration_manager_v1.js";

// Mode enum values from the protocol.
const MODE_CLIENT_SIDE = 1;
const MODE_SERVER_SIDE = 2;

function mockCtx() {
  const calls = [];
  return {
    addon: { clientId: () => 1 },
    state: {},
    events: {
      zxdg_toplevel_decoration_v1: {
        send_configure(resource, mode) {
          calls.push({ resource, mode });
        },
      },
    },
    _calls: calls,
  };
}

function mockResource(name = "res") {
  return { __resource: name, interfaceName: name, version: 1, destroyed: false };
}

test("get_toplevel_decoration sends an initial configure(server_side)", () => {
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco = mockResource("zxdg_toplevel_decoration_v1");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco, toplevel);
  assert.deepEqual(ctx._calls, [{ resource: deco, mode: MODE_SERVER_SIDE }]);
});

test("get_toplevel_decoration twice on the same toplevel: second is silent-dropped", () => {
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco1 = mockResource("deco1");
  const deco2 = mockResource("deco2");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco1, toplevel);
  mgr.get_toplevel_decoration(mockResource("mgr"), deco2, toplevel);
  // Only deco1 got a configure; deco2 was dropped.
  assert.equal(ctx._calls.length, 1);
  assert.equal(ctx._calls[0].resource, deco1);
});

test("set_mode(client_side): compositor still replies server_side", () => {
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const dec = makeToplevelDecoration(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco = mockResource("deco");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco, toplevel);
  ctx._calls.length = 0; // drop the initial configure
  dec.set_mode(deco, MODE_CLIENT_SIDE);
  assert.deepEqual(ctx._calls, [{ resource: deco, mode: MODE_SERVER_SIDE }]);
});

test("set_mode(server_side): compositor replies server_side", () => {
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const dec = makeToplevelDecoration(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco = mockResource("deco");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco, toplevel);
  ctx._calls.length = 0;
  dec.set_mode(deco, MODE_SERVER_SIDE);
  assert.deepEqual(ctx._calls, [{ resource: deco, mode: MODE_SERVER_SIDE }]);
});

test("set_mode with an invalid enum value: silent-drop reply still server_side", () => {
  // The spec defines invalid_mode (3) for an out-of-range mode arg. The
  // compositor's no-post_error convention applies; the configure still
  // reports the unconditional server-side policy.
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const dec = makeToplevelDecoration(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco = mockResource("deco");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco, toplevel);
  ctx._calls.length = 0;
  dec.set_mode(deco, 99);
  assert.deepEqual(ctx._calls, [{ resource: deco, mode: MODE_SERVER_SIDE }]);
});

test("unset_mode: compositor replies server_side", () => {
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const dec = makeToplevelDecoration(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco = mockResource("deco");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco, toplevel);
  ctx._calls.length = 0;
  dec.unset_mode(deco);
  assert.deepEqual(ctx._calls, [{ resource: deco, mode: MODE_SERVER_SIDE }]);
});

test("destroy releases the toplevel slot: a fresh get_toplevel_decoration is accepted", () => {
  const ctx = mockCtx();
  const mgr = makeDecorationManager(ctx);
  const dec = makeToplevelDecoration(ctx);
  const toplevel = mockResource("xdg_toplevel");
  const deco1 = mockResource("deco1");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco1, toplevel);
  assert.equal(ctx._calls.length, 1);
  // First decoration goes away.
  dec.destroy(deco1);
  // Same toplevel, fresh decoration. Should succeed (not already_constructed).
  const deco2 = mockResource("deco2");
  mgr.get_toplevel_decoration(mockResource("mgr"), deco2, toplevel);
  assert.equal(ctx._calls.length, 2);
  assert.equal(ctx._calls[1].resource, deco2);
  assert.equal(ctx._calls[1].mode, MODE_SERVER_SIDE);
});
