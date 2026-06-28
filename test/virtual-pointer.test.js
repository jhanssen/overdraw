import { test } from "node:test";
import assert from "node:assert/strict";

import makeVirtualPointerManager, { makeVirtualPointer }
  from "../packages/core/dist/protocols/zwlr_virtual_pointer_manager_v1.js";

// Build a fake Ctx capturing every injectInput call, with a settable pointer
// position and a configurable output layout. Only the fields the handler
// touches are present.
function mkCtx({ pointer = { x: 0, y: 0 }, outputs = null } = {}) {
  const injected = [];
  const outMap = outputs === null ? undefined : new Map(
    outputs.map((o, i) => [i, {
      logicalPosition: { x: o.x, y: o.y },
      logicalSize: { width: o.w, height: o.h },
    }]),
  );
  const ctx = {
    addon: { injectInput: (ev) => injected.push(ev) },
    state: {
      seat: { pointerPosition: () => pointer },
      outputs: outMap,
    },
  };
  return { ctx, injected };
}

const RES = {}; // resource arg is unused by the handler

// --- relative motion: add to current position, inject absolute ---

test("motion: relative delta is added to the current pointer position", () => {
  const { ctx, injected } = mkCtx({ pointer: { x: 500, y: 400 },
    outputs: [{ x: 0, y: 0, w: 1920, h: 1080 }] });
  makeVirtualPointer(ctx).motion(RES, 123, 10, -20);
  assert.equal(injected.length, 1);
  assert.deepEqual(injected[0],
    { type: "pointerMotion", serial: 0, time: 123, x: 510, y: 380 });
});

test("motion: result is clamped to the output union (cannot escape)", () => {
  const { ctx, injected } = mkCtx({ pointer: { x: 1900, y: 10 },
    outputs: [{ x: 0, y: 0, w: 1920, h: 1080 }] });
  makeVirtualPointer(ctx).motion(RES, 1, 9999, -9999);
  assert.equal(injected[0].x, 1920); // clamped to right edge of the union
  assert.equal(injected[0].y, 0);    // clamped to top edge
});

test("motion: spans a multi-output union bounding box", () => {
  const { ctx, injected } = mkCtx({ pointer: { x: 1910, y: 100 },
    outputs: [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 1920, y: 0, w: 1920, h: 1080 }] });
  makeVirtualPointer(ctx).motion(RES, 1, 100, 0);
  assert.equal(injected[0].x, 2010); // crossed into the second output, not clamped
});

test("motion: with no outputs the delta is applied unclamped", () => {
  const { ctx, injected } = mkCtx({ pointer: { x: 5, y: 5 }, outputs: null });
  makeVirtualPointer(ctx).motion(RES, 1, -100, -100);
  assert.deepEqual(injected[0], { type: "pointerMotion", serial: 0, time: 1, x: -95, y: -95 });
});

// --- motion_absolute: fraction mapped across the union ---

test("motion_absolute: maps (x/extent) across the output union", () => {
  const { ctx, injected } = mkCtx({ outputs: [{ x: 0, y: 0, w: 1000, h: 500 }] });
  makeVirtualPointer(ctx).motion_absolute(RES, 7, 1, 1, 2, 1); // (0.5, 1.0)
  assert.deepEqual(injected[0],
    { type: "pointerMotion", serial: 0, time: 7, x: 500, y: 500 });
});

test("motion_absolute: zero extent is ignored (no divide-by-zero)", () => {
  const { ctx, injected } = mkCtx({ outputs: [{ x: 0, y: 0, w: 1000, h: 500 }] });
  makeVirtualPointer(ctx).motion_absolute(RES, 1, 1, 1, 0, 1);
  assert.equal(injected.length, 0);
});

// --- button / axis / frame mapping ---

test("button: state 1 maps to pressed, 0 to released", () => {
  const { ctx, injected } = mkCtx();
  const vp = makeVirtualPointer(ctx);
  vp.button(RES, 1, 0x110, 1);
  vp.button(RES, 2, 0x110, 0);
  assert.deepEqual(injected[0], { type: "pointerButton", serial: 0, time: 1, button: 0x110, pressed: true });
  assert.deepEqual(injected[1], { type: "pointerButton", serial: 0, time: 2, button: 0x110, pressed: false });
});

test("axis: axis 1 is horizontal, 0 vertical; discrete carried through", () => {
  const { ctx, injected } = mkCtx();
  const vp = makeVirtualPointer(ctx);
  vp.axis(RES, 1, 0, 12.5);
  vp.axis_discrete(RES, 2, 1, 8, 1);
  assert.deepEqual(injected[0], { type: "pointerAxis", serial: 0, time: 1, horizontal: false, value: 12.5 });
  assert.deepEqual(injected[1], { type: "pointerAxis", serial: 0, time: 2, horizontal: true, value: 8, discrete: 1 });
});

test("frame: injects a pointerFrame", () => {
  const { ctx, injected } = mkCtx();
  makeVirtualPointer(ctx).frame(RES);
  assert.deepEqual(injected[0], { type: "pointerFrame", serial: 0, time: 0 });
});

test("axis_source / axis_stop are no-ops (no normalized representation)", () => {
  const { ctx, injected } = mkCtx();
  const vp = makeVirtualPointer(ctx);
  vp.axis_source(RES, 0);
  vp.axis_stop(RES, 1, 0);
  assert.equal(injected.length, 0);
});

// --- manager is inert (child resource auto-dispatches by interface) ---

test("manager: create requests do not throw and inject nothing", () => {
  const { ctx, injected } = mkCtx();
  const mgr = makeVirtualPointerManager(ctx);
  mgr.create_virtual_pointer(RES, null, RES);
  mgr.create_virtual_pointer_with_output(RES, null, null, RES);
  mgr.destroy(RES);
  assert.equal(injected.length, 0);
});
