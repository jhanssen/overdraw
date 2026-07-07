// Destroyed-surface guards on the seat's leave paths, GPU-free.
//
// A leave event whose surface argument is a destroyed resource puts a
// stale (already-deleted) object id on the wire -- a fatal protocol error
// for the receiving client (this killed Xwayland in production). Two
// defenses are pinned here:
//
//   1. sendKbLeave / sendLeave skip the wire send when the cached focus
//      record's surface resource is destroyed (the disconnect case, where
//      no teardown ran and only the per-frame sweep would catch it);
//   2. unmapAndTeardownSurface invalidates seat focus synchronously via
//      clearFocusForSurface, so the explicit-destroy case never leaves a
//      stale record live until the next frame.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeSeat from "../packages/core/dist/protocols/wl_seat.js";
import { unmapAndTeardownSurface } from "../packages/core/dist/protocols/wl_surface.js";

let nextId = 0;
function res(name) {
  return { __resource: `${name}#${nextId++}`, interfaceName: name, version: 1, destroyed: false };
}

function makeCtx() {
  const sent = [];
  const spy = (kind) => (...args) => sent.push([kind, args]);
  const events = {
    wl_seat: { send_capabilities: spy("seat.capabilities"), send_name: spy("seat.name") },
    wl_keyboard: {
      send_enter: spy("kb.enter"), send_leave: spy("kb.leave"),
      send_keymap: spy("kb.keymap"), send_repeat_info: spy("kb.repeat_info"),
      send_modifiers: spy("kb.modifiers"), send_key: spy("kb.key"),
    },
    wl_pointer: {
      send_enter: spy("p.enter"), send_leave: spy("p.leave"),
      send_motion: spy("p.motion"), send_button: spy("p.button"),
      send_frame: spy("p.frame"), send_axis: spy("p.axis"),
    },
  };
  let serial = 1;
  const ctx = {
    events,
    addon: { clientId: () => 100, keymapInfo: () => null },
    state: {
      serial: () => serial++,
      surfaces: new Map(),
      surfacesById: new Map(),
      wm: { getSnapshot: (id) => ({ rect: { x: 0, y: 0, width: 100, height: 100 } }) },
      compositor: {},
    },
  };
  return { ctx, sent };
}

const noopDriver = { dispatch() {}, settled: async () => {} };

function addSurface(ctx, id) {
  const resource = res("wl_surface");
  const rec = { id, resource, mapped: false, unmapped: false, layerSurface: null };
  ctx.state.surfaces.set(resource, rec);
  ctx.state.surfacesById.set(id, rec);
  return rec;
}

function setup() {
  const { ctx, sent } = makeCtx();
  const handler = makeSeat(ctx, noopDriver);
  const seat = ctx.state.seat;
  const kb = res("wl_keyboard");
  handler.get_keyboard(res("wl_seat"), kb);
  const p = res("wl_pointer");
  handler.get_pointer(res("wl_seat"), p);
  return { ctx, sent, seat, kb, p };
}

// ---- keyboard leave -----------------------------------------------------

test("kb focus change away from a live surface sends leave", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  addSurface(s.ctx, 2);
  s.seat.applyKeyboardFocus(1);
  s.sent.length = 0;
  s.seat.applyKeyboardFocus(2);
  const leaves = s.sent.filter(([k]) => k === "kb.leave");
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0][1][2], a.resource);
  assert.equal(s.sent.filter(([k]) => k === "kb.enter").length, 1);
});

test("kb focus change away from a DESTROYED surface suppresses leave, still enters the new one", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  addSurface(s.ctx, 2);
  s.seat.applyKeyboardFocus(1);
  // Disconnect case: resource destroyed with no teardown; the cached
  // kbFocus record still points at it.
  a.resource.destroyed = true;
  s.sent.length = 0;
  s.seat.applyKeyboardFocus(2);
  assert.equal(s.sent.filter(([k]) => k === "kb.leave").length, 0);
  assert.equal(s.sent.filter(([k]) => k === "kb.enter").length, 1);
});

test("kb focus cleared to null over a destroyed surface suppresses leave", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  s.seat.applyKeyboardFocus(1);
  a.resource.destroyed = true;
  s.sent.length = 0;
  s.seat.applyKeyboardFocus(null);
  assert.equal(s.sent.filter(([k]) => k === "kb.leave").length, 0);
  assert.equal(s.seat.kbFocus, null);
});

// ---- pointer leave ------------------------------------------------------

function focusOn(rec, clientId = 100) {
  return {
    surfaceId: rec.id, rootSurfaceId: rec.id, surfaceRec: rec, clientId,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };
}

test("beginGrab over a live pointer focus sends pointer leave", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  s.seat.focus = focusOn(a);
  s.sent.length = 0;
  s.seat.beginGrab({ kind: "move", surfaceId: 1, endOnButtonUp: false });
  const leaves = s.sent.filter(([k]) => k === "p.leave");
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0][1][2], a.resource);
});

test("beginGrab over a DESTROYED pointer focus suppresses pointer leave", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  s.seat.focus = focusOn(a);
  a.resource.destroyed = true;
  s.sent.length = 0;
  s.seat.beginGrab({ kind: "move", surfaceId: 1, endOnButtonUp: false });
  assert.equal(s.sent.filter(([k]) => k === "p.leave").length, 0);
  assert.equal(s.seat.focus, null);
});

test("beginDrag over a DESTROYED pointer focus suppresses pointer leave", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  s.seat.focus = focusOn(a);
  a.resource.destroyed = true;
  s.sent.length = 0;
  s.seat.beginDrag({ onMotion() {}, onButton() {} });
  assert.equal(s.sent.filter(([k]) => k === "p.leave").length, 0);
});

// ---- clearFocusForSurface -----------------------------------------------

test("clearFocusForSurface drops kb + pointer focus records for that surface", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  s.seat.applyKeyboardFocus(1);
  s.seat.focus = focusOn(a);
  s.seat.clearFocusForSurface(1);
  assert.equal(s.seat.kbFocus, null);
  assert.equal(s.seat.focus, null);
});

test("clearFocusForSurface matches by rootSurfaceId (subsurface focus, root destroyed)", () => {
  const s = setup();
  const root = addSurface(s.ctx, 1);
  const sub = addSurface(s.ctx, 5);
  s.seat.focus = { ...focusOn(sub), rootSurfaceId: root.id };
  s.seat.clearFocusForSurface(1);
  assert.equal(s.seat.focus, null);
});

test("clearFocusForSurface leaves unrelated focus untouched", () => {
  const s = setup();
  addSurface(s.ctx, 1);
  const b = addSurface(s.ctx, 2);
  s.seat.applyKeyboardFocus(2);
  const kf = s.seat.kbFocus;
  s.seat.clearFocusForSurface(1);
  assert.equal(s.seat.kbFocus, kf);
});

// ---- explicit-destroy teardown ------------------------------------------

test("unmapAndTeardownSurface invalidates seat focus synchronously", () => {
  const s = setup();
  const a = addSurface(s.ctx, 1);
  s.seat.applyKeyboardFocus(1);
  s.seat.focus = focusOn(a);
  unmapAndTeardownSurface(s.ctx.state, s.ctx.addon, a);
  assert.equal(s.seat.kbFocus, null);
  assert.equal(s.seat.focus, null);
  // A focus change right after the destroy (before any frame sweep) must
  // not send leave for the gone surface.
  addSurface(s.ctx, 2);
  s.sent.length = 0;
  s.seat.applyKeyboardFocus(2);
  assert.equal(s.sent.filter(([k]) => k === "kb.leave").length, 0);
});
