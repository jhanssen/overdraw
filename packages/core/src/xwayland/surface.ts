// Xwayland surface association model (Wayland side). Tracks each
// xwayland_surface_v1 <-> wl_surface binding and the serial -> wl_surface
// registry the XWM consults to pair an X11 window's WL_SURFACE_SERIAL
// client-message with the wl_surface Xwayland created for it.
//
// No xcb here -- pure association bookkeeping. The native XWM (Phase 2 part B)
// reports "X window announced serial S"; lookupBySerial resolves S to the
// wl_surface id so the window can enter the WM. The two halves may arrive in
// either order; the registry simply holds whichever side is known.

import type { Ctx } from "../protocols/ctx.js";
import type { Resource } from "../types.js";

export interface XwaylandSurfaceBinding {
  resource: Resource;     // the xwayland_surface_v1
  surfaceId: number;      // the wl_surface it roles
  serial: bigint | null;  // serial set via set_serial, or null until then
}

export interface XwaylandSurfaceState {
  byResource: Map<Resource, XwaylandSurfaceBinding>;
  bySerial: Map<bigint, number>;   // serial -> wl_surface id (the XWM's join)
}

export function ensureXwaylandState(ctx: Ctx): XwaylandSurfaceState {
  return (ctx.state.xwayland ??= { byResource: new Map(), bySerial: new Map() });
}

// Bind a freshly-created xwayland_surface_v1 to its wl_surface.
export function bindSurface(ctx: Ctx, resource: Resource, surfaceId: number): void {
  ensureXwaylandState(ctx).byResource.set(resource, { resource, surfaceId, serial: null });
}

export type SetSerialResult = "ok" | "already" | "unknown";

// Record the serial for a binding (set_serial). One serial per
// xwayland_surface_v1: a second call returns "already" so the caller posts
// the already_associated protocol error.
//
// Note: the protocol specifies set_serial as double-buffered (applied on the
// wl_surface's next commit). We register on set_serial directly; the serial is
// globally unique either way, so the XWM join is unaffected by the timing.
// Commit-gated application is a future refinement.
export function setSerial(ctx: Ctx, resource: Resource, serial: bigint): SetSerialResult {
  const st = ensureXwaylandState(ctx);
  const b = st.byResource.get(resource);
  if (!b) return "unknown";
  if (b.serial !== null) return "already";
  b.serial = serial;
  st.bySerial.set(serial, b.surfaceId);
  return "ok";
}

// Resolve a serial to its wl_surface id; null if not (yet) known. The point the
// native XWM calls when an X11 window announces its WL_SURFACE_SERIAL.
export function lookupBySerial(ctx: Ctx, serial: bigint): number | null {
  return ctx.state.xwayland?.bySerial.get(serial) ?? null;
}

// Drop the xwayland_surface_v1 binding on destroy. Per spec, existing
// associations are unaffected, so the serial -> surface mapping persists.
export function unbindSurface(ctx: Ctx, resource: Resource): void {
  ctx.state.xwayland?.byResource.delete(resource);
}
