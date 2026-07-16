// DnD action negotiation (pure logic), GPU-free. The full DnD vertical (grab,
// enter/motion/leave, drop, transfer) is covered by test/dnd.gpu.mjs; this pins
// the action-mask negotiation, which is easy to get subtly wrong.
//
// dnd_action: none=0, copy=1, move=2, ask=4.

import { test } from "node:test";
import assert from "node:assert/strict";

import { negotiateDndAction, cancelDisplacedSource, makeDataDevice }
  from "../packages/core/dist/protocols/wl_data_device_manager.js";

const NONE = 0, COPY = 1, MOVE = 2, ASK = 4;

test("no common action -> none", () => {
  assert.equal(negotiateDndAction(COPY, MOVE, 0), NONE);
  assert.equal(negotiateDndAction(0, COPY | MOVE, COPY), NONE);
});

test("preferred action wins when it is in the intersection", () => {
  assert.equal(negotiateDndAction(COPY | MOVE, COPY | MOVE, MOVE), MOVE);
  assert.equal(negotiateDndAction(COPY | MOVE, COPY | MOVE, COPY), COPY);
});

test("preferred not in intersection -> fall back copy>move>ask", () => {
  // receiver prefers ASK but source only offers copy+move -> copy (highest).
  assert.equal(negotiateDndAction(COPY | MOVE, COPY | MOVE, ASK), COPY);
  // only move common -> move.
  assert.equal(negotiateDndAction(MOVE, MOVE | ASK, 0), MOVE);
  // only ask common -> ask.
  assert.equal(negotiateDndAction(ASK, ASK, 0), ASK);
});

test("single matching action with no preference", () => {
  assert.equal(negotiateDndAction(COPY, COPY, 0), COPY);
});

// cancelDisplacedSource: the displaced selection owner is told it lost the slot
// via the cancelled event matching ITS interface (the selection state is shared
// across wl_data, primary, and ext-data-control).
function spyCtx() {
  const fired = [];
  const make = (iface) => ({ send_cancelled: (r) => fired.push([iface, r]) });
  return {
    fired,
    events: {
      wl_data_source: make("wl_data_source"),
      zwp_primary_selection_source_v1: make("zwp_primary_selection_source_v1"),
      ext_data_control_source_v1: make("ext_data_control_source_v1"),
    },
  };
}
const src = (interfaceName) => ({ interfaceName, destroyed: false });

test("cancelDisplacedSource dispatches cancelled by the source's interface", () => {
  for (const iface of ["wl_data_source", "zwp_primary_selection_source_v1", "ext_data_control_source_v1"]) {
    const ctx = spyCtx();
    const prev = src(iface);
    cancelDisplacedSource(ctx, prev, src("wl_data_source"));
    assert.deepEqual(ctx.fired, [[iface, prev]]);
  }
});

test("cancelDisplacedSource is a no-op when nothing was displaced", () => {
  const ctx = spyCtx();
  const same = src("wl_data_source");
  cancelDisplacedSource(ctx, null, same);          // no prior owner
  cancelDisplacedSource(ctx, same, same);          // same source re-asserting
  cancelDisplacedSource(ctx, { interfaceName: "wl_data_source", destroyed: true }, null); // gone
  assert.equal(ctx.fired.length, 0);
});

// The drag icon rides the pointer, and the pointer is glass. The renderer
// applies the content camera to any surface that isn't camera-exempt, so an
// icon placed with raw pointer coords must be output-anchored or it draws
// cameraX away from the cursor it belongs under (and scales with zoom while
// the cursor doesn't). Pins that the icon is anchored before it is placed.
test("drag icon is output-anchored so the camera leaves it on the cursor", () => {
  const calls = [];
  const iconRes = { id: 7, destroyed: false };
  let grab = null;
  const ctx = {
    state: {
      surfaces: new Map([[iconRes, { id: 7, offsetDx: -5, offsetDy: -3 }]]),
      compositor: {
        setSurfaceOutputAnchored: (id, anchored) => calls.push(["anchor", id, anchored]),
        setSurfaceLayout: (id, x, y) => calls.push(["layout", id, x, y]),
        setStack: () => {},
        removeSurface: () => {},
      },
      wm: { state: { windows: [] } },
      seat: { beginDrag: (h) => { grab = h; }, endDrag: () => {} },
      dataDevices: new Map(),
      dataSources: new Map(),
    },
    events: { wl_data_device: { send_leave: () => {}, send_enter: () => {}, send_motion: () => {} } },
  };

  makeDataDevice(ctx).start_drag(null, null, null, iconRes, 0);
  grab.onMotion(500, 400, null);

  assert.deepEqual(calls, [
    ["anchor", 7, true],
    // Raw glass pointer plus the client's buffer offset -- no camera term,
    // which is only correct because the surface is anchored above.
    ["layout", 7, 495, 397],
  ]);
});
