// xdg_wm_base: the shell global. get_xdg_surface promotes a wl_surface into an
// xdg_surface; create_positioner is accepted (popups not implemented). ping/pong
// liveness: the compositor would send ping and expect pong; pong is accepted.

import type { Ctx, XdgSurfaceRecord } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeWmBase(ctx: Ctx) {
  return {
    create_positioner(_resource: Resource, _positioner: Resource) {
      // Positioners drive popup placement; not implemented for first light.
    },
    get_xdg_surface(_resource: Resource, xdgSurface: Resource, surface: Resource) {
      const s = ctx.state.surfaces.get(surface);
      const record: XdgSurfaceRecord = {
        resource: xdgSurface,
        surface: s,
        role: null, // 'toplevel' | 'popup'
        configured: false,
        lastConfigureSerial: 0,
        lastCommitSerial: 0,
      };
      if (s) s.xdgSurface = record;
      // Track by the xdg_surface resource so its handler can find the record.
      ctx.state.xdgSurfaces ??= new Map();
      ctx.state.xdgSurfaces.set(xdgSurface, record);
    },
    pong(_resource: Resource, _serial: number) {
      // Client is alive; clear any pending ping timeout (none tracked yet).
    },
    destroy(_resource: Resource) {},
  };
}
