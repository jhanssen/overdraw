// Idle frame-callback delivery (GPU-free). A wl_surface.frame callback is
// normally delivered when its output presents (the flip-complete path). A
// surface can arm one with a commit that produces no present -- a bare frame-
// callback-only commit, or one whose content is still uploading -- and on an
// otherwise idle compositor no flip-complete is coming, so the callback would
// strand (a client gating its render loop on `done` then hangs). The idle tick
// (dispatchFrameCallbacks) delivers those, gated so a surface with a present on
// the way keeps its flip-complete pacing instead of free-running. These tests
// pin the gate predicate that drives that decision.

import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldDeliverFrameCallbackIdle } from "../packages/core/dist/protocols/frame-callbacks.js";

const NONE = new Set();

test("bare callback on an idle output is delivered on the idle tick", () => {
  const deps = {
    surfaceHasContentInFlight: () => false,
    surfaceOutputs: () => [0],
    isOutputDirty: () => false,
  };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, NONE), true);
});

test("content in flight defers to the present's flip-complete", () => {
  const deps = {
    surfaceHasContentInFlight: () => true,  // shm upload / dmabuf import pending
    surfaceOutputs: () => [0],
    isOutputDirty: () => false,
  };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, NONE), false);
});

test("a dirty output (present pending) defers to its flip-complete", () => {
  const deps = {
    surfaceHasContentInFlight: () => false,
    surfaceOutputs: () => [0],
    isOutputDirty: (o) => o === 0,
  };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, NONE), false);
});

test("an output with a flip in flight defers to its flip-complete", () => {
  const deps = {
    surfaceHasContentInFlight: () => false,
    surfaceOutputs: () => [0],
    isOutputDirty: () => false,
  };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, new Set([0])), false);
});

test("delivered only when EVERY resident output is idle", () => {
  const deps = {
    surfaceHasContentInFlight: () => false,
    surfaceOutputs: () => [0, 1],
    isOutputDirty: (o) => o === 1,  // one of two outputs is presenting
  };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, NONE), false);
});

test("mapped-but-off-screen ([] residency) waits for a flip-complete", () => {
  const deps = {
    surfaceHasContentInFlight: () => false,
    surfaceOutputs: () => [],
    isOutputDirty: () => false,
  };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, NONE), false);
});

test("a stub compositor with no residency info delivers", () => {
  // surfaceOutputs absent -> harness/back-compat path delivers immediately.
  const deps = { surfaceHasContentInFlight: () => false };
  assert.equal(shouldDeliverFrameCallbackIdle(7, deps, NONE), true);
});
