// zwp_relative_pointer_manager_v1 + zwp_relative_pointer_v1: delivers
// unaccelerated relative pointer motion to a client, independent of the
// absolute cursor position. Used by software KVMs (lan-mouse) on the SENDING
// machine: the capture backend locks the pointer (zwp_pointer_constraints_v1)
// and reads relative_motion to detect edge crossings.
//
// A relative pointer is created from a wl_pointer via get_relative_pointer and
// is stashed on that wl_pointer (`__relativePointer`). wl_seat's motion
// dispatch calls dispatchRelativeMotion() for the focused client's pointers,
// which forwards the deltas carried on the InputEvent (libinput backend; 0 on
// the nested backend -- relative motion is KMS-only for now).

import type { ZwpRelativePointerManagerV1Handler } from "#protocols-gen/zwp_relative_pointer_manager_v1.js";
import type { ZwpRelativePointerV1Handler } from "#protocols-gen/zwp_relative_pointer_v1.js";
import type { Ctx } from "./ctx.js";
import type { Resource, InputEvent } from "../types.js";

export default function makeRelativePointerManager(ctx: Ctx): ZwpRelativePointerManagerV1Handler {
  return {
    get_relative_pointer(_resource, id, pointer) {
      // Tie the relative pointer to its wl_pointer; cleanup rides the pointer's
      // lifecycle (a destroyed relative pointer is skipped at dispatch).
      id.__clientId = ctx.addon.clientId(pointer);
      pointer.__relativePointer = id;
    },
    destroy(_resource) {
      // Destroying the manager does not affect created relative pointers.
    },
  };
}

export function makeRelativePointer(_ctx: Ctx): ZwpRelativePointerV1Handler {
  return {
    destroy(_resource) {
      // The wl_pointer's __relativePointer may still point here; dispatch skips
      // it via the destroyed flag.
    },
  };
}

const U32 = 0x100000000;

// Deliver relative_motion to the relative pointers of the given wl_pointers.
// Called from wl_seat's pointer-motion dispatch with the focused client's
// pointer set. The event's deltas (logical pixels) are sent as fixed by the
// wire layer; utime is microseconds split into hi/lo.
export function dispatchRelativeMotion(
  ctx: Ctx, pointers: Iterable<Resource>, ev: InputEvent,
): void {
  const us = (ev.time ?? 0) * 1000;
  const hi = Math.floor(us / U32);
  const lo = us - hi * U32;
  const dx = ev.dx ?? 0;
  const dy = ev.dy ?? 0;
  const dxu = ev.dxUnaccel ?? dx;
  const dyu = ev.dyUnaccel ?? dy;
  for (const p of pointers) {
    const rp = p.__relativePointer as Resource | undefined;
    if (!rp || rp.destroyed) continue;
    ctx.events.zwp_relative_pointer_v1.send_relative_motion(rp, hi, lo, dx, dy, dxu, dyu);
  }
}
