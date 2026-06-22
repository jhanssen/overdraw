// XWM policy (TS side). Consumes the decoded X events the native XWM
// (native/xwayland/xwm.cpp) delivers, resolves WL_SURFACE_SERIAL to the
// wl_surface Xwayland created, and brings managed windows into overdraw's WM.
//
// No xcb here -- the native side owns the X11 wire; this is window-management
// policy. Phase 2 is intentionally minimal: track windows, allow maps, join
// surfaces by serial, and add mapped+associated toplevels to the WM. The
// geometry round-trip / properties / focus / override-redirect placement are
// Phase 3.

import type { CompositorState } from "../protocols/ctx.js";
import type { Addon } from "../types.js";
import { ensureXwaylandState, lookupBySerial } from "./surface.js";

// The decoded X event shape the native callback delivers (see deliverXwmEvent
// in napi_xwayland.cpp).
export interface XwmEventMsg {
  type:
    | "create"
    | "destroy"
    | "map-request"
    | "map"
    | "unmap"
    | "configure-request"
    | "surface-serial";
  window: number;
  x: number;
  y: number;
  width: number;
  height: number;
  overrideRedirect: boolean;
  serialLo: number;
  serialHi: number;
}

export interface XWindow {
  window: number;             // X11 window id
  x: number;
  y: number;
  width: number;
  height: number;
  overrideRedirect: boolean;
  mapped: boolean;
  surfaceId: number | null;   // resolved via WL_SURFACE_SERIAL
  addedToWm: boolean;
}

export interface Xwm {
  stop(): void;
  windows(): ReadonlyMap<number, XWindow>;  // inspection (tests)
}

export function startXwm(state: CompositorState, addon: Addon, wmFd: number): Xwm {
  const windows = new Map<number, XWindow>();
  // X windows that announced their serial before the wayland side registered
  // it; completed when onSerialRegistered fires for that serial.
  const pendingBySerial = new Map<bigint, XWindow>();

  ensureXwaylandState(state).onSerialRegistered = (serial, surfaceId) => {
    const w = pendingBySerial.get(serial);
    if (!w) return;
    pendingBySerial.delete(serial);
    w.surfaceId = surfaceId;
    maybeManage(w);
  };

  // A non-override-redirect window that is both mapped and associated with a
  // wl_surface enters the WM. (Override-redirect placement is Phase 3.)
  function maybeManage(w: XWindow): void {
    if (w.addedToWm || w.overrideRedirect || !w.mapped || w.surfaceId === null) return;
    const surfRec = state.surfacesById?.get(w.surfaceId);
    if (!surfRec || !state.wm) return;
    state.wm.addWindow(w.surfaceId, surfRec);
    w.addedToWm = true;
  }

  function unmanage(w: XWindow): void {
    if (w.addedToWm && w.surfaceId !== null) state.wm?.unmapWindow(w.surfaceId);
    w.addedToWm = false;
  }

  function onEvent(ev: XwmEventMsg): void {
    switch (ev.type) {
      case "create":
        windows.set(ev.window, {
          window: ev.window, x: ev.x, y: ev.y, width: ev.width, height: ev.height,
          overrideRedirect: ev.overrideRedirect, mapped: false,
          surfaceId: null, addedToWm: false,
        });
        break;
      case "map-request":
        // Allow the window to map; the compositor shows it once content arrives.
        addon.xwmMapWindow(ev.window);
        break;
      case "map": {
        const w = windows.get(ev.window);
        if (w) { w.mapped = true; maybeManage(w); }
        break;
      }
      case "unmap": {
        const w = windows.get(ev.window);
        if (w) { w.mapped = false; unmanage(w); }
        break;
      }
      case "destroy": {
        const w = windows.get(ev.window);
        if (w) unmanage(w);
        windows.delete(ev.window);
        break;
      }
      case "configure-request":
        // Phase 2: honor the client's requested geometry. Compositor-authoritative
        // sizing (and the synthetic ConfigureNotify) is Phase 3.
        addon.xwmConfigureWindow(ev.window, ev.x, ev.y, ev.width, ev.height);
        break;
      case "surface-serial": {
        const serial = (BigInt(ev.serialHi >>> 0) << 32n) | BigInt(ev.serialLo >>> 0);
        const w = windows.get(ev.window);
        if (!w) break;
        const surfaceId = lookupBySerial(state, serial);
        if (surfaceId !== null) { w.surfaceId = surfaceId; maybeManage(w); }
        else pendingBySerial.set(serial, w);  // wayland side not registered yet
        break;
      }
    }
  }

  addon.xwmStart(wmFd, onEvent);
  return {
    stop() { addon.xwmStop(); },
    windows() { return windows; },
  };
}
