// xdg_toplevel: the application-window role. Tracks title/app_id and accepts the
// state requests. WM/policy (placement, focus, maximize) is not implemented; for
// first light we record intent and otherwise no-op.

import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";

export default function makeToplevel(ctx: Ctx) {
  const rec = (resource: Resource) => ctx.state.toplevels?.get(resource);

  return {
    set_parent(_resource: Resource, _parent: Resource) {},
    set_title(resource: Resource, title: string) {
      const t = rec(resource);
      if (t) t.title = title;
    },
    set_app_id(resource: Resource, appId: string) {
      const t = rec(resource);
      if (t) t.appId = appId;
    },
    show_window_menu(_resource: Resource, _seat: Resource, _serial: number, _x: number, _y: number) {},
    move(_resource: Resource, _seat: Resource, _serial: number) {},
    resize(_resource: Resource, _seat: Resource, _serial: number, _edges: number) {},
    set_max_size(_resource: Resource, _w: number, _h: number) {},
    set_min_size(_resource: Resource, _w: number, _h: number) {},
    set_maximized(_resource: Resource) {},
    unset_maximized(_resource: Resource) {},
    set_fullscreen(_resource: Resource, _output: Resource) {},
    unset_fullscreen(_resource: Resource) {},
    set_minimized(_resource: Resource) {},
    destroy(resource: Resource) {
      ctx.state.toplevels?.delete(resource);
    },
  };
}
