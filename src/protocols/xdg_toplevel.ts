// xdg_toplevel: the application-window role. Tracks title/app_id and accepts the
// state requests. WM/policy (placement, focus, maximize) is not implemented; for
// first light we record intent and otherwise no-op.

import type { XdgToplevelHandler } from "#protocols-gen/xdg_toplevel.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import { markWindowChanged } from "./window-changes.js";

export default function makeToplevel(ctx: Ctx): XdgToplevelHandler {
  const rec = (resource: Resource) => ctx.state.toplevels?.get(resource);
  // The surfaceId backing a toplevel (via its xdg_surface -> wl_surface), or null.
  const surfaceIdOf = (resource: Resource): number | null =>
    rec(resource)?.xdgSurface?.surface?.id ?? null;

  return {
    set_parent(_resource, _parent) {},
    set_title(resource, title) {
      const t = rec(resource);
      if (!t) return;
      if (t.title === title) return;   // no-op write: do not emit a spurious change
      t.title = title;
      const id = surfaceIdOf(resource);
      if (id !== null) markWindowChanged(ctx.state, id, "title");
    },
    set_app_id(resource, appId) {
      const t = rec(resource);
      if (!t) return;
      if (t.appId === appId) return;
      t.appId = appId;
      const id = surfaceIdOf(resource);
      if (id !== null) markWindowChanged(ctx.state, id, "appId");
    },
    show_window_menu(_resource, _seat, _serial, _x, _y) {},
    move(_resource, _seat, _serial) {},
    resize(_resource, _seat, _serial, _edges) {},
    set_max_size(_resource, _w, _h) {},
    set_min_size(_resource, _w, _h) {},
    set_maximized(_resource) {},
    unset_maximized(_resource) {},
    set_fullscreen(_resource, _output) {},
    unset_fullscreen(_resource) {},
    set_minimized(_resource) {},
    destroy(resource) {
      ctx.state.toplevels?.delete(resource);
    },
  };
}
