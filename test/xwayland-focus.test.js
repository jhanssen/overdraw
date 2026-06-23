// Pure-unit tests for the X-side focus mirror policy in
// packages/core/src/xwayland/focus.ts. Verifies the ICCCM truth table,
// the override-redirect skip, the bookkeeper hand-off, and the FocusIn
// staleness check.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  icccmInputModel,
  planFocusMirror,
  isFocusInStale,
} from "../packages/core/dist/xwayland/focus.js";

// ---- icccmInputModel: the 4 ICCCM cases -----------------------------------

test("icccmInputModel: passive (Input=true, no WM_TAKE_FOCUS) -> SetInputFocus only", () => {
  const m = icccmInputModel(true, false);
  assert.deepEqual(m, { doSetInputFocus: true, doSendTakeFocus: false });
});

test("icccmInputModel: locally-active (Input=true + WM_TAKE_FOCUS) -> both", () => {
  const m = icccmInputModel(true, true);
  assert.deepEqual(m, { doSetInputFocus: true, doSendTakeFocus: true });
});

test("icccmInputModel: globally-active (Input=false + WM_TAKE_FOCUS) -> WM_TAKE_FOCUS only", () => {
  const m = icccmInputModel(false, true);
  assert.deepEqual(m, { doSetInputFocus: false, doSendTakeFocus: true });
});

test("icccmInputModel: no-input (Input=false, no WM_TAKE_FOCUS) -> SetInputFocus (collapsed)", () => {
  // ICCCM says "do nothing" for this combo, but the collapsed two-boolean
  // form falls out to SetInputFocus. Harmless: no-input clients ignore
  // the focus.
  const m = icccmInputModel(false, false);
  assert.deepEqual(m, { doSetInputFocus: true, doSendTakeFocus: false });
});

test("icccmInputModel: input=null defaults to true (per ICCCM)", () => {
  const m = icccmInputModel(null, false);
  assert.deepEqual(m, { doSetInputFocus: true, doSendTakeFocus: false });
});

// ---- planFocusMirror: end-to-end transitions ------------------------------

const BOOK = 0xb00f;

function mkTarget(opts = {}) {
  return {
    window: opts.window ?? 0x100,
    inputHint: opts.inputHint ?? null,
    hasTakeFocus: opts.hasTakeFocus ?? false,
    overrideRedirect: opts.overrideRedirect ?? false,
  };
}

test("planFocusMirror: first focus to a passive window", () => {
  const next = mkTarget({ window: 0x100, inputHint: true });
  const actions = planFocusMirror(null, next, BOOK);
  assert.deepEqual(actions, [
    { kind: "set-input-focus", window: 0x100 },
    { kind: "set-net-active-window", window: 0x100 },
    { kind: "set-state-focused", window: 0x100 },
  ]);
});

test("planFocusMirror: first focus to a locally-active window (TAKE_FOCUS + SetInputFocus)", () => {
  const next = mkTarget({ window: 0x100, inputHint: true, hasTakeFocus: true });
  const actions = planFocusMirror(null, next, BOOK);
  // SetInputFocus before send-take-focus -- the X server's focus state is
  // already correct when the client receives the WM_TAKE_FOCUS message.
  assert.deepEqual(actions, [
    { kind: "set-input-focus", window: 0x100 },
    { kind: "send-take-focus", window: 0x100 },
    { kind: "set-net-active-window", window: 0x100 },
    { kind: "set-state-focused", window: 0x100 },
  ]);
});

test("planFocusMirror: first focus to a globally-active window (TAKE_FOCUS only)", () => {
  const next = mkTarget({ window: 0x100, inputHint: false, hasTakeFocus: true });
  const actions = planFocusMirror(null, next, BOOK);
  assert.deepEqual(actions, [
    { kind: "send-take-focus", window: 0x100 },
    { kind: "set-net-active-window", window: 0x100 },
    { kind: "set-state-focused", window: 0x100 },
  ]);
});

test("planFocusMirror: focus leaves X (next=null) -> bookkeeper + clear active", () => {
  const prev = mkTarget({ window: 0x100, inputHint: true });
  const actions = planFocusMirror(prev, null, BOOK);
  assert.deepEqual(actions, [
    { kind: "clear-state-focused", window: 0x100 },
    { kind: "set-input-focus", window: BOOK },
    { kind: "set-net-active-window", window: 0 },
  ]);
});

test("planFocusMirror: X -> X transition clears outgoing and sets incoming", () => {
  const prev = mkTarget({ window: 0x100, inputHint: true });
  const next = mkTarget({ window: 0x200, inputHint: true });
  const actions = planFocusMirror(prev, next, BOOK);
  assert.deepEqual(actions, [
    { kind: "clear-state-focused", window: 0x100 },
    { kind: "set-input-focus", window: 0x200 },
    { kind: "set-net-active-window", window: 0x200 },
    { kind: "set-state-focused", window: 0x200 },
  ]);
});

test("planFocusMirror: override-redirect window does NOT receive focus mirror", () => {
  // OR windows manage their own focus; the WM stays out of it. When the
  // compositor focuses an OR, the X side parks on the bookkeeper.
  const next = mkTarget({ window: 0x100, overrideRedirect: true });
  const actions = planFocusMirror(null, next, BOOK);
  assert.deepEqual(actions, [
    { kind: "set-input-focus", window: BOOK },
    { kind: "set-net-active-window", window: 0 },
  ]);
});

test("planFocusMirror: outgoing OR window has no state to clear", () => {
  // When focus leaves an OR (we never wrote _NET_WM_STATE_FOCUSED on it),
  // we don't emit a clear-state-focused.
  const prev = mkTarget({ window: 0x100, overrideRedirect: true });
  const next = mkTarget({ window: 0x200, inputHint: true });
  const actions = planFocusMirror(prev, next, BOOK);
  assert.deepEqual(actions, [
    { kind: "set-input-focus", window: 0x200 },
    { kind: "set-net-active-window", window: 0x200 },
    { kind: "set-state-focused", window: 0x200 },
  ]);
});

// ---- isFocusInStale: serial-validation -----------------------------------

test("isFocusInStale: event before last WM focus is stale", () => {
  assert.equal(isFocusInStale(5, 10), true);
});

test("isFocusInStale: event at the same serial is not stale", () => {
  assert.equal(isFocusInStale(10, 10), false);
});

test("isFocusInStale: event after last WM focus is not stale", () => {
  assert.equal(isFocusInStale(11, 10), false);
});

test("isFocusInStale: u16 wraparound -- event slightly past wrap is fresh", () => {
  // last=0xfff0, event=5 (wrapped): forward distance is 21 (5 - 0xfff0 mod 0x10000).
  // Reverse distance (last - event) & 0xffff = 0xffeb, which exceeds 0x8000,
  // so treated as NOT stale (event is newer past wraparound).
  assert.equal(isFocusInStale(5, 0xfff0), false);
});

test("isFocusInStale: u16 wraparound -- event far before wrap is stale", () => {
  // last=10, event=0xfff0: reverse distance 26 -- stale.
  assert.equal(isFocusInStale(0xfff0, 10), true);
});
