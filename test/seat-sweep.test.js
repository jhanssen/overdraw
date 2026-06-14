// Pure-unit coverage for sweepDestroyedSeatState (wl_seat.ts).
//
// The function is the per-frame disconnect cleanup for seat state: clears
// kbFocus/focus pointing at a destroyed surface, and removes destroyed
// wl_keyboard/wl_pointer resources from the per-client sets. The hazard
// it defends against is libwayland's wl_client* address recycling: a new
// client at a recycled address must NOT inherit the previous client's
// keyboards via keyboardsByClient[recycled_ptr], or wl_keyboard.leave
// would be posted with a foreign-client surface (libwayland disconnects).

import { test } from "node:test";
import assert from "node:assert/strict";

import { sweepDestroyedSeatState } from "../packages/core/dist/protocols/wl_seat.js";

function res(name = "r", { destroyed = false } = {}) {
  return { __resource: name, interfaceName: name, version: 1, destroyed };
}

function focusOn(resource, surfaceId = 1, clientId = 100) {
  return {
    surfaceId,
    surfaceRec: { resource },
    clientId,
    rect: { x: 0, y: 0, width: 100, height: 100 },
  };
}

test("kbFocus pointing at a destroyed surface is cleared", () => {
  const dead = res("surf", { destroyed: true });
  const seat = { kbFocus: focusOn(dead), focus: null };
  sweepDestroyedSeatState(seat, new Map(), new Map());
  assert.equal(seat.kbFocus, null);
});

test("kbFocus pointing at a live surface is preserved", () => {
  const live = res("surf");
  const f = focusOn(live);
  const seat = { kbFocus: f, focus: null };
  sweepDestroyedSeatState(seat, new Map(), new Map());
  assert.equal(seat.kbFocus, f);
});

test("pointer focus pointing at a destroyed surface is cleared", () => {
  const dead = res("surf", { destroyed: true });
  const seat = { kbFocus: null, focus: focusOn(dead) };
  sweepDestroyedSeatState(seat, new Map(), new Map());
  assert.equal(seat.focus, null);
});

test("destroyed wl_keyboard resources are removed from per-client sets", () => {
  const live = res("kb-live");
  const dead = res("kb-dead", { destroyed: true });
  const kbByClient = new Map([[100, new Set([live, dead])]]);
  const seat = { kbFocus: null, focus: null };
  sweepDestroyedSeatState(seat, new Map(), kbByClient);
  assert.deepEqual([...kbByClient.get(100)], [live]);
});

test("destroyed wl_pointer resources are removed from per-client sets", () => {
  const live = res("p-live");
  const dead = res("p-dead", { destroyed: true });
  const ptrByClient = new Map([[100, new Set([live, dead])]]);
  const seat = { kbFocus: null, focus: null };
  sweepDestroyedSeatState(seat, ptrByClient, new Map());
  assert.deepEqual([...ptrByClient.get(100)], [live]);
});

test("client entry is removed when its set becomes empty", () => {
  const deadKb = res("kb", { destroyed: true });
  const deadP = res("p", { destroyed: true });
  const kbByClient = new Map([[100, new Set([deadKb])]]);
  const ptrByClient = new Map([[100, new Set([deadP])]]);
  const seat = { kbFocus: null, focus: null };
  sweepDestroyedSeatState(seat, ptrByClient, kbByClient);
  // Both maps now empty -- the recycled wl_client* hazard requires the
  // entries themselves go away, not just the inner sets.
  assert.equal(kbByClient.size, 0);
  assert.equal(ptrByClient.size, 0);
});

test("recycled-clientId hazard: new client added under same id after sweep sees a fresh set", () => {
  // Simulate the libwayland address recycle: client A's wl_keyboard is
  // destroyed; sweep runs; client B connects and lands at the same clientId.
  // After sweep + B's get_keyboard, B's set must NOT contain A's resource.
  const kbA = res("kbA", { destroyed: true });
  const kbByClient = new Map([[100, new Set([kbA])]]);
  const seat = { kbFocus: null, focus: null };
  sweepDestroyedSeatState(seat, new Map(), kbByClient);
  // Now client B "reconnects" at the same id: the seat handler would
  // call `keyboardsByClient(100).add(kbB)` which creates a fresh set
  // (the previous entry was deleted above). Mimic that:
  let set = kbByClient.get(100);
  if (!set) { set = new Set(); kbByClient.set(100, set); }
  const kbB = res("kbB");
  set.add(kbB);
  assert.deepEqual([...kbByClient.get(100)], [kbB]);
  assert.equal([...kbByClient.get(100)].some((r) => r.destroyed), false);
});

test("kbFocus + focus + per-client sets all swept in one call", () => {
  const deadSurf = res("surf", { destroyed: true });
  const deadKb = res("kb", { destroyed: true });
  const liveP = res("p");
  const seat = {
    kbFocus: focusOn(deadSurf),
    focus: focusOn(deadSurf),
  };
  const kbByClient = new Map([[100, new Set([deadKb])]]);
  const ptrByClient = new Map([[100, new Set([liveP])]]);
  sweepDestroyedSeatState(seat, ptrByClient, kbByClient);
  assert.equal(seat.kbFocus, null);
  assert.equal(seat.focus, null);
  assert.equal(kbByClient.has(100), false);  // dead kb -> set emptied -> entry dropped
  assert.deepEqual([...ptrByClient.get(100)], [liveP]);  // live p preserved
});

test("idempotent: a second call with no destroyed entries leaves state untouched", () => {
  const live = res("surf");
  const liveKb = res("kb");
  const f = focusOn(live);
  const seat = { kbFocus: f, focus: null };
  const kbByClient = new Map([[100, new Set([liveKb])]]);
  sweepDestroyedSeatState(seat, new Map(), kbByClient);
  sweepDestroyedSeatState(seat, new Map(), kbByClient);
  assert.equal(seat.kbFocus, f);
  assert.deepEqual([...kbByClient.get(100)], [liveKb]);
});

test("no-op on empty inputs", () => {
  const seat = { kbFocus: null, focus: null };
  const kb = new Map();
  const p = new Map();
  sweepDestroyedSeatState(seat, p, kb);
  assert.equal(seat.kbFocus, null);
  assert.equal(seat.focus, null);
  assert.equal(kb.size, 0);
  assert.equal(p.size, 0);
});
