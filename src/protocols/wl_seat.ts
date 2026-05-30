// wl_seat / wl_pointer / wl_keyboard: route host input to overdraw's own
// clients. Phase 1: pointer only (advertise pointer capability; keyboard
// emission needs the keymap fd path + xkbcommon, deferred).
//
// Host input arrives normalized via the addon onInput callback (output-space
// coords, evdev keycodes). handleInput() hit-tests the WM's window stack to find
// the surface under the pointer, tracks focus, and emits wl_pointer
// enter/leave/motion/button/frame to the wl_pointer(s) of the client that owns
// the focused surface. Coordinates sent to the client are surface-local.

import { signature as seatSig } from "#protocols-gen/wl_seat.js";
import type { WlSeatHandler } from "#protocols-gen/wl_seat.js";
import type { WlPointerHandler } from "#protocols-gen/wl_pointer.js";
import type { WlKeyboardHandler } from "#protocols-gen/wl_keyboard.js";
import type { Ctx, SeatFocus } from "./ctx.js";
import type { Resource, InputEvent } from "../types.js";

// `bind` is a synthetic on-bind hook, not a protocol request.
type SeatHandler = WlSeatHandler & { bind(resource: Resource): void };

const CAP = seatSig.enums.capability.entries; // { pointer:1, keyboard:2, touch:4 }

export default function makeSeat(ctx: Ctx): SeatHandler {
  // wl_pointer resources grouped by owning client id. A client may have several
  // (one per wl_seat bind); events go to all of that client's pointers.
  const pointersByClient = new Map<number, Set<Resource>>();
  const keyboardsByClient = new Map<number, Set<Resource>>();

  function clientPointers(clientId: number): Set<Resource> {
    let s = pointersByClient.get(clientId);
    if (!s) { s = new Set(); pointersByClient.set(clientId, s); }
    return s;
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

  function sendEnter(target: SeatFocus, sx: number, sy: number): void {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_enter(p, serial, target.surfaceRec.resource, sx, sy);
      ctx.events.wl_pointer.send_frame(p);
    }
  }

  function sendLeave(target: SeatFocus): void {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_leave(p, serial, target.surfaceRec.resource);
      ctx.events.wl_pointer.send_frame(p);
    }
  }

  // Route one normalized input event.
  function handleInput(ev: InputEvent): void {
    const seat = ctx.state.seat;
    if (!seat) return;
    switch (ev.type) {
      case "pointerMotion":
      case "pointerEnter": {
        const x = ev.x ?? 0;
        const y = ev.y ?? 0;
        const hit = pick(x, y);
        // Focus change: leave the old surface, enter the new one.
        if (seat.focus && (!hit || hit.surfaceId !== seat.focus.surfaceId)) {
          sendLeave(seat.focus);
          seat.focus = null;
        }
        if (!hit) return;
        const sx = x - hit.rect.x;
        const sy = y - hit.rect.y;
        if (!seat.focus) {
          seat.focus = hit;
          sendEnter(hit, sx, sy);
        } else {
          for (const p of clientPointers(hit.clientId)) {
            if (p.destroyed) continue;
            ctx.events.wl_pointer.send_motion(p, ev.time, sx, sy);
            ctx.events.wl_pointer.send_frame(p);
          }
        }
        break;
      }
      case "pointerLeave": {
        if (seat.focus) { sendLeave(seat.focus); seat.focus = null; }
        break;
      }
      case "pointerButton": {
        if (!seat.focus) return;
        const serial = ctx.state.serial();
        const state = ev.pressed ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_button(p, serial, ev.time, ev.button ?? 0, state);
          ctx.events.wl_pointer.send_frame(p);
        }
        break;
      }
      case "pointerAxis": {
        if (!seat.focus) return;
        // wl_pointer.axis: 0 = vertical, 1 = horizontal (matches ev.horizontal).
        const axis = ev.horizontal ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_axis(p, ev.time, axis, ev.value ?? 0);
          ctx.events.wl_pointer.send_frame(p);
        }
        break;
      }
      // pointerFrame from the host is coalesced into our per-event frames above;
      // keyboard* not routed yet (needs keymap fd + xkbcommon).
      default:
        break;
    }
  }

  ctx.state.seat = { pointersByClient, keyboardsByClient, focus: null, handleInput };

  return {
    // Global bind: advertise capabilities. Pointer only for now.
    bind(resource) {
      ctx.events.wl_seat.send_capabilities(resource, CAP.pointer);
      ctx.events.wl_seat.send_name(resource, "seat0");
    },
    get_pointer(resource, pointer) {
      const clientId = ctx.addon.clientId(resource);
      clientPointers(clientId).add(pointer);
      pointer.__clientId = clientId;
    },
    get_keyboard(resource, keyboard) {
      const clientId = ctx.addon.clientId(resource);
      let s = keyboardsByClient.get(clientId);
      if (!s) { s = new Set(); keyboardsByClient.set(clientId, s); }
      s.add(keyboard);
      // No keymap sent yet; keyboard input is not routed in this phase.
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
