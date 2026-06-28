import { test } from "node:test";
import assert from "node:assert/strict";

import makeVirtualKeyboardManager, { makeVirtualKeyboard }
  from "../packages/core/dist/protocols/zwp_virtual_keyboard_manager_v1.js";

function mkCtx() {
  const injected = [];
  const ctx = { addon: { injectInput: (ev) => injected.push(ev) }, state: {} };
  return { ctx, injected };
}

const RES = {};

test("key: state 1 -> pressed keyboardKey, 0 -> released", () => {
  const { ctx, injected } = mkCtx();
  const vk = makeVirtualKeyboard(ctx);
  vk.key(RES, 100, 30, 1);  // KEY_A pressed
  vk.key(RES, 101, 30, 0);  // KEY_A released
  assert.deepEqual(injected[0], { type: "keyboardKey", serial: 0, time: 100, key: 30, pressed: true });
  assert.deepEqual(injected[1], { type: "keyboardKey", serial: 0, time: 101, key: 30, pressed: false });
});

test("modifiers: forwarded as a keyboardModifiers event", () => {
  const { ctx, injected } = mkCtx();
  makeVirtualKeyboard(ctx).modifiers(RES, 1, 2, 4, 0);
  assert.deepEqual(injected[0], {
    type: "keyboardModifiers", serial: 0, time: 0,
    modsDepressed: 1, modsLatched: 2, modsLocked: 4, group: 0,
  });
});

test("keymap: the supplied fd is closed and nothing is injected", () => {
  const { ctx, injected } = mkCtx();
  let closed = false;
  const fakeFd = { close() { closed = true; }, dup() { throw new Error("unused"); } };
  makeVirtualKeyboard(ctx).keymap(RES, 1, fakeFd, 1234);
  assert.equal(closed, true);
  assert.equal(injected.length, 0);
});

test("keymap: a throwing close does not propagate", () => {
  const { ctx } = mkCtx();
  const fakeFd = { close() { throw new Error("already taken"); }, dup() {} };
  assert.doesNotThrow(() => makeVirtualKeyboard(ctx).keymap(RES, 1, fakeFd, 0));
});

test("manager: create_virtual_keyboard does not throw or inject", () => {
  const { ctx, injected } = mkCtx();
  makeVirtualKeyboardManager(ctx).create_virtual_keyboard(RES, RES, RES);
  assert.equal(injected.length, 0);
});
