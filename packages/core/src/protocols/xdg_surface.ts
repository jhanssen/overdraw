// xdg_surface: the role-agnostic shell surface. get_toplevel assigns the
// toplevel role and starts the configure handshake (xdg_toplevel.configure then
// xdg_surface.configure with a serial the client must ack_configure). The
// configure sends 0x0 (client picks size) and a states wl_array; for a lone
// window we mark it activated.

import { signature as toplevelSig } from "#protocols-gen/xdg_toplevel.js";
import type { XdgSurfaceHandler } from "#protocols-gen/xdg_surface.js";
import type { Ctx, PopupRecord, XdgSurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";
import { configurePopup } from "./xdg_popup.js";

const STATE = toplevelSig.enums.state.entries; // { maximized:1, activated:4, ... }

// Pack a list of xdg_toplevel state values into the wl_array wire form: a
// contiguous run of host-endian uint32 (libwayland copies the bytes verbatim;
// the client reads them back as uint32). Returned as a Uint8Array.
function packStates(states: number[]): Uint8Array {
  const buf = new ArrayBuffer(states.length * 4);
  new Uint32Array(buf).set(states);
  return new Uint8Array(buf);
}

// Send a sized configure to a toplevel: xdg_toplevel.configure(w, h, states) then
// xdg_surface.configure(serial). The client renders at the given content size and
// acks the serial. Records the configured size on the xdg_surface record so the
// WM can skip redundant configures. This is the WM's ConfigureSink primitive.
//
// width/height are the CONTENT size (the client's drawable area). states
// reflects the window's current presentation: 'maximized' / 'fullscreen' /
// 'activated' (latter when this window has keyboard focus). The wire shape is
// a wl_array of uint32 state values.
export function configureToplevel(ctx: Ctx, xs: XdgSurfaceRecord, width: number, height: number): void {
  if (!xs.toplevel) return;
  const states = buildStatesArray(ctx, xs);
  ctx.events.xdg_toplevel.send_configure(xs.toplevel, Math.max(0, width | 0), Math.max(0, height | 0), states);
  const serial = ctx.state.serial();
  xs.lastConfigureSerial = serial;
  xs.configuredWidth = width;
  xs.configuredHeight = height;
  ctx.events.xdg_surface.send_configure(xs.resource, serial);
}

// Build the xdg_toplevel.configure states[] array from current WM + focus
// state. Order doesn't matter on the wire; clients iterate the array.
function buildStatesArray(ctx: Ctx, xs: XdgSurfaceRecord): Uint8Array {
  const states: number[] = [];
  const id = xs.surface?.id;
  if (id !== undefined && ctx.state.wm) {
    const ws = ctx.state.wm.getWindowState(id);
    if (ws) {
      switch (ws.presentation) {
        case "maximized": states.push(STATE.maximized); break;
        case "fullscreen": states.push(STATE.fullscreen); break;
        // 'managed' and 'minimized' have no corresponding xdg_toplevel
        // state. (Minimized clients aren't expected to render; we just
        // exclude them from the layout.)
      }
    }
  }
  // 'activated' tracks keyboard focus.
  if (id !== undefined && ctx.state.seat?.kbFocus?.surfaceId === id) {
    states.push(STATE.activated);
  }
  return packStates(states);
}

export default function makeXdgSurface(ctx: Ctx): XdgSurfaceHandler {
  const rec = (resource: Resource) => ctx.state.xdgSurfaces?.get(resource);

  return {
    get_toplevel(resource, toplevel) {
      const xs = rec(resource);
      if (!xs) return;
      xs.role = "toplevel";
      xs.toplevel = toplevel;
      ctx.state.toplevels ??= new Map();
      ctx.state.toplevels.set(toplevel, { resource: toplevel, xdgSurface: xs, title: null, appId: null });
      if (xs.surface) xs.surface.role = "xdg_toplevel";

      // Proactive tiling: insert the window into the layout NOW (before it has
      // content) so the WM assigns its tile. The FIRST configure is held
      // until the client's initial commit (wl_surface.commit with no buffer),
      // detected in wl_surface.ts -- this lets a client send set_maximized /
      // set_min_size between get_toplevel and the initial commit, and the
      // single first configure carries the resolved size + states array.
      const surfaceId = xs.surface?.id;
      if (surfaceId !== undefined && xs.surface && ctx.state.wm) {
        // The WM's SurfaceHandle must carry the wl_surface record (its .resource is
        // the wl_surface, used for subsurface child lookup in emitSubtree and for
        // input/client-id routing), NOT the xdg_toplevel resource.
        ctx.state.wm.addWindow(surfaceId, xs.surface, { deferInitialCommit: true });
      } else {
        // No WM (e.g. bare protocol unit tests): fall back to the 0x0 handshake so
        // the client still completes its initial configure/ack.
        configureToplevel(ctx, xs, 0, 0);
      }
    },
    get_popup(resource, popup, parent, positioner) {
      const xs = rec(resource);
      const parentXs = parent ? ctx.state.xdgSurfaces?.get(parent) : undefined;
      const p = ctx.state.positioners?.get(positioner);
      if (!xs || !parentXs || !p) return;
      xs.role = "popup";
      xs.popup = popup;
      if (xs.surface) xs.surface.role = "xdg_popup";
      const pr: PopupRecord = {
        resource: popup, xdgSurface: xs, parent: parentXs,
        rect: { x: 0, y: 0, width: p.width, height: p.height },
        positioner: { ...p }, mapped: false,
      };
      ctx.state.popups ??= new Map();
      ctx.state.popups.set(popup, pr);
      // Compute position + send the configure handshake (popup then xdg_surface).
      configurePopup(ctx, pr);
    },
    set_window_geometry(resource, x, y, w, h) {
      const xs = rec(resource);
      if (xs) xs.geometry = { x, y, width: w, height: h };
    },
    ack_configure(resource, serial) {
      const xs = rec(resource);
      if (xs && serial === xs.lastConfigureSerial) xs.configured = true;
    },
    destroy(resource) {
      const xs = rec(resource);
      if (xs?.surface) xs.surface.xdgSurface = null;
      ctx.state.xdgSurfaces?.delete(resource);
    },
  };
}
