// wl_seat / wl_pointer / wl_keyboard: route host input to overdraw's own
// clients. Phase 1: pointer only (advertise pointer capability; keyboard
// emission needs the keymap fd path + xkbcommon, deferred).
//
// Host input arrives normalized via the addon onInput callback (output-space
// coords, evdev keycodes). handleInput() hit-tests the WM's window stack to find
// the surface under the pointer, tracks focus, and emits wl_pointer
// enter/leave/motion/button/frame to the wl_pointer(s) of the client that owns
// the focused surface. Coordinates sent to the client are surface-local.

import { signature as seatSig } from '../protocols-gen/wl_seat.js';

const CAP = seatSig.enums.capability.entries; // { pointer:1, keyboard:2, touch:4 }

export default function makeSeat(ctx) {
  // wl_pointer resources grouped by owning client id. A client may have several
  // (one per wl_seat bind); events go to all of that client's pointers.
  const pointersByClient = new Map(); // clientId -> Set<wl_pointer resource>
  const keyboardsByClient = new Map();
  ctx.state.seat = {
    pointersByClient,
    keyboardsByClient,
    focus: null,       // { surfaceId, surfaceRec, clientId } or null
    handleInput,
  };

  function clientPointers(clientId) {
    let s = pointersByClient.get(clientId);
    if (!s) { s = new Set(); pointersByClient.set(clientId, s); }
    return s;
  }

  // Find the topmost window under an output-space point, returning the surface
  // record + its client id, or null.
  function pick(x, y) {
    const win = ctx.state.wm?.windowAt(x, y);
    if (!win) return null;
    const rec = win.surfaceRec;
    if (!rec || rec.destroyed) return null;
    const clientId = ctx.addon.clientId(rec.resource);
    return { win, surfaceId: win.surfaceId, surfaceRec: rec, clientId, rect: win.rect };
  }

  function sendEnter(target, sx, sy) {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_enter(p, serial, target.surfaceRec.resource, sx, sy);
      ctx.events.wl_pointer.send_frame(p);
    }
  }

  function sendLeave(target) {
    const serial = ctx.state.serial();
    for (const p of clientPointers(target.clientId)) {
      if (p.destroyed) continue;
      ctx.events.wl_pointer.send_leave(p, serial, target.surfaceRec.resource);
      ctx.events.wl_pointer.send_frame(p);
    }
  }

  // Route one normalized input event.
  function handleInput(ev) {
    const seat = ctx.state.seat;
    switch (ev.type) {
      case 'pointerMotion':
      case 'pointerEnter': {
        const hit = pick(ev.x, ev.y);
        // Focus change: leave the old surface, enter the new one.
        if (seat.focus && (!hit || hit.surfaceId !== seat.focus.surfaceId)) {
          sendLeave(seat.focus);
          seat.focus = null;
        }
        if (!hit) return;
        const sx = ev.x - hit.rect.x;
        const sy = ev.y - hit.rect.y;
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
      case 'pointerLeave': {
        if (seat.focus) { sendLeave(seat.focus); seat.focus = null; }
        break;
      }
      case 'pointerButton': {
        if (!seat.focus) return;
        const serial = ctx.state.serial();
        const state = ev.pressed ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_button(p, serial, ev.time, ev.button, state);
          ctx.events.wl_pointer.send_frame(p);
        }
        break;
      }
      case 'pointerAxis': {
        if (!seat.focus) return;
        // wl_pointer.axis: 0 = vertical, 1 = horizontal (matches our ev.horizontal).
        const axis = ev.horizontal ? 1 : 0;
        for (const p of clientPointers(seat.focus.clientId)) {
          if (p.destroyed) continue;
          ctx.events.wl_pointer.send_axis(p, ev.time, axis, ev.value);
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

  return {
    // Global bind: advertise capabilities. Pointer only for now.
    bind(resource) {
      ctx.events.wl_seat.send_capabilities(resource, CAP.pointer);
      ctx.events.wl_seat.send_name?.(resource, 'seat0');
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
export function makePointer(ctx) {
  return {
    set_cursor(_resource, _serial, _surface, _hx, _hy) {
      // Client cursor surface not composited yet (software cursor is future).
    },
    release(resource) { cleanup(ctx, resource); },
  };
}

export function makeKeyboard(ctx) {
  return {
    release(resource) { cleanupKb(ctx, resource); },
  };
}

function cleanup(ctx, resource) {
  const seat = ctx.state.seat;
  if (!seat) return;
  const set = seat.pointersByClient.get(resource.__clientId);
  if (set) set.delete(resource);
}
function cleanupKb(ctx, resource) {
  const seat = ctx.state.seat;
  if (!seat) return;
  for (const set of seat.keyboardsByClient.values()) set.delete(resource);
}
