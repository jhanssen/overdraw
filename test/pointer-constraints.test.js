import { test } from "node:test";
import assert from "node:assert/strict";

import makePointerConstraints, {
  makeLockedPointer, makeConfinedPointer, isPointerLocked,
  notifyPointerFocus, notifyPointerMotion, sweepDisconnected,
} from "../packages/core/dist/protocols/zwp_pointer_constraints_v1.js";
import { Region } from "../packages/core/dist/protocols/region.js";

function mkCtx({ focusSurfaceId = null, rect = { x: 0, y: 0, width: 100, height: 100 },
                pointer = { x: 10, y: 10 } } = {}) {
  const calls = { setPointerLocked: [], setPointerConfine: [], events: [], errors: [] };
  const surfaces = new Map();
  const regions = new Map();
  const ptr = { ...pointer };
  const ctx = {
    addon: {
      setPointerLocked: (v) => calls.setPointerLocked.push(v),
      setPointerConfine: (r) => calls.setPointerConfine.push(r),
      postError: (res, code, msg) => calls.errors.push({ res, code, msg }),
    },
    events: {
      zwp_locked_pointer_v1: {
        send_locked: (r) => calls.events.push(["locked", r]),
        send_unlocked: (r) => calls.events.push(["unlocked", r]),
      },
      zwp_confined_pointer_v1: {
        send_confined: (r) => calls.events.push(["confined", r]),
        send_unconfined: (r) => calls.events.push(["unconfined", r]),
      },
    },
    state: {
      surfaces, regions,
      seat: {
        focus: focusSurfaceId === null ? null
          : { surfaceId: focusSurfaceId, rect,
              view: { originX: 0, originY: 0, camX: 0, camY: 0, zoom: 1 } },
        pointerPosition: () => ptr,
      },
    },
  };
  return { ctx, calls, surfaces, regions, ptr };
}

function surfaceWithId(surfaces, id) { const res = {}; surfaces.set(res, { id }); return res; }
function regionWith(regions, rects) {
  const reg = new Region();
  for (const r of rects) reg.add(r.x, r.y, r.width, r.height);
  const res = {};
  regions.set(res, reg);
  return res;
}
const NORES = {};

// --- lock ---

test("lock activates (freeze + locked) when the surface has focus", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  const locked = {};
  makePointerConstraints(ctx).lock_pointer(NORES, locked, surface, NORES, null, 2);
  assert.deepEqual(calls.setPointerLocked, [true]);
  assert.deepEqual(calls.events, [["locked", locked]]);
  assert.equal(isPointerLocked(ctx), true);
});

test("lock does not activate when the surface is unfocused", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 9 });
  const surface = surfaceWithId(surfaces, 5);
  makePointerConstraints(ctx).lock_pointer(NORES, {}, surface, NORES, null, 2);
  assert.deepEqual(calls.setPointerLocked, []);
  assert.equal(isPointerLocked(ctx), false);
});

test("destroying an active lock unfreezes and sends unlocked", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  const locked = {};
  makePointerConstraints(ctx).lock_pointer(NORES, locked, surface, NORES, null, 2);
  makeLockedPointer(ctx).destroy(locked);
  assert.deepEqual(calls.setPointerLocked, [true, false]);
  assert.deepEqual(calls.events.map((e) => e[0]), ["locked", "unlocked"]);
  assert.equal(isPointerLocked(ctx), false);
});

test("isPointerLocked self-heals when the client dies without destroy", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  const locked = {};
  makePointerConstraints(ctx).lock_pointer(NORES, locked, surface, NORES, null, 2);
  locked.destroyed = true;
  assert.equal(isPointerLocked(ctx), false);
  assert.deepEqual(calls.setPointerLocked, [true, false]);
});

// --- lock region gating ---

test("lock with a region only activates while the pointer is inside it", () => {
  const { ctx, calls, surfaces, regions, ptr } = mkCtx({ focusSurfaceId: 5, pointer: { x: 80, y: 80 } });
  const surface = surfaceWithId(surfaces, 5);
  const region = regionWith(regions, [{ x: 0, y: 0, width: 50, height: 50 }]);
  makePointerConstraints(ctx).lock_pointer(NORES, {}, surface, NORES, region, 2);
  assert.equal(isPointerLocked(ctx), false);   // pointer at (80,80) is outside
  ptr.x = 10; ptr.y = 10;                       // move into the region
  notifyPointerMotion(ctx);
  assert.equal(isPointerLocked(ctx), true);
});

// --- confine ---

test("confine without a region clamps to the whole surface rect", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5, rect: { x: 200, y: 100, width: 800, height: 600 } });
  const surface = surfaceWithId(surfaces, 5);
  const confined = {};
  makePointerConstraints(ctx).confine_pointer(NORES, confined, surface, NORES, null, 2);
  assert.deepEqual(calls.setPointerConfine, [[{ x: 200, y: 100, w: 800, h: 600 }]]);
  assert.deepEqual(calls.events, [["confined", confined]]);
  assert.equal(isPointerLocked(ctx), false);   // confine is not a lock
});

test("confine with a region clamps to the region translated to the surface origin", () => {
  const { ctx, calls, surfaces, regions } = mkCtx({ focusSurfaceId: 5, rect: { x: 200, y: 100, width: 800, height: 600 } });
  const surface = surfaceWithId(surfaces, 5);
  const region = regionWith(regions, [{ x: 10, y: 20, width: 30, height: 40 }]);
  makePointerConstraints(ctx).confine_pointer(NORES, {}, surface, NORES, region, 2);
  assert.deepEqual(calls.setPointerConfine, [[{ x: 210, y: 120, w: 30, h: 40 }]]);
});

test("destroying a confine clears the native confinement", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  const confined = {};
  makePointerConstraints(ctx).confine_pointer(NORES, confined, surface, NORES, null, 2);
  makeConfinedPointer(ctx).destroy(confined);
  assert.deepEqual(calls.setPointerConfine.at(-1), []);   // cleared
  assert.deepEqual(calls.events.map((e) => e[0]), ["confined", "unconfined"]);
});

// --- focus changes + lifetime ---

test("persistent lock reactivates when its surface regains focus", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  makePointerConstraints(ctx).lock_pointer(NORES, {}, surface, NORES, null, 2);  // persistent
  notifyPointerFocus(ctx, null);   // focus leaves -> deactivate
  assert.equal(isPointerLocked(ctx), false);
  notifyPointerFocus(ctx, 5);      // focus returns -> reactivate
  assert.equal(isPointerLocked(ctx), true);
  assert.deepEqual(calls.setPointerLocked, [true, false, true]);
});

test("oneshot lock does NOT reactivate after deactivation", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  makePointerConstraints(ctx).lock_pointer(NORES, {}, surface, NORES, null, 1);  // oneshot
  notifyPointerFocus(ctx, null);   // deactivate -> defunct
  notifyPointerFocus(ctx, 5);      // must NOT reactivate
  assert.equal(isPointerLocked(ctx), false);
  assert.deepEqual(calls.setPointerLocked, [true, false]);
});

// --- already_constrained ---

test("a second constraint on the same surface+pointer posts already_constrained", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  const pointer = {};
  const manager = {};
  const mgr = makePointerConstraints(ctx);
  mgr.lock_pointer(manager, {}, surface, pointer, null, 2);
  mgr.lock_pointer(manager, {}, surface, pointer, null, 2);
  assert.equal(calls.errors.length, 1);
  assert.equal(calls.errors[0].code, 1);
  assert.equal(calls.errors[0].res, manager);
});

test("lock_pointer on an unknown surface is a no-op", () => {
  const { ctx, calls } = mkCtx({ focusSurfaceId: 5 });
  makePointerConstraints(ctx).lock_pointer(NORES, {}, {}, NORES, null, 2);
  assert.deepEqual(calls.setPointerLocked, []);
  assert.equal(isPointerLocked(ctx), false);
});

// --- disconnect sweep ---

test("sweepDisconnected deactivates + drops a lock whose client vanished", () => {
  const { ctx, calls, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  const locked = {};
  makePointerConstraints(ctx).lock_pointer(NORES, locked, surface, NORES, null, 2);
  assert.equal(isPointerLocked(ctx), true);

  // Client disconnected: no destructor request ran, only the flag flips.
  locked.destroyed = true;
  sweepDisconnected(ctx);

  assert.equal(isPointerLocked(ctx), false);
  assert.deepEqual(calls.setPointerLocked, [true, false]);
  // The dropped record no longer blocks a new constraint on the same
  // surface + pointer (already_constrained must not fire).
  const locked2 = {};
  makePointerConstraints(ctx).lock_pointer(NORES, locked2, surface, NORES, null, 2);
  assert.equal(calls.errors.length, 0);
  assert.equal(isPointerLocked(ctx), true);
});

test("sweepDisconnected leaves live constraints alone", () => {
  const { ctx, surfaces } = mkCtx({ focusSurfaceId: 5 });
  const surface = surfaceWithId(surfaces, 5);
  makePointerConstraints(ctx).lock_pointer(NORES, {}, surface, NORES, null, 2);
  sweepDisconnected(ctx);
  assert.equal(isPointerLocked(ctx), true);
});
