// xwayland_shell_v1 / xwayland_surface_v1: lets the Xwayland server associate
// X11 windows to wl_surfaces by serial. This is the Wayland-protocol half of
// the association; the X11 (xcb) half lives in the native XWM. No xcb here.
//
// get_xwayland_surface assigns the "xwayland" role to a wl_surface; set_serial
// records the 64-bit serial the X11 window echoes via its WL_SURFACE_SERIAL
// client-message. See docs/xwayland-design.md "Surface association" and
// src/xwayland/surface.ts.
//
// Note: the spec says only the Xwayland server should bind this global. We
// advertise it to all clients today (the compositor connects Xwayland via
// WAYLAND_DISPLAY and has no client handle to gate on); hiding it from
// non-Xwayland clients is a later refinement (see the design doc's "client
// identity" open question).

import type { Ctx } from "./ctx.js";
import type { XwaylandShellV1Handler } from "#protocols-gen/xwayland_shell_v1.js";
import type { XwaylandSurfaceV1Handler } from "#protocols-gen/xwayland_surface_v1.js";
import { XwaylandShellV1_Error } from "#protocols-gen/xwayland_shell_v1.js";
import { XwaylandSurfaceV1_Error } from "#protocols-gen/xwayland_surface_v1.js";
import { bindSurface, setSerial, unbindSurface } from "../xwayland/surface.js";

export default function makeXwaylandShell(ctx: Ctx): XwaylandShellV1Handler {
  return {
    destroy(_resource) { /* destructor; child objects unaffected */ },
    get_xwayland_surface(resource, id, surface) {
      const s = ctx.state.surfaces.get(surface);
      if (!s) return;  // unknown wl_surface (defensive)
      if (s.role) {
        ctx.addon.postError(resource, XwaylandShellV1_Error.role,
          `xwayland_shell_v1.get_xwayland_surface: wl_surface already has the "${s.role}" role`);
        return;
      }
      s.role = "xwayland";
      bindSurface(ctx, id, s.id);
    },
  };
}

export function makeXwaylandSurface(ctx: Ctx): XwaylandSurfaceV1Handler {
  return {
    destroy(resource) { unbindSurface(ctx, resource); },
    set_serial(resource, serial_lo, serial_hi) {
      // Reassemble the 64-bit serial (lo = low 32 bits, hi = high 32 bits),
      // each half treated as unsigned.
      const serial = (BigInt(serial_hi >>> 0) << 32n) | BigInt(serial_lo >>> 0);
      if (serial === 0n) {
        ctx.addon.postError(resource, XwaylandSurfaceV1_Error.invalid_serial,
          "xwayland_surface_v1.set_serial: serial must be non-zero");
        return;
      }
      if (setSerial(ctx, resource, serial) === "already") {
        ctx.addon.postError(resource, XwaylandSurfaceV1_Error.already_associated,
          "xwayland_surface_v1.set_serial: wl_surface already associated");
      }
    },
  };
}
