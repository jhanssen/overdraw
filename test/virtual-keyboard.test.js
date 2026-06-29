import { test } from "node:test";
import assert from "node:assert/strict";

import makeVirtualKeyboardManager, { makeVirtualKeyboard, releaseDeadVirtualKeyboards }
  from "../packages/core/dist/protocols/zwp_virtual_keyboard_manager_v1.js";

// The mock addon hands out keymap ids from registerKeymap (so a device's keys
// carry that id) and records unregisterKeymap calls.
function mkCtx() {
  const injected = [];
  const errors = [];
  const registered = [];      // {fd, size} per registerKeymap call
  const unregistered = [];     // ids passed to unregisterKeymap
  let nextId = 7;              // first id handed out (arbitrary, non-zero)
  const ctx = {
    addon: {
      injectInput: (ev) => injected.push(ev),
      postError: (res, code, msg) => errors.push({ res, code, msg }),
      registerKeymap: (fd, size) => { registered.push({ fd, size }); return nextId++; },
      unregisterKeymap: (id) => unregistered.push(id),
    },
    state: {},
  };
  return { ctx, injected, errors, registered, unregistered };
}

const okFd = () => ({ close() {}, dup() {} });

// A keyboard that has already had its keymap set (the spec precondition for
// key/modifiers). Its registered id is 7 (the first mkCtx hands out).
function keyboardWithKeymap(ctx) {
  const kb = {};
  makeVirtualKeyboard(ctx).keymap(kb, 1, okFd(), 100);
  return kb;
}

test("key: state 1 -> pressed, 0 -> released, tagged with the device keymap id", () => {
  const { ctx, injected } = mkCtx();
  const vk = makeVirtualKeyboard(ctx);
  const kb = keyboardWithKeymap(ctx);
  vk.key(kb, 100, 30, 1);
  vk.key(kb, 101, 30, 0);
  assert.deepEqual(injected[0], { type: "keyboardKey", serial: 0, time: 100, key: 30, pressed: true, keymapId: 7 });
  assert.deepEqual(injected[1], { type: "keyboardKey", serial: 0, time: 101, key: 30, pressed: false, keymapId: 7 });
});

test("modifiers: forwarded as a keyboardModifiers event tagged with the keymap id", () => {
  const { ctx, injected } = mkCtx();
  const kb = keyboardWithKeymap(ctx);   // keymap id 7
  makeVirtualKeyboard(ctx).modifiers(kb, 1, 2, 4, 0);
  assert.deepEqual(injected[0], {
    type: "keyboardModifiers", serial: 0, time: 0,
    modsDepressed: 1, modsLatched: 2, modsLocked: 4, group: 0, keymapId: 7,
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

test("keymap: registers the client keymap and records its id on the device", () => {
  const { ctx, registered } = mkCtx();
  const kb = {};
  const fd = okFd();
  makeVirtualKeyboard(ctx).keymap(kb, 1, fd, 1234);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].fd, fd);
  assert.equal(registered[0].size, 1234);
  assert.equal(kb.__keymapId, 7);
  assert.equal(kb.__hasKeymap, true);
});

test("keymap: re-keymap unregisters the previous keymap first", () => {
  const { ctx, registered, unregistered } = mkCtx();
  const h = makeVirtualKeyboard(ctx);
  const kb = {};
  h.keymap(kb, 1, okFd(), 1);   // id 7
  h.keymap(kb, 1, okFd(), 1);   // id 8, after dropping 7
  assert.deepEqual(unregistered, [7]);
  assert.equal(kb.__keymapId, 8);
  assert.equal(registered.length, 2);
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

test("destroy releases held keys (under the default keymap) and drops the keymap", () => {
  const { ctx, injected, unregistered } = mkCtx();
  const h = makeVirtualKeyboard(ctx);
  const vk = liveKeyboard(ctx);   // keymap id 7
  h.key(vk, 1, 29, 1);            // KEY_LEFTCTRL down (tagged keymapId 7)
  injected.length = 0;
  h.destroy(vk);
  // The release is tagged keymapId 0: the device keymap is being torn down, so
  // the lift goes through the default keymap.
  assert.deepEqual(injected, [{ type: "keyboardKey", serial: 0, time: 0, key: 29, pressed: false, keymapId: 0 }]);
  assert.deepEqual(unregistered, [7]);
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

test("releaseDeadVirtualKeyboards releases a dead device's held keys + drops keymap, once", () => {
  const { ctx, injected, unregistered } = mkCtx();
  const vk = liveKeyboard(ctx);                  // keymap id 7
  makeVirtualKeyboard(ctx).key(vk, 1, 29, 1);    // Ctrl down
  vk.destroyed = true;                           // client died without destroy
  injected.length = 0;
  releaseDeadVirtualKeyboards(ctx);
  assert.deepEqual(injected, [{ type: "keyboardKey", serial: 0, time: 0, key: 29, pressed: false, keymapId: 0 }]);
  assert.deepEqual(unregistered, [7]);
  injected.length = 0;
  unregistered.length = 0;
  releaseDeadVirtualKeyboards(ctx);              // already swept -> no-op
  assert.equal(injected.length, 0);
  assert.equal(unregistered.length, 0);
});
