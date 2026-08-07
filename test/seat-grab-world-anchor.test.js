// The seat's move/resize grab motion is WORLD-anchored: beginGrab stamps
// the anchor's world position through the content camera, and each motion
// computes world-to-world deltas. A camera that moves mid-grab (the
// elastic strip's reveal-scroll pans while a drag pushes past the docked
// view's edge) must shift the grabbed window with the world under the
// hand -- a glass-delta-only transform caps the window's world travel at
// one viewport width, making the far end of a long strip unreachable.

import { test } from "node:test";
import assert from "node:assert/strict";

import makeSeat from "../packages/core/dist/protocols/wl_seat.js";

const noopDriver = { dispatch() {}, settled: async () => {} };

function setup({ camX = 0, camY = 0, zoom = 1 } = {}) {
  const floatingRects = [];
  const dragMoves = [];
  const cameras = new Map([[0, { x: camX, y: camY, zoom }]]);
  const ctx = {
    events: {
      wl_seat: { send_capabilities() {}, send_name() {} },
      wl_keyboard: {}, wl_pointer: {},
    },
    addon: { clientId: () => 100, keymapInfo: () => null },
    state: {
      serial: () => 1,
      surfaces: new Map(),
      surfacesById: new Map(),
      compositor: {},
      outputs: new Map([[0, {
        id: 0,
        logicalPosition: { x: 0, y: 0 },
        logicalSize: { width: 1000, height: 600 },
      }]]),
      outputCameras: cameras,
      wm: {
        getWindowState: () => null,
        setFloatingRect(id, rect) { floatingRects.push({ id, rect }); },
      },
      pluginBus: {
        emit(name, payload) {
          if (name === "window.drag-moved") dragMoves.push(payload);
        },
      },
    },
  };
  makeSeat(ctx, noopDriver);
  return { seat: ctx.state.seat, cameras, floatingRects, dragMoves };
}

test("grab motion with a static camera: rect tracks the glass delta", () => {
  const s = setup({ camX: 2000 });
  s.seat.beginGrab({
    kind: "move", surfaceId: 1, anchorX: 500, anchorY: 300,
    startRect: { x: 2600, y: 100, width: 300, height: 200 },
    lifted: true, wasManaged: true,
  });
  s.seat.handleInput({ type: "pointerMotion", x: 400, y: 300, time: 1 });
  assert.equal(s.floatingRects.length, 1);
  assert.deepEqual(s.floatingRects[0].rect,
    { x: 2500, y: 100, width: 300, height: 200 });
  assert.equal(s.dragMoves[0].x, 2400, "drag-moved carries world coords");
});

test("camera pans mid-grab: the window follows the world under the hand", () => {
  const s = setup({ camX: 2000 });
  s.seat.beginGrab({
    kind: "move", surfaceId: 1, anchorX: 500, anchorY: 300,
    startRect: { x: 2600, y: 100, width: 300, height: 200 },
    lifted: true, wasManaged: true,
  });
  s.seat.handleInput({ type: "pointerMotion", x: 400, y: 300, time: 1 });
  // The reveal-scroll pans the strip 200 world px left; the pointer has
  // not moved on glass. The next motion event must re-pin the window
  // 200 further left -- under glass-delta math it would sit at 2500
  // forever, capping how far a drag can travel.
  s.cameras.set(0, { x: 1800, y: 0, zoom: 1 });
  s.seat.handleInput({ type: "pointerMotion", x: 400, y: 300, time: 2 });
  assert.deepEqual(s.floatingRects.at(-1).rect,
    { x: 2300, y: 100, width: 300, height: 200 });
  assert.equal(s.dragMoves.at(-1).x, 2200,
    "drag-moved world coords track the pan too");
});

test("zoomed-out view: glass travel converts through the zoom", () => {
  const s = setup({ camX: 0, zoom: 0.5 });
  s.seat.beginGrab({
    kind: "move", surfaceId: 1, anchorX: 100, anchorY: 100,
    startRect: { x: 200, y: 200, width: 300, height: 200 },
    lifted: true, wasManaged: true,
  });
  // 50 glass px at zoom 0.5 = 100 world px.
  s.seat.handleInput({ type: "pointerMotion", x: 150, y: 100, time: 1 });
  assert.deepEqual(s.floatingRects.at(-1).rect,
    { x: 300, y: 200, width: 300, height: 200 });
});
