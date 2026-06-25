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
export function configureToplevel(ctx: Ctx, xs: XdgSurfaceRecord, width: number, height: number): number | null {
  if (!xs.toplevel) return null;
  const w = Math.max(0, width | 0);
  const h = Math.max(0, height | 0);
  // xdg-shell maximized: "The window geometry specified in the configure event
  // must be obeyed by the client". fullscreen: "the geometry dimensions must
  // be obeyed". A 0x0 size means "client picks", which contradicts those
  // states. Qt enforces the contradiction with a warning and falls back to
  // its own size, so the configured states are ignored on the initial
  // handshake anyway. Suppress size-binding states (maximized, fullscreen,
  // tiled-edges) until the WM has computed a real layout rect; the follow-up
  // configure carries both the size AND the states atomically.
  const sizeUnknown = w === 0 || h === 0;
  const states = buildStatesArray(ctx, xs, sizeUnknown);
  ctx.events.xdg_toplevel.send_configure(xs.toplevel, w, h, states);
  const serial = ctx.state.serial();
  xs.lastConfigureSerial = serial;
  xs.configuredWidth = width;
  xs.configuredHeight = height;
  ctx.events.xdg_surface.send_configure(xs.resource, serial);
  return serial;
}

// Build the xdg_toplevel.configure states[] array from current WM + focus
// state. Order doesn't matter on the wire; clients iterate the array.
//
// `sizeUnknown` is true when the caller is sending a 0x0 (or partially-0) size.
// The size-binding states (maximized, fullscreen, and managed/tiled which we
// model as maximized) require the client to obey the configured geometry per
// xdg-shell. With a 0 size that requirement is contradictory, so suppress
// those states for this configure; the next one (after the WM has computed a
// layout) carries the real size AND the resolved states atomically.
// `activated` is unaffected: it tracks keyboard focus and has no size
// implication, so it ships on every configure.
function buildStatesArray(ctx: Ctx, xs: XdgSurfaceRecord, sizeUnknown: boolean): Uint8Array {
  const states: number[] = [];
  const id = xs.surface?.id;
  // A managed (tiled), non-exclusive window is told it is maximized so the
  // configured size is BINDING -- xdg-shell requires a maximized client to
  // use the given size, whereas a stateless configure size is only advisory
  // and the tiled states alone are advisory too (a media player honors
  // 'maximized' but ignores 'tiled', and otherwise sizes its surface to its
  // content). The four tiled edges are additionally advertised (v2+) so the
  // client suppresses resize affordances on every side.
  //
  // The encoder reads the compositor's DECISION fields (tiling, exclusive,
  // visible) only -- never `clientRequests`. A client that asked maximized
  // but had its request declined by the policy seam sees a configure with
  // no maximized state, matching the spec.
  const tiledOk = (xs.toplevel?.version ?? 0) >= 2;
  if (!sizeUnknown && id !== undefined && ctx.state.wm) {
    const ws = ctx.state.wm.getWindowState(id);
    if (ws) {
      if (ws.exclusive === "maximized") {
        states.push(STATE.maximized);
      } else if (ws.exclusive === "fullscreen") {
        states.push(STATE.fullscreen);
      } else if (ws.tiling === "managed") {
        // Non-exclusive tiled window: maximized + tiled-edges.
        states.push(STATE.maximized);
        if (tiledOk) {
          states.push(STATE.tiled_left, STATE.tiled_right,
                      STATE.tiled_top, STATE.tiled_bottom);
        }
      }
      // tiling === "floating", non-exclusive, visible: no state.
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
        //
        // Spawn-follows-pointer: place the new window on the output the user
        // is currently looking at. Pointer position is in global logical
        // coordinates; map to the output it lies inside. Fall back to the
        // primary when no seat / no pointer position / pointer outside every
        // real output (the non-rectangular coverage gap between monitors).
        // The resolved outputId is stashed on the SurfaceRecord so the
        // window.map emission (in wl_surface.commit's first-content path)
        // carries it without going through the WM.
        let outputId: number | undefined;
        const seat = ctx.state.seat;
        const outputs = ctx.state.outputs;
        if (seat && outputs) {
          const { x, y } = seat.pointerPosition();
          for (const o of outputs.values()) {
            const r = o.logicalPosition;
            const s = o.logicalSize;
            if (x >= r.x && x < r.x + s.width && y >= r.y && y < r.y + s.height) {
              outputId = o.id;
              break;
            }
          }
        }
        xs.surface.spawnOutputId = outputId ?? ctx.state.wm.primaryOutputId();
        ctx.state.wm.addWindow(surfaceId, xs.surface, {
          deferInitialCommit: true,
        });
      } else {
        // No WM (e.g. bare protocol unit tests): fall back to the 0x0 handshake so
        // the client still completes its initial configure/ack.
        configureToplevel(ctx, xs, 0, 0);
      }
    },
    get_popup(resource, popup, parent, positioner) {
      const xs = rec(resource);
      const p = ctx.state.positioners?.get(positioner);
      if (!xs || !p) return;
      // `parent` may be null when the popup is destined to be re-parented to
      // a zwlr_layer_surface_v1 via its get_popup request. In that case the
      // PopupRecord carries parent=null + a layer-parent filled in later;
      // configurePopup defers the configure until that happens.
      const parentXs = parent ? ctx.state.xdgSurfaces?.get(parent) ?? null : null;
      if (parent && !parentXs) return; // parent supplied but lookup failed
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
      // For a NULL-parent popup, configurePopup is a no-op until the
      // zwlr_layer_surface_v1.get_popup request supplies the layer parent.
      configurePopup(ctx, pr);
    },
    set_window_geometry(resource, x, y, w, h) {
      const xs = rec(resource);
      if (xs) xs.geometry = { x, y, width: w, height: h };
    },
    ack_configure(resource, serial) {
      const xs = rec(resource);
      if (!xs) return;
      if (serial === xs.lastConfigureSerial) xs.configured = true;
      // Track the highest acked serial so the WM's resize transaction can tell
      // when a toplevel has accepted a size it asked for (the geometry apply is
      // gated on the matching ack + the buffer commit that follows it).
      if (xs.lastAckedSerial === undefined || serial > xs.lastAckedSerial) {
        xs.lastAckedSerial = serial;
      }
    },
    destroy(resource) {
      const xs = rec(resource);
      if (xs?.surface) xs.surface.xdgSurface = null;
      ctx.state.xdgSurfaces?.delete(resource);
    },
  };
}
