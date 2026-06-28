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

export default function makeVirtualKeyboardManager(_ctx: Ctx): ZwpVirtualKeyboardManagerV1Handler {
  return {
    create_virtual_keyboard(_resource, _seat, _id) {
      // The new zwp_virtual_keyboard_v1 resource dispatches to the child handler
      // below by interface; no per-object state is needed.
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
    destroy(_resource) {
      // No per-object state to release.
    },
  };
}
