import { test } from "node:test";
import assert from "node:assert/strict";

import makeRelativePointerManager, { makeRelativePointer, sendRelativeMotionTo }
  from "../packages/core/dist/protocols/zwp_relative_pointer_manager_v1.js";

function mkCtx() {
  const sent = [];
  const ctx = {
    addon: { clientId: (res) => res.__cid ?? 1 },
    events: {
      zwp_relative_pointer_v1: {
        send_relative_motion: (rp, hi, lo, dx, dy, dxu, dyu) =>
          sent.push({ rp, hi, lo, dx, dy, dxu, dyu }),
      },
    },
  };
  return { ctx, sent };
}

const NORES = {};

test("get_relative_pointer: stashes the relative pointer on its wl_pointer", () => {
  const { ctx } = mkCtx();
  const pointer = { __cid: 7 };
  const rp = {};
  makeRelativePointerManager(ctx).get_relative_pointer(NORES, rp, pointer);
  assert.equal(pointer.__relativePointer, rp);
  assert.equal(rp.__clientId, 7);
});

test("sendRelativeMotionTo: forwards deltas + microsecond timestamp, returns true", () => {
  const { ctx, sent } = mkCtx();
  const pointer = {};
  const rp = {};
  makeRelativePointerManager(ctx).get_relative_pointer(NORES, rp, pointer);
  const r = sendRelativeMotionTo(ctx, pointer, {
    type: "pointerMotion", time: 5, dx: 2.5, dy: -1.5, dxUnaccel: 3, dyUnaccel: -2,
  });
  assert.equal(r, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { rp, hi: 0, lo: 5000, dx: 2.5, dy: -1.5, dxu: 3, dyu: -2 });
});

test("sendRelativeMotionTo: utime splits across 32 bits", () => {
  const { ctx, sent } = mkCtx();
  const pointer = {};
  const rp = {};
  makeRelativePointerManager(ctx).get_relative_pointer(NORES, rp, pointer);
  sendRelativeMotionTo(ctx, pointer, { type: "pointerMotion", time: 5_000_000, dx: 0, dy: 0 });
  // us = 5e9; hi = floor(5e9 / 2^32) = 1; lo = 5e9 - 2^32 = 705032704
  assert.equal(sent[0].hi, 1);
  assert.equal(sent[0].lo, 705032704);
});

test("sendRelativeMotionTo: unaccel falls back to accel when absent", () => {
  const { ctx, sent } = mkCtx();
  const pointer = {};
  const rp = {};
  makeRelativePointerManager(ctx).get_relative_pointer(NORES, rp, pointer);
  sendRelativeMotionTo(ctx, pointer, { type: "pointerMotion", time: 1, dx: 4, dy: 6 });
  assert.equal(sent[0].dxu, 4);
  assert.equal(sent[0].dyu, 6);
});

test("sendRelativeMotionTo: a pointer with no relative pointer returns false", () => {
  const { ctx, sent } = mkCtx();
  assert.equal(sendRelativeMotionTo(ctx, {}, { type: "pointerMotion", time: 1, dx: 1, dy: 1 }), false);
  assert.equal(sent.length, 0);
});

test("sendRelativeMotionTo: a destroyed relative pointer returns false", () => {
  const { ctx, sent } = mkCtx();
  const pointer = {};
  const rp = { destroyed: true };
  makeRelativePointerManager(ctx).get_relative_pointer(NORES, rp, pointer);
  assert.equal(sendRelativeMotionTo(ctx, pointer, { type: "pointerMotion", time: 1, dx: 1, dy: 1 }), false);
  assert.equal(sent.length, 0);
});

test("makeRelativePointer: child handler exposes destroy without throwing", () => {
  const { ctx } = mkCtx();
  assert.doesNotThrow(() => makeRelativePointer(ctx).destroy(NORES));
});
