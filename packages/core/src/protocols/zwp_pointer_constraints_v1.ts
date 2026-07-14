// zwp_pointer_constraints_v1 + zwp_locked_pointer_v1 + zwp_confined_pointer_v1:
// lets a client lock or confine the pointer to a surface. Used by software KVMs
// (lan-mouse) on the SENDING machine: the capture backend locks the pointer on
// an edge-barrier surface and reads zwp_relative_pointer_v1 motion to detect
// edge crossings.
//
// Activation: a constraint activates when its surface has pointer focus -- and,
// for a lock with a region, only while the pointer is within that region. A
// locked pointer freezes the compositor cursor (addon.setPointerLocked) while
// relative motion keeps flowing; wl_seat suppresses wl_pointer.motion via
// isPointerLocked(). A confined pointer clamps the cursor to the region (or the
// whole surface) via addon.setPointerConfine. Focus changes and region entry
// are delivered by wl_seat through notifyPointerFocus / notifyPointerMotion.
//
// lifetime: oneshot constraints become defunct after their first deactivation
// (they do not reactivate); persistent constraints reactivate when their
// surface regains focus.
//
// already_constrained is posted when a (surface, pointer) pair already has a
// live constraint. set_cursor_position_hint is accepted but not acted on (the
// spec explicitly allows the compositor to ignore the hint). The lock region
// gates activation; for a confined pointer the region is the confinement area.
//
// Safety: if the owning client dies while locked, isPointerLocked() self-heals
// (deactivates a destroyed lock) so the cursor unfreezes on the next motion.

import type { ZwpPointerConstraintsV1Handler } from "#protocols-gen/zwp_pointer_constraints_v1.js";
import { ZwpPointerConstraintsV1_Error } from "#protocols-gen/zwp_pointer_constraints_v1.js";
import type { ZwpLockedPointerV1Handler } from "#protocols-gen/zwp_locked_pointer_v1.js";
import type { ZwpConfinedPointerV1Handler } from "#protocols-gen/zwp_confined_pointer_v1.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import type { Region } from "./region.js";

// lifetime enum: oneshot(1), persistent(2).
const LIFETIME_ONESHOT = 1;

interface LockRec {
  resource: Resource;
  surfaceId: number;
  pointer: Resource;
  kind: "lock" | "confine";
  region: Region | null;       // surface-local; null = whole surface
  oneshot: boolean;
  active: boolean;
  defunct: boolean;            // oneshot already deactivated -> never reactivates
}

interface PCState {
  active: LockRec | null;
  live: Set<LockRec>;
  currentFocus: number | null;
}

const states = new WeakMap<Ctx, PCState>();
function pc(ctx: Ctx): PCState {
  let s = states.get(ctx);
  if (!s) { s = { active: null, live: new Set(), currentFocus: null }; states.set(ctx, s); }
  return s;
}

function surfaceIdOf(ctx: Ctx, surface: Resource): number | null {
  return ctx.state.surfaces?.get(surface)?.id ?? null;
}

// The focused surface's rect in GLASS space (valid only while the
// constraint's surface is focused, which is the activation precondition).
// A content surface's stored rect is in world coordinates; the focus
// carries the camera offset its hit was made with, so glass = world - cam.
// The pointer position and the addon's confine clamp are both glass-space,
// so all the math below happens there.
function focusRect(ctx: Ctx): { x: number; y: number; width: number; height: number } | null {
  const f = ctx.state.seat?.focus;
  if (!f) return null;
  return {
    x: f.rect.x - f.camX, y: f.rect.y - f.camY,
    width: f.rect.width, height: f.rect.height,
  };
}

// Is the cursor within the lock's region? True when there is no region.
function pointerInRegion(ctx: Ctx, lock: LockRec): boolean {
  if (!lock.region) return true;
  const rect = focusRect(ctx);
  const p = ctx.state.seat?.pointerPosition();
  if (!rect || !p) return false;
  return lock.region.contains(p.x - rect.x, p.y - rect.y);
}

// Glass-space confine rects: the region translated to the surface origin, or
// the whole surface when there is no region.
function confineRects(ctx: Ctx, lock: LockRec): Array<{ x: number; y: number; w: number; h: number }> {
  const rect = focusRect(ctx);
  if (!rect) return [];
  if (!lock.region) return [{ x: rect.x, y: rect.y, w: rect.width, h: rect.height }];
  return lock.region.snapshot().map((r) => ({ x: rect.x + r.x, y: rect.y + r.y, w: r.width, h: r.height }));
}

function activate(ctx: Ctx, lock: LockRec): void {
  if (lock.active || lock.defunct) return;
  if (lock.kind === "lock" && !pointerInRegion(ctx, lock)) return;  // region-gated
  const s = pc(ctx);
  if (s.active && s.active !== lock) deactivate(ctx, s.active);
  lock.active = true;
  s.active = lock;
  if (lock.kind === "lock") {
    ctx.addon.setPointerLocked(true);
    ctx.events.zwp_locked_pointer_v1.send_locked(lock.resource);
  } else {
    ctx.addon.setPointerConfine(confineRects(ctx, lock));
    ctx.events.zwp_confined_pointer_v1.send_confined(lock.resource);
  }
}

function deactivate(ctx: Ctx, lock: LockRec): void {
  if (!lock.active) return;
  lock.active = false;
  const s = pc(ctx);
  if (s.active === lock) s.active = null;
  if (lock.kind === "lock") {
    ctx.addon.setPointerLocked(false);
    if (!lock.resource.destroyed) ctx.events.zwp_locked_pointer_v1.send_unlocked(lock.resource);
  } else {
    ctx.addon.setPointerConfine([]);
    if (!lock.resource.destroyed) ctx.events.zwp_confined_pointer_v1.send_unconfined(lock.resource);
  }
  if (lock.oneshot) lock.defunct = true;
}

function create(ctx: Ctx, manager: Resource, id: Resource, surface: Resource,
                pointer: Resource, region: Resource | null, lifetime: number,
                kind: "lock" | "confine"): void {
  const sid = surfaceIdOf(ctx, surface);
  if (sid === null) return;
  const s = pc(ctx);
  for (const rec of s.live) {
    if (!rec.resource.destroyed && rec.surfaceId === sid && rec.pointer === pointer) {
      ctx.addon.postError(manager, ZwpPointerConstraintsV1_Error.already_constrained,
        "pointer already constrained on this surface");
      return;
    }
  }
  const lock: LockRec = {
    resource: id, surfaceId: sid, pointer, kind,
    region: region ? (ctx.state.regions?.get(region)?.clone() ?? null) : null,
    oneshot: lifetime === LIFETIME_ONESHOT,
    active: false, defunct: false,
  };
  id.__lockRec = lock;
  s.live.add(lock);
  // Activate now if the surface is already focused (lan-mouse locks right after
  // the pointer enters its barrier). seat.focus is authoritative here;
  // currentFocus tracks changes for notifyPointerFocus.
  if (ctx.state.seat?.focus?.surfaceId === sid) {
    s.currentFocus = sid;
    activate(ctx, lock);
  }
}

function teardown(ctx: Ctx, resource: Resource): void {
  const lock = resource.__lockRec as LockRec | undefined;
  if (!lock) return;
  deactivate(ctx, lock);
  pc(ctx).live.delete(lock);
}

// Per-frame disconnect sweep (wired in installProtocols alongside the
// other protocol sweeps): a client that vanished never sent the
// destructor request, so its LockRec (and cloned Region) would live
// forever. Deactivate + drop any record whose resource is destroyed.
export function sweepDisconnected(ctx: Ctx): void {
  const s = pc(ctx);
  for (const rec of [...s.live]) {
    if (!rec.resource.destroyed) continue;
    deactivate(ctx, rec);
    s.live.delete(rec);
  }
}

// Read by wl_seat to suppress wl_pointer.motion while the pointer is locked.
// Self-heals: a lock whose client died (resource destroyed) is deactivated so
// the cursor unfreezes on the next motion.
export function isPointerLocked(ctx: Ctx): boolean {
  const a = pc(ctx).active;
  if (a && a.resource.destroyed) { deactivate(ctx, a); return false; }
  return !!(a && a.kind === "lock" && a.active);
}

// wl_seat notifies pointer-focus changes. Deactivate a constraint whose surface
// lost focus; (re)activate live constraints on the newly-focused surface.
export function notifyPointerFocus(ctx: Ctx, surfaceId: number | null): void {
  const s = pc(ctx);
  if (s.currentFocus === surfaceId) return;
  s.currentFocus = surfaceId;
  if (s.active && s.active.surfaceId !== surfaceId) deactivate(ctx, s.active);
  if (surfaceId === null) return;
  for (const lock of s.live) {
    if (lock.surfaceId === surfaceId && !lock.active && !lock.defunct) activate(ctx, lock);
  }
}

// wl_seat notifies pointer motion within the focused surface, so a region-gated
// lock can activate once the pointer enters its region.
export function notifyPointerMotion(ctx: Ctx): void {
  const s = pc(ctx);
  if (s.active || s.currentFocus === null) return;
  for (const lock of s.live) {
    if (lock.surfaceId === s.currentFocus && lock.kind === "lock"
        && !lock.active && !lock.defunct && lock.region) {
      activate(ctx, lock);
    }
  }
}

export default function makePointerConstraints(ctx: Ctx): ZwpPointerConstraintsV1Handler {
  return {
    lock_pointer(resource, id, surface, pointer, region, lifetime) {
      create(ctx, resource, id, surface, pointer, region, lifetime, "lock");
    },
    confine_pointer(resource, id, surface, pointer, region, lifetime) {
      create(ctx, resource, id, surface, pointer, region, lifetime, "confine");
    },
    destroy(_resource) {
      // Destroying the manager does not affect created constraints.
    },
  };
}

export function makeLockedPointer(ctx: Ctx): ZwpLockedPointerV1Handler {
  return {
    set_cursor_position_hint(_resource, _surface_x, _surface_y) {
      // Optional per spec; the compositor is free to ignore the hint.
    },
    set_region(resource, region) {
      const lock = resource.__lockRec as LockRec | undefined;
      if (lock) lock.region = region ? (ctx.state.regions?.get(region)?.clone() ?? null) : null;
    },
    destroy(resource) { teardown(ctx, resource); },
  };
}

export function makeConfinedPointer(ctx: Ctx): ZwpConfinedPointerV1Handler {
  return {
    set_region(resource, region) {
      const lock = resource.__lockRec as LockRec | undefined;
      if (!lock) return;
      lock.region = region ? (ctx.state.regions?.get(region)?.clone() ?? null) : null;
      if (lock.active) ctx.addon.setPointerConfine(confineRects(ctx, lock));  // live update
    },
    destroy(resource) { teardown(ctx, resource); },
  };
}
