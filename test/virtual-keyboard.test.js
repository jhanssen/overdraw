import { test } from "node:test";
import assert from "node:assert/strict";

import makeVirtualKeyboardManager, { makeVirtualKeyboard, releaseDeadVirtualKeyboards }
  from "../packages/core/dist/protocols/zwp_virtual_keyboard_manager_v1.js";

function mkCtx() {
  const injected = [];
  const errors = [];
  const ctx = {
    addon: {
      injectInput: (ev) => injected.push(ev),
      postError: (res, code, msg) => errors.push({ res, code, msg }),
    },
    state: {},
  };
  return { ctx, injected, errors };
}

const okFd = () => ({ close() {}, dup() {} });

// A keyboard that has already had its keymap set (the spec precondition for
// key/modifiers).
function keyboardWithKeymap(ctx) {
  const kb = {};
  makeVirtualKeyboard(ctx).keymap(kb, 1, okFd(), 100);
  return kb;
}

test("key: state 1 -> pressed keyboardKey, 0 -> released (after keymap)", () => {
  const { ctx, injected } = mkCtx();
  const vk = makeVirtualKeyboard(ctx);
  const kb = keyboardWithKeymap(ctx);
  vk.key(kb, 100, 30, 1);
  vk.key(kb, 101, 30, 0);
  assert.deepEqual(injected[0], { type: "keyboardKey", serial: 0, time: 100, key: 30, pressed: true });
  assert.deepEqual(injected[1], { type: "keyboardKey", serial: 0, time: 101, key: 30, pressed: false });
});

test("modifiers: forwarded as a keyboardModifiers event (after keymap)", () => {
  const { ctx, injected } = mkCtx();
  const kb = keyboardWithKeymap(ctx);
  makeVirtualKeyboard(ctx).modifiers(kb, 1, 2, 4, 0);
  assert.deepEqual(injected[0], {
    type: "keyboardModifiers", serial: 0, time: 0,
    modsDepressed: 1, modsLatched: 2, modsLocked: 4, group: 0,
  });
});

test("key before keymap posts no_keymap and injects nothing", () => {
  const { ctx, injected, errors } = mkCtx();
  const kb = {};
  makeVirtualKeyboard(ctx).key(kb, 1, 30, 1);
  assert.equal(injected.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 0);   // ZwpVirtualKeyboardV1_Error.no_keymap
  assert.equal(errors[0].res, kb);
});

test("modifiers before keymap posts no_keymap", () => {
  const { ctx, injected, errors } = mkCtx();
  makeVirtualKeyboard(ctx).modifiers({}, 1, 0, 0, 0);
  assert.equal(injected.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 0);
});

test("keymap: the supplied fd is closed", () => {
  const { ctx } = mkCtx();
  let closed = false;
  makeVirtualKeyboard(ctx).keymap({}, 1, { close() { closed = true; }, dup() {} }, 1234);
  assert.equal(closed, true);
});

test("keymap: a throwing close does not propagate", () => {
  const { ctx } = mkCtx();
  assert.doesNotThrow(() =>
    makeVirtualKeyboard(ctx).keymap({}, 1, { close() { throw new Error("taken"); }, dup() {} }, 0));
});

test("manager: create_virtual_keyboard does not throw or inject", () => {
  const { ctx, injected } = mkCtx();
  makeVirtualKeyboardManager(ctx).create_virtual_keyboard({}, {}, {});
  assert.equal(injected.length, 0);
});

// A device registered via the manager (so it tracks held keys), with a keymap.
function liveKeyboard(ctx) {
  const vk = {};
  makeVirtualKeyboardManager(ctx).create_virtual_keyboard({}, {}, vk);
  makeVirtualKeyboard(ctx).keymap(vk, 1, okFd(), 1);
  return vk;
}

test("destroy releases keys the device still holds (no stuck modifier)", () => {
  const { ctx, injected } = mkCtx();
  const h = makeVirtualKeyboard(ctx);
  const vk = liveKeyboard(ctx);
  h.key(vk, 1, 29, 1);     // KEY_LEFTCTRL down
  injected.length = 0;
  h.destroy(vk);
  assert.deepEqual(injected, [{ type: "keyboardKey", serial: 0, time: 0, key: 29, pressed: false }]);
});

test("a released key is not released again on destroy", () => {
  const { ctx, injected } = mkCtx();
  const h = makeVirtualKeyboard(ctx);
  const vk = liveKeyboard(ctx);
  h.key(vk, 1, 29, 1);     // down
  h.key(vk, 2, 29, 0);     // up (clean)
  injected.length = 0;
  h.destroy(vk);
  assert.equal(injected.length, 0);
});

test("releaseDeadVirtualKeyboards releases a dead device's held keys, once", () => {
  const { ctx, injected } = mkCtx();
  const vk = liveKeyboard(ctx);
  makeVirtualKeyboard(ctx).key(vk, 1, 29, 1);   // Ctrl down
  vk.destroyed = true;                          // client died without destroy
  injected.length = 0;
  releaseDeadVirtualKeyboards(ctx);
  assert.deepEqual(injected, [{ type: "keyboardKey", serial: 0, time: 0, key: 29, pressed: false }]);
  injected.length = 0;
  releaseDeadVirtualKeyboards(ctx);             // already swept -> no-op
  assert.equal(injected.length, 0);
});
