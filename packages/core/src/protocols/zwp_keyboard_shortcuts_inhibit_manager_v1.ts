// zwp_keyboard_shortcuts_inhibit_manager_v1 + zwp_keyboard_shortcuts_inhibitor_v1:
// lets a client ask the compositor to stop intercepting keyboard shortcuts for
// one of its surfaces, so every key (including the compositor's bindings)
// reaches the client. Used by software KVMs (lan-mouse capture) and remote-
// desktop / VM clients that need the full keyboard.
//
// An inhibitor is "active" while its surface holds keyboard focus; `active` /
// `inactive` track that transition. While the keyboard-focused surface has an
// active inhibitor, wl_seat.ts skips the binding chain (forwarding keys to the
// client). VT-switch is handled before the binding chain and stays effective.

import type { ZwpKeyboardShortcutsInhibitManagerV1Handler } from "#protocols-gen/zwp_keyboard_shortcuts_inhibit_manager_v1.js";
import { ZwpKeyboardShortcutsInhibitManagerV1_Error } from "#protocols-gen/zwp_keyboard_shortcuts_inhibit_manager_v1.js";
import type { ZwpKeyboardShortcutsInhibitorV1Handler } from "#protocols-gen/zwp_keyboard_shortcuts_inhibitor_v1.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

// Inhibitor resources keyed by the surfaceId they inhibit (one seat, so the
// per-(surface,seat) uniqueness the spec requires reduces to per-surface).
const registries = new WeakMap<Ctx, Map<number, Set<Resource>>>();
function inhibitors(ctx: Ctx): Map<number, Set<Resource>> {
  let m = registries.get(ctx);
  if (!m) { m = new Map(); registries.set(ctx, m); }
  return m;
}
function setFor(ctx: Ctx, sid: number): Set<Resource> {
  const m = inhibitors(ctx);
  let s = m.get(sid);
  if (!s) { s = new Set(); m.set(sid, s); }
  return s;
}
function liveInSet(set: Set<Resource> | undefined): boolean {
  if (!set) return false;
  for (const r of set) if (!r.destroyed) return true;
  return false;
}

function focusedSurfaceId(ctx: Ctx): number | undefined {
  return ctx.state.seat?.kbFocus?.surfaceId;
}

// True when the keyboard-focused surface has a live shortcuts inhibitor -- the
// seat then forwards keys to the client without consulting the binding chain.
export function keyboardShortcutsInhibited(ctx: Ctx): boolean {
  const sid = focusedSurfaceId(ctx);
  if (sid === undefined) return false;
  return liveInSet(inhibitors(ctx).get(sid));
}

// On a keyboard-focus change, deactivate the old surface's inhibitors and
// activate the new surface's. Called from the seat's focus path.
export function notifyShortcutsInhibitorFocus(
  ctx: Ctx, prevSurfaceId: number | undefined, nextSurfaceId: number | undefined,
): void {
  if (prevSurfaceId === nextSurfaceId) return;
  const map = inhibitors(ctx);
  if (prevSurfaceId !== undefined) {
    for (const r of map.get(prevSurfaceId) ?? []) {
      if (!r.destroyed && r.__active) {
        ctx.events.zwp_keyboard_shortcuts_inhibitor_v1.send_inactive(r);
        r.__active = false;
      }
    }
  }
  if (nextSurfaceId !== undefined) {
    for (const r of map.get(nextSurfaceId) ?? []) {
      if (!r.destroyed && !r.__active) {
        ctx.events.zwp_keyboard_shortcuts_inhibitor_v1.send_active(r);
        r.__active = true;
      }
    }
  }
}

export default function makeShortcutsInhibitManager(ctx: Ctx): ZwpKeyboardShortcutsInhibitManagerV1Handler {
  return {
    destroy(_resource) { /* destructor; existing inhibitors survive per spec */ },
    inhibit_shortcuts(resource, id, surface, _seat) {
      const sid = ctx.state.surfaces.get(surface)?.id;
      if (sid === undefined) return; // unknown surface; nothing to inhibit
      if (liveInSet(inhibitors(ctx).get(sid))) {
        ctx.addon.postError(resource, ZwpKeyboardShortcutsInhibitManagerV1_Error.already_inhibited,
          "shortcuts already inhibited for this surface and seat");
        return;
      }
      id.__surfaceId = sid;
      id.__active = false;
      setFor(ctx, sid).add(id);
      // If the surface already holds keyboard focus, the inhibitor is active now.
      if (focusedSurfaceId(ctx) === sid) {
        ctx.events.zwp_keyboard_shortcuts_inhibitor_v1.send_active(id);
        id.__active = true;
      }
    },
  };
}

export function makeShortcutsInhibitor(ctx: Ctx): ZwpKeyboardShortcutsInhibitorV1Handler {
  return {
    destroy(resource) {
      const sid = resource.__surfaceId as number | undefined;
      if (sid === undefined) return;
      const map = inhibitors(ctx);
      const set = map.get(sid);
      if (set) { set.delete(resource); if (set.size === 0) map.delete(sid); }
    },
  };
}
