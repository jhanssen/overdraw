// wl_seat / wl_pointer / wl_keyboard: route host input to overdraw's own
// clients.
//
// Host input arrives normalized via the addon onInput callback (output-space
// coords, evdev keycodes). handleInput() hit-tests the WM's window stack.
//
// POINTER events (enter/leave/motion/button/axis) always go to the surface under
// the pointer — that is correct Wayland and not a policy choice.
//
// KEYBOARD focus is governed by a configurable policy (FocusOptions):
//   - follow-pointer (default): keyboard focus tracks the pointer-focused window.
//   - click-to-focus: keyboard focus changes on button press and persists when
//     the pointer moves away.
//   - focusOnMap: a freshly-mapped window also takes keyboard focus.

import { signature as seatSig } from "#protocols-gen/wl_seat.js";
import type { WlSeatHandler } from "#protocols-gen/wl_seat.js";
import type { WlPointerHandler } from "#protocols-gen/wl_pointer.js";
import type { WlKeyboardHandler } from "#protocols-gen/wl_keyboard.js";
import type { Ctx, SeatFocus, FocusOptions } from "./ctx.js";
import type { Resource, InputEvent } from "../types.js";

// `bind` is a synthetic on-bind hook, not a protocol request.
type SeatHandler = WlSeatHandler & { bind(resource: Resource): void };

const CAP = seatSig.enums.capability.entries; // { pointer:1, keyboard:2, touch:4 }

const DEFAULT_FOCUS: FocusOptions = { policy: "follow-pointer", focusOnMap: true };

export default function makeSeat(ctx: Ctx, focus: FocusOptions = DEFAULT_FOCUS): SeatHandler {
  // wl_pointer resources grouped by owning client id. A client may have several
  // (one per wl_seat bind); events go to all of that client's pointers.
  const pointersByClient = new Map<number, Set<Resource>>();
  const keyboardsByClient = new Map<number, Set<Resource>>();

  function clientPointers(clientId: number): Set<Resource> {
    let s = pointersByClient.get(clientId);
    if (!s) { s = new Set(); pointersByClient.set(clientId, s); }
    return s;
  }
  function clientKeyboards(clientId: number): Set<Resource> {
    let s = keyboardsByClient.get(clientId);
    if (!s) { s = new Set(); keyboardsByClient.set(clientId, s); }
    return s;
  }
  // Last pointer position (output space), tracked on motion; used for popup
  // click-away dismissal at button-press time (button events carry no position).
  let lastX = 0, lastY = 0;

  // wl_keyboard.enter carries a wl_array of currently-pressed keys; we send empty.
  const EMPTY_KEYS = new Uint8Array(0);

  function sendKbEnter(target: SeatFocus): void {
    const serial = ctx.state.serial();
    for (const k of clientKeyboards(target.clientId)) {
      if (k.destroyed) continue;
      ctx.events.wl_keyboard.send_enter(k, serial, target.surfaceRec.resource, EMPTY_KEYS);
    }
  }
  function sendKbLeave(target: SeatFocus): void {
    const serial = ctx.state.serial();
    for (const k of clientKeyboards(target.clientId)) {
      if (k.destroyed) continue;
      ctx.events.wl_keyboard.send_leave(k, serial, target.surfaceRec.resource);
    }
  }

  // wl_pointer.frame is since v5; sending it to an older binding aborts the
  // client. Gate every frame on the resource's bound version.
  function pointerFrame(p: Resource): void {
    if (p.version >= 5) ctx.events.wl_pointer.send_frame(p);
  }

  // Find the topmost window under an output-space point, returning a focus
  // target (surface + client id + rect), or null.
  function pick(x: number, y: number): SeatFocus | null {
    const win = ctx.state.wm?.windowAt(x, y);
    if (!win) return null;
    const rec = win.surfaceRec;
    if (!rec || rec.resource.destroyed) return null;
    const clientId = ctx.addon.clientId(rec.resource);
    return { surfaceId: win.surfaceId, surfaceRec: rec, clientId, rect: win.rect };
  }

  // Move keyboard focus to `target` (or clear with null). Sends wl_keyboard
  // leave/enter on change. No-op if already focused there.
  function setKbFocus(target: SeatFocus | null): void {
    const seat = ctx.state.seat;
    if (!seat) return;
    const cur = seat.kbFocus;
    if (cur && target && cur.surfaceId === target.surfaceId) return;
    if (cur && (!target || cur.surfaceId !== target.surfaceId)) sendKbLeave(cur);
    seat.kbFocus = target;
    if (target) sendKbEnter(target);
    // Notify the clipboard layer so it can (re)send the selection to the newly
    // focused client (selection follows keyboard focus).
    seat.onKbFocusChange?.(target ? target.clientId : null);
  }

  function sendEnter(target: SeatFocus, sx: number, sy: number): void {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_enter(p, serial, target.surfaceRec.resource, sx, sy);
      pointerFrame(p);
    }
  }

  function sendLeave(target: SeatFocus): void {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_leave(p, serial, target.surfaceRec.resource);
      pointerFrame(p);
    }
  }

  // Route one normalized input event.
  function handleInput(ev: InputEvent): void {
    const seat = ctx.state.seat;
    if (!seat) return;

    // During a drag-and-drop grab, the pointer is owned by the DnD machinery:
    // motion drives data_device enter/leave/motion to the surface under the
    // pointer (NOT wl_pointer), and a button release drops. Normal wl_pointer
    // routing is suppressed for the drag's duration (matches real compositors;
    // GTK in particular relies on the pointer being unfocused during a drag).
    if (seat.drag) {
      if (ev.type === "pointerMotion" || ev.type === "pointerEnter") {
        const x = ev.x ?? 0, y = ev.y ?? 0;
        seat.drag.onMotion(x, y, pick(x, y));
      } else if (ev.type === "pointerButton" && !ev.pressed) {
        seat.drag.onButton(false);
      }
      // Other pointer events are swallowed during the drag.
      return;
    }

    switch (ev.type) {
      case "pointerMotion":
      case "pointerEnter": {
        const x = ev.x ?? 0;
        const y = ev.y ?? 0;
        lastX = x; lastY = y;
        const hit = pick(x, y);
        // POINTER focus follows the pointer (always). Send pointer leave/enter on
        // surface change, motion otherwise.
        if (seat.focus && (!hit || hit.surfaceId !== seat.focus.surfaceId)) {
          sendLeave(seat.focus);
          seat.focus = null;
        }
        if (!hit) {
          // follow-pointer: leaving all windows clears keyboard focus too.
          if (focus.policy === "follow-pointer") setKbFocus(null);
          return;
        }
        const sx = x - hit.rect.x;
        const sy = y - hit.rect.y;
        if (!seat.focus) {
          seat.focus = hit;
          sendEnter(hit, sx, sy);
        } else {
          for (const p of clientPointers(hit.clientId)) {
            if (p.destroyed) continue;
            ctx.events.wl_pointer.send_motion(p, ev.time, sx, sy);
            pointerFrame(p);
          }
        }
        // KEYBOARD focus: follow-pointer tracks the pointer-focused window.
        if (focus.policy === "follow-pointer") setKbFocus(hit);
        break;
      }
      case "pointerLeave": {
        if (seat.focus) { sendLeave(seat.focus); seat.focus = null; }
        // follow-pointer: pointer left the output -> drop keyboard focus.
        if (focus.policy === "follow-pointer") setKbFocus(null);
        break;
      }
      case "pointerButton": {
        // A button press outside a grabbing popup dismisses it (and is swallowed,
        // not delivered to the client under the pointer) -- standard menu behavior.
        if (ev.pressed && ctx.state.dismissGrabbedPopup?.(lastX, lastY)) return;
        if (!seat.focus) return;
        const serial = ctx.state.serial();
        const state = ev.pressed ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_button(p, serial, ev.time, ev.button ?? 0, state);
          pointerFrame(p);
        }
        // click-to-focus: a button press over a window gives it keyboard focus.
        if (focus.policy === "click-to-focus" && ev.pressed) setKbFocus(seat.focus);
        break;
      }
      case "pointerAxis": {
        if (!seat.focus) return;
        // wl_pointer.axis: 0 = vertical, 1 = horizontal (matches ev.horizontal).
        const axis = ev.horizontal ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_axis(p, ev.time, axis, ev.value ?? 0);
          pointerFrame(p);
        }
        break;
      }
      case "keyboardKey": {
        const kb = seat.kbFocus;
        if (!kb) return;
        // Feed xkb state (drives modifiers) and send key + updated modifiers to
        // the keyboard-focused client's keyboard(s). Raw evdev keycode; client
        // interprets via the keymap.
        const pressed = !!ev.pressed;
        const mods = ctx.addon.keyUpdate(ev.key ?? 0, pressed);
        const keySerial = ctx.state.serial();
        const state = pressed ? 1 : 0;
        for (const k of clientKeyboards(kb.clientId)) {
          if (k.destroyed) continue;
          ctx.events.wl_keyboard.send_key(k, keySerial, ev.time, ev.key ?? 0, state);
          const modSerial = ctx.state.serial();
          ctx.events.wl_keyboard.send_modifiers(
            k, modSerial, mods.modsDepressed, mods.modsLatched, mods.modsLocked, mods.group);
        }
        break;
      }
      // keyboardModifiers from the host is not forwarded separately; we derive
      // modifiers from key events via xkb. pointerFrame is coalesced above.
      default:
        break;
    }
  }

  // Give keyboard focus to a freshly-mapped window (focus-on-map). The WM calls
  // this from mapWindow. Under both policies this makes a launched app typeable
  // immediately; it also covers follow-pointer's stationary-pointer-at-map case.
  function focusWindow(
    surfaceId: number, surfaceRec: { resource: Resource },
    rect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!focus.focusOnMap) return;
    if (surfaceRec.resource.destroyed) return;
    const clientId = ctx.addon.clientId(surfaceRec.resource);
    setKbFocus({ surfaceId, surfaceRec, clientId, rect });
  }

  ctx.state.seat = {
    pointersByClient, keyboardsByClient,
    focus: null, kbFocus: null, handleInput, focusWindow,
    pick,
    drag: null,
    // Begin a DnD pointer grab. While set, handleInput routes pointer motion/
    // button to these callbacks instead of wl_pointer (see handleInput). The
    // data-device module supplies onMotion/onButton and clears drag on drop/abort.
    beginDrag(d) {
      // Releasing the normal pointer focus so the dragged-over client doesn't
      // also get wl_pointer events (Wayland convention; some toolkits require it).
      if (seat0?.focus) { sendLeave(seat0.focus); seat0.focus = null; }
      if (seat0) seat0.drag = d;
    },
    endDrag() { if (seat0) seat0.drag = null; },
  };
  const seat0 = ctx.state.seat;

  return {
    // Global bind: advertise pointer + keyboard capabilities.
    bind(resource) {
      ctx.events.wl_seat.send_capabilities(resource, CAP.pointer | CAP.keyboard);
      // wl_seat.name is since v2. Sending it to a v1 bind aborts the client
      // ("listener function for opcode 1 of wl_seat is NULL").
      if (resource.version >= 2) ctx.events.wl_seat.send_name(resource, "seat0");
    },
    get_pointer(resource, pointer) {
      const clientId = ctx.addon.clientId(resource);
      clientPointers(clientId).add(pointer);
      pointer.__clientId = clientId;
    },
    get_keyboard(resource, keyboard) {
      const clientId = ctx.addon.clientId(resource);
      clientKeyboards(clientId).add(keyboard);
      keyboard.__clientId = clientId;
      // Send the keymap so the client can interpret keycodes. Each client gets
      // its own dup of the memfd (a WaylandFd; send_keymap takes the raw fd out).
      const km = ctx.addon.keymapInfo();
      if (km) {
        ctx.events.wl_keyboard.send_keymap(keyboard, km.format, km.fd, km.size);
      }
      // wl_keyboard.repeat_info is since v4.
      if (keyboard.version >= 4) ctx.events.wl_keyboard.send_repeat_info(keyboard, 25, 600);
    },
    get_touch(_resource, _touch) {},
    release(_resource) {},
  };
}

// wl_pointer / wl_keyboard child-resource handlers: just handle release/destroy.
export function makePointer(ctx: Ctx): WlPointerHandler {
  return {
    set_cursor(_resource, _serial, _surface, _hx, _hy) {
      // Client cursor surface not composited yet (software cursor is future).
    },
    release(resource) { cleanup(ctx, resource); },
  };
}

export function makeKeyboard(ctx: Ctx): WlKeyboardHandler {
  return {
    release(resource) { cleanupKb(ctx, resource); },
  };
}

function cleanup(ctx: Ctx, resource: Resource): void {
  const seat = ctx.state.seat;
  if (!seat) return;
  const clientId = resource.__clientId as number | undefined;
  if (clientId === undefined) return;
  const set = seat.pointersByClient.get(clientId);
  if (set) set.delete(resource);
}
function cleanupKb(ctx: Ctx, resource: Resource): void {
  const seat = ctx.state.seat;
  if (!seat) return;
  for (const set of seat.keyboardsByClient.values()) set.delete(resource);
}
