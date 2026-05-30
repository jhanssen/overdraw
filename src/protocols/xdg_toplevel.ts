// xdg_toplevel: the application-window role. Tracks title/app_id and accepts the
// state requests. WM/policy (placement, focus, maximize) is not implemented; for
// first light we record intent and otherwise no-op.

import type { XdgToplevelHandler } from "#protocols-gen/xdg_toplevel.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeToplevel(ctx: Ctx): XdgToplevelHandler {
  const rec = (resource: Resource) => ctx.state.toplevels?.get(resource);

  return {
    set_parent(_resource, _parent) {},
    set_title(resource, title) {
      const t = rec(resource);
      if (t) t.title = title;
    },
    set_app_id(resource, appId) {
      const t = rec(resource);
      if (t) t.appId = appId;
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
