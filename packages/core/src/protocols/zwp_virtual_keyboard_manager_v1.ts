// zwp_virtual_keyboard_manager_v1 + zwp_virtual_keyboard_v1: lets a client
// inject synthetic keyboard input. Used by software KVMs (lan-mouse) on the
// RECEIVING machine, alongside the virtual pointer. Each key/modifiers request
// is turned into a normalized InputEvent and fed through addon.injectInput --
// the same sink the host seat uses -- so it flows through the seat's xkb state
// and reaches the keyboard-focused client like real input.
//
// Keymap handling (first cut): the protocol lets the client supply its OWN xkb
// keymap via keymap(format, fd, size). overdraw has a single seat keymap and
// feeds all key events through it, so we currently IGNORE the client keymap and
// forward raw evdev keycodes through the seat's keymap (correct when the
// sender's layout matches; lan-mouse forwards the sender's keymap, usually
// compatible). Honoring per-device keymaps (translate via the client keymap, or
// swap the seat keymap while this device is active) is a later refinement. The
// supplied fd is closed so it does not leak.
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

// Inject a key-up for every key the device still holds, so the seat's xkb state
// (and any focused client) releases them. Snapshots + clears the held set BEFORE
// injecting, because injectInput re-enters the seat (and this function) -- doing
// it first makes the re-entrant pass a no-op instead of recursing.
function releaseHeldKeys(ctx: Ctx, vk: Resource): void {
  const held = vk.__pressedKeys as Set<number> | undefined;
  if (!held || held.size === 0) return;
  const keys = [...held];
  held.clear();
  for (const key of keys) {
    ctx.addon.injectInput({ type: "keyboardKey", serial: 0, time: 0, key, pressed: false });
  }
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
  }
}

export default function makeVirtualKeyboardManager(ctx: Ctx): ZwpVirtualKeyboardManagerV1Handler {
  return {
    create_virtual_keyboard(_resource, _seat, id) {
      id.__pressedKeys = new Set<number>();
      vks(ctx).add(id);
    },
  };
}

export function makeVirtualKeyboard(ctx: Ctx): ZwpVirtualKeyboardV1Handler {
  return {
    keymap(resource, _format, fd, _size) {
      // First cut: ignore the client-supplied keymap contents; forward raw
      // evdev codes through the seat's keymap. Record that a keymap was set
      // (the spec requires it before key/modifiers) and close the fd.
      resource.__hasKeymap = true;
      try { fd.close(); } catch { /* already closed/taken */ }
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
      ctx.addon.injectInput({ type: "keyboardKey", serial: 0, time, key, pressed: state === 1 });
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
      });
    },
    destroy(resource) {
      // Release any keys still held, then drop the device.
      releaseHeldKeys(ctx, resource);
      vks(ctx).delete(resource);
    },
  };
}
