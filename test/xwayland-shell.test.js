// Pure-unit tests for xwayland_shell_v1 / xwayland_surface_v1: role assignment,
// serial registration + lookup (the join the native XWM uses), and the error
// paths (role / invalid_serial / already_associated). No xcb, no GPU.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeXwaylandShell, { makeXwaylandSurface }
  from "../packages/core/dist/protocols/xwayland_shell_v1.js";
import { lookupBySerial, dropSerialsForSurface }
  from "../packages/core/dist/xwayland/surface.js";

function makeCtx() {
  const errorCalls = [];
  const surfaces = new Map();
  const ctx = {
    state: { surfaces },
    events: {},
    addon: {
      postError: (_resource, code, msg) => errorCalls.push([code, msg]),
      clientId: (_resource) => 1,
    },
  };
  return { ctx, errorCalls, surfaces };
}

function addSurface(surfaces, resource, id, role = null) {
  const rec = { id, resource, role, pending: {}, committed: {} };
  surfaces.set(resource, rec);
  return rec;
}

test("get_xwayland_surface assigns the xwayland role", () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const shell = makeXwaylandShell(ctx);
  const wlSurface = { id: 1 };
  const rec = addSurface(surfaces, wlSurface, 7);
  shell.get_xwayland_surface({ id: 9 }, { id: 2 }, wlSurface);
  assert.equal(rec.role, "xwayland");
  assert.equal(errorCalls.length, 0);
});

test("get_xwayland_surface on an already-roled surface posts role error (0)", () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const shell = makeXwaylandShell(ctx);
  const wlSurface = { id: 1 };
  const rec = addSurface(surfaces, wlSurface, 7, "xdg_toplevel");
  shell.get_xwayland_surface({ id: 9 }, { id: 2 }, wlSurface);
  assert.equal(rec.role, "xdg_toplevel", "role unchanged");
  assert.deepEqual(errorCalls.map((c) => c[0]), [0]);
});

test("set_serial registers a serial -> wl_surface lookup", () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const shell = makeXwaylandShell(ctx);
  const surf = makeXwaylandSurface(ctx);
  const wlSurface = { id: 1 };
  addSurface(surfaces, wlSurface, 42);
  const xs = { id: 2 };
  shell.get_xwayland_surface({ id: 9 }, xs, wlSurface);
  surf.set_serial(xs, 0xdeadbeef, 0x1234);  // lo, hi
  const serial = (0x1234n << 32n) | 0xdeadbeefn;
  assert.equal(lookupBySerial(ctx.state, serial), 42);
  assert.equal(lookupBySerial(ctx.state, 999n), null, "unknown serial -> null");
  assert.equal(errorCalls.length, 0);
});

test("set_serial(0) posts invalid_serial (1)", () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const shell = makeXwaylandShell(ctx);
  const surf = makeXwaylandSurface(ctx);
  const wlSurface = { id: 1 };
  addSurface(surfaces, wlSurface, 42);
  const xs = { id: 2 };
  shell.get_xwayland_surface({ id: 9 }, xs, wlSurface);
  surf.set_serial(xs, 0, 0);
  assert.deepEqual(errorCalls.map((c) => c[0]), [1]);
});

test("set_serial twice posts already_associated (0)", () => {
  const { ctx, errorCalls, surfaces } = makeCtx();
  const shell = makeXwaylandShell(ctx);
  const surf = makeXwaylandSurface(ctx);
  const wlSurface = { id: 1 };
  addSurface(surfaces, wlSurface, 42);
  const xs = { id: 2 };
  shell.get_xwayland_surface({ id: 9 }, xs, wlSurface);
  surf.set_serial(xs, 1, 0);
  errorCalls.length = 0;
  surf.set_serial(xs, 2, 0);
  assert.deepEqual(errorCalls.map((c) => c[0]), [0]);  // already_associated == 0
});

test("dropSerialsForSurface evicts a torn-down surface's serials; others survive", () => {
  const { ctx, surfaces } = makeCtx();
  const shell = makeXwaylandShell(ctx);
  const surf = makeXwaylandSurface(ctx);
  const wlA = { id: 1 }, wlB = { id: 2 };
  addSurface(surfaces, wlA, 42);
  addSurface(surfaces, wlB, 43);
  const xsA = { id: 3 }, xsB = { id: 4 };
  shell.get_xwayland_surface({ id: 9 }, xsA, wlA);
  shell.get_xwayland_surface({ id: 9 }, xsB, wlB);
  surf.set_serial(xsA, 100, 0);
  surf.set_serial(xsB, 200, 0);
  assert.equal(lookupBySerial(ctx.state, 100n), 42);

  dropSerialsForSurface(ctx.state, 42);
  assert.equal(lookupBySerial(ctx.state, 100n), null, "torn-down surface's serial evicted");
  assert.equal(lookupBySerial(ctx.state, 200n), 43, "other surface's serial survives");
  assert.equal(ctx.state.xwayland.bySerial.size, 1);
});
