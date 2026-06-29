// zwp_virtual_keyboard_manager_v1 + zwp_virtual_keyboard_v1: lets a client
// inject synthetic keyboard input. Used by software KVMs (lan-mouse) on the
// RECEIVING machine, alongside the virtual pointer. Each key/modifiers request
// is turned into a normalized InputEvent and fed through addon.injectInput --
// the same sink the host seat uses -- so it flows through the seat's xkb state
// and reaches the keyboard-focused client like real input.
//
// Keymap handling: the protocol lets the client supply its OWN xkb keymap via
// keymap(format, fd, size). We compile it (addon.registerKeymap) and tag this
// device's injected keys with the resulting keymap id. The seat makes that
// keymap active before feeding the key, so the device's keys resolve under its
// own layout and its wl_keyboard.modifiers are derived from it -- and the seat
// re-sends that keymap to focused clients on the switch. A real keystroke
// (keymapId 0) switches the seat back to the default keymap. If the supplied
// keymap fails to compile, the device falls back to the default seat keymap.
//
// no_keymap is posted (via ctx.addon.postError) if key/modifiers arrive before
// keymap. unauthorized is not enforced -- every client may create a virtual
// keyboard (no compositor authorization policy).

import type { ZwpVirtualKeyboardManagerV1Handler } from "#protocols-gen/zwp_virtual_keyboard_manager_v1.js";
import type { ZwpVirtualKeyboardV1Handler } from "#protocols-gen/zwp_virtual_keyboard_v1.js";
import { ZwpVirtualKeyboardV1_Error } from "#protocols-gen/zwp_virtual_keyboard_v1.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// Live virtual keyboards per ctx, so a device's still-held keys can be released
// if it is destroyed or its client disconnects without lifting them (otherwise a
// stuck modifier -- e.g. Ctrl -- poisons the shared xkb state and corrupts real
// keyboard input). Each device tracks its pressed evdev keycodes on
// `resource.__pressedKeys`.
const registries = new WeakMap<Ctx, Set<Resource>>();
function vks(ctx: Ctx): Set<Resource> {
  let s = registries.get(ctx);
  if (!s) { s = new Set(); registries.set(ctx, s); }
  return s;
}

// Inject a key-up for every key the device still holds, so any focused client
// is told they lifted. The releases use keymapId 0 (the default keymap): the
// device's own keymap is about to be unregistered and its xkb state discarded
// (so real input can never inherit a stuck modifier), and releasing under the
// default avoids switching focused clients onto a keymap that's vanishing.
// Modifier keycodes are layout-independent, so the client clears correctly.
// Snapshots + clears the held set BEFORE injecting, because injectInput
// re-enters the seat (and this function) -- doing it first makes the re-entrant
// pass a no-op instead of recursing.
function releaseHeldKeys(ctx: Ctx, vk: Resource): void {
  const held = vk.__pressedKeys as Set<number> | undefined;
  if (!held || held.size === 0) return;
  const keys = [...held];
  held.clear();
  for (const key of keys) {
    ctx.addon.injectInput({ type: "keyboardKey", serial: 0, time: 0, key, pressed: false, keymapId: 0 });
  }
}

// Drop a device's compiled keymap from the native registry, if it has one.
function unregisterKeymap(ctx: Ctx, vk: Resource): void {
  const id = vk.__keymapId as number | undefined;
  if (id) ctx.addon.unregisterKeymap(id);
  vk.__keymapId = 0;
}

// Release the held keys of any virtual keyboard whose client died without a
// clean destroy, then drop it. Called both from the seat's per-frame disconnect
// sweep and at the start of real key handling (so a stuck modifier is cleared
// before the next physical keystroke even if no frame ran in between). Removes
// the device from the set BEFORE releasing so the re-entrant injection is a
// no-op.
export function releaseDeadVirtualKeyboards(ctx: Ctx): void {
  const set = vks(ctx);
  for (const vk of [...set]) {
    if (!vk.destroyed) continue;
    set.delete(vk);
    releaseHeldKeys(ctx, vk);
    unregisterKeymap(ctx, vk);
  }
}

export default function makeVirtualKeyboardManager(ctx: Ctx): ZwpVirtualKeyboardManagerV1Handler {
  return {
    create_virtual_keyboard(_resource, _seat, id) {
      id.__pressedKeys = new Set<number>();
      id.__keymapId = 0;
      vks(ctx).add(id);
    },
  };
}

export function makeVirtualKeyboard(ctx: Ctx): ZwpVirtualKeyboardV1Handler {
  return {
    keymap(resource, _format, fd, size) {
      // Compile the client's keymap and remember its id so this device's keys
      // resolve under it. A re-keymap replaces the previous one. registerKeymap
      // takes ownership of the fd; on compile failure it returns 0 and the
      // device falls back to the default seat keymap. Either way a keymap was
      // supplied, satisfying the no_keymap precondition for key/modifiers.
      unregisterKeymap(ctx, resource);
      resource.__keymapId = ctx.addon.registerKeymap(fd, size);
      resource.__hasKeymap = true;
    },
    key(resource, time, key, state) {
      if (!resource.__hasKeymap) {
        ctx.addon.postError(resource, ZwpVirtualKeyboardV1_Error.no_keymap,
          "key sent before keymap");
        return;
      }
      // Track held keys so they can be released if the device dies mid-press.
      const held = resource.__pressedKeys as Set<number> | undefined;
      if (held) { if (state === 1) held.add(key); else held.delete(key); }
      ctx.addon.injectInput({
        type: "keyboardKey", serial: 0, time, key, pressed: state === 1,
        keymapId: (resource.__keymapId as number | undefined) ?? 0,
      });
    },
    modifiers(resource, mods_depressed, mods_latched, mods_locked, group) {
      if (!resource.__hasKeymap) {
        ctx.addon.postError(resource, ZwpVirtualKeyboardV1_Error.no_keymap,
          "modifiers sent before keymap");
        return;
      }
      ctx.addon.injectInput({
        type: "keyboardModifiers", serial: 0, time: 0,
        modsDepressed: mods_depressed, modsLatched: mods_latched,
        modsLocked: mods_locked, group,
        keymapId: (resource.__keymapId as number | undefined) ?? 0,
      });
    },
    destroy(resource) {
      // Release any keys still held, drop its keymap, then drop the device.
      releaseHeldKeys(ctx, resource);
      unregisterKeymap(ctx, resource);
      vks(ctx).delete(resource);
    },
  };
}
