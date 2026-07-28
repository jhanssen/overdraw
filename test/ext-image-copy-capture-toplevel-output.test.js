// Pure-unit test for toplevel-capture pacing: an armed toplevel-source frame
// is drained only by a flip on the surface's OWN output, not by whichever
// output flips first. A 60Hz toplevel next to a 240Hz output must stream at
// 60Hz. Drives the real foreign-toplevel-list registry to mint a handle,
// builds a toplevel capture session from it, then dispatches flips for a
// foreign output (frame must stay armed) and the surface's output (frame
// drains).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeImageCopyCaptureManager,
  makeImageCopyCaptureSession,
  makeImageCopyCaptureFrame,
  makeForeignToplevelImageCaptureSourceManager,
  dispatchCaptureForOutput,
  _resetForTests as resetCapture,
} from "../packages/core/dist/protocols/ext_image_copy_capture_v1.js";
import makeExtForeignToplevelList, { _resetForTests as resetList }
  from "../packages/core/dist/protocols/ext_foreign_toplevel_list_v1.js";

let idc = 0;
function mockResource(name) {
  return { __resource: Symbol(name), interfaceName: name, version: 1,
           id: ++idc, destroyed: false };
}

// Two outputs (7 and 9); one toplevel surface (id 33) resident on output 9.
function mockCtx() {
  const presented = [];
  const failed = [];
  const noop = () => {};
  let handle = null;
  const surfaceRes = mockResource("wl_surface");
  const ctx = {
    addon: { wake: noop, postError: noop },
    events: {
      ext_image_copy_capture_session_v1: {
        send_buffer_size: noop, send_shm_format: noop, send_done: noop,
      },
      ext_image_copy_capture_frame_v1: {
        send_failed: (res, reason) => failed.push({ res, reason }),
      },
      ext_foreign_toplevel_list_v1: {
        send_toplevel: () => (handle = mockResource("handle")),
        send_finished: noop,
      },
      ext_foreign_toplevel_handle_v1: {
        send_identifier: noop, send_app_id: noop, send_title: noop,
        send_done: noop, send_closed: noop,
      },
    },
    state: {
      compositor: {
        requestOutputPresent: (oid) => presented.push(oid),
        // Wired so dispatchCaptureForOutput doesn't take its GPU-free
        // early-return; captureOneFrame still fails at the buffer lookup,
        // which is enough to observe "the frame was drained."
        composeOutput: () => null,
        composeRegion: () => null,
      },
      surfaces: new Map(),
      surfacesById: new Map([[33, {
        id: 33, resource: surfaceRes, unmapped: false,
        enteredOutputs: new Set([9]),
      }]]),
      outputs: new Map([
        [7, { deviceSize: { width: 320, height: 240 }, scale: 1 }],
        [9, { deviceSize: { width: 640, height: 480 }, scale: 1 }],
      ]),
      wm: {
        state: { windows: [{ surfaceId: 33, hasContent: true }] },
        outerRectOf: () => ({ x: 0, y: 0, width: 100, height: 80 }),
        primaryOutputId: () => 7,
      },
      buffers: new Map(),  // attach'd buffer resolves to no descriptor -> failed
    },
  };
  return { ctx, presented, failed, getHandle: () => handle };
}

test("toplevel capture drains on its own output's flip only", () => {
  resetCapture();
  resetList();
  const { ctx, presented, failed, getHandle } = mockCtx();

  // Mint a foreign-toplevel handle for surface 33 through the real registry.
  makeExtForeignToplevelList(ctx).bind(mockResource("list"));
  const handle = getHandle();
  assert.ok(handle, "list bind mints a handle for the mapped toplevel");

  const srcMgr = makeForeignToplevelImageCaptureSourceManager(ctx);
  const mgr = makeImageCopyCaptureManager(ctx);
  const session = makeImageCopyCaptureSession(ctx);
  const frame = makeImageCopyCaptureFrame(ctx);

  const sourceRes = mockResource("source");
  srcMgr.create_source(mockResource("mgr"), sourceRes, handle);
  const sessionRes = mockResource("session");
  mgr.create_session(mockResource("mgr"), sessionRes, sourceRes, 0);
  const frameRes = mockResource("frame");
  session.create_frame(sessionRes, frameRes);
  frame.attach_buffer(frameRes, mockResource("wl_buffer"));
  frame.capture(frameRes);

  assert.deepEqual(presented, [9],
    "capture nudges the toplevel's own output, not all outputs");

  // Flip on the OTHER output: the frame must stay armed (nothing drains).
  dispatchCaptureForOutput(ctx, 7, 0n, 0);
  assert.equal(failed.length, 0,
    "a foreign output's flip must not drain a toplevel frame");

  // Flip on the surface's output: the frame drains (fails at the buffer
  // lookup in this mock, which proves it was collected).
  dispatchCaptureForOutput(ctx, 9, 0n, 0);
  assert.equal(failed.length, 1, "the surface's own flip drains the frame");
});
