// Pure-unit test for the ext_image_copy_capture_v1 "force a present on
// capture" wiring. Arming a capture frame changes no pixels, so on an idle
// desktop nothing marks the output dirty, no page flip occurs, and the
// capture -- whose readback is driven off the flip-complete edge -- hangs
// until an unrelated repaint. capture() must therefore ask the compositor to
// present the relevant output(s). This drives the handler factories with a
// mock ctx and asserts that contract; the GPU integration test can't cover it
// because headless renders every tick (bypassing the per-output dirty gate).

import { test } from "node:test";
import assert from "node:assert/strict";

import makeOutputSourceManager, {
  makeImageCopyCaptureManager,
  makeImageCopyCaptureSession,
  makeImageCopyCaptureFrame,
  _resetForTests,
} from "../packages/core/dist/protocols/ext_image_copy_capture_v1.js";

let idc = 0;
function mockResource(name) {
  return { __resource: Symbol(name), interfaceName: name, version: 1,
           id: ++idc, destroyed: false };
}

// A ctx whose compositor records requestOutputPresent calls and whose addon
// records wake() calls. `wireCompositor: false` omits requestOutputPresent
// (the GPU-free harness case) so we can assert capture() tolerates its absence.
function mockCtx({ outputId = 7, wireCompositor = true } = {}) {
  const presented = [];
  const wakes = [];
  const errors = [];
  const wlOutput = mockResource("wl_output");
  const compositor = {};
  if (wireCompositor) {
    compositor.requestOutputPresent = (oid) => presented.push(oid);
  }
  const noop = () => {};
  const ctx = {
    addon: {
      wake: () => wakes.push(true),
      postError: (res, code, msg) => errors.push({ code, msg }),
    },
    events: {
      ext_image_copy_capture_session_v1: {
        send_buffer_size: noop, send_shm_format: noop, send_done: noop,
      },
      ext_image_copy_capture_frame_v1: { send_failed: noop },
    },
    state: {
      compositor,
      wlOutputResources: new Map([[outputId, new Set([wlOutput])]]),
      outputs: new Map([[outputId, { deviceSize: { width: 320, height: 240 }, scale: 1 }]]),
      surfacesById: new Map(),
    },
  };
  return { ctx, presented, wakes, errors, wlOutput, outputId };
}

// Drive source -> session -> frame -> attach_buffer -> capture for an output
// source, returning the recorded effects.
function driveOutputCapture(env) {
  const { ctx, wlOutput } = env;
  const srcMgr = makeOutputSourceManager(ctx);
  const mgr = makeImageCopyCaptureManager(ctx);
  const session = makeImageCopyCaptureSession(ctx);
  const frame = makeImageCopyCaptureFrame(ctx);

  const sourceRes = mockResource("ext_image_capture_source_v1");
  srcMgr.create_source(mockResource("mgr"), sourceRes, wlOutput);

  const sessionRes = mockResource("session");
  mgr.create_session(mockResource("mgr"), sessionRes, sourceRes, 0);

  const frameRes = mockResource("frame");
  session.create_frame(sessionRes, frameRes);
  frame.attach_buffer(frameRes, mockResource("wl_buffer"));
  frame.capture(frameRes);
  return frameRes;
}

test("capture() on an output source forces that output to present, then wakes", () => {
  _resetForTests();
  const env = mockCtx({ outputId: 7 });
  driveOutputCapture(env);

  assert.deepEqual(env.presented, [7],
    "capture must ask the compositor to present the source output");
  assert.equal(env.wakes.length, 1, "capture must wake the frame loop");
  assert.equal(env.errors.length, 0, "no protocol error on the happy path");
});

test("capture() tolerates a compositor with no requestOutputPresent (GPU-free)", () => {
  _resetForTests();
  const env = mockCtx({ outputId: 7, wireCompositor: false });
  // Must not throw when the hook is absent, and must still wake.
  assert.doesNotThrow(() => driveOutputCapture(env));
  assert.equal(env.wakes.length, 1, "wake still fires without the present hook");
});
