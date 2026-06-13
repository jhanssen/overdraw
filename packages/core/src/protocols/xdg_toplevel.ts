// xdg_toplevel: the application-window role. Tracks title/app_id and routes
// behavioral-state requests (maximize, fullscreen, minimize, min/max size,
// parent) through wm.propose -- which emits window.proposed (interceptable
// by policy plugins) and commits the final state. The next configure carries
// the resolved presentation in its states array.
//
// Interactive move/resize (xdg_toplevel.move / .resize) are still no-ops:
// they require a pointer-grab state machine on the seat, which is separate
// work. show_window_menu also stays a no-op.

import type { XdgToplevelHandler } from "#protocols-gen/xdg_toplevel.js";
import type { Ctx } from "./ctx.js";
import type { Resource } from "../types.js";
import { markWindowChanged } from "./window-changes.js";

export default function makeToplevel(ctx: Ctx): XdgToplevelHandler {
  const rec = (resource: Resource) => ctx.state.toplevels?.get(resource);
  // The surfaceId backing a toplevel (via its xdg_surface -> wl_surface), or null.
  const surfaceIdOf = (resource: Resource): number | null =>
    rec(resource)?.xdgSurface?.surface?.id ?? null;

  // Fire-and-forget propose. The caller is a synchronous wayland request;
  // the proposal accumulates into win.windowState and the next configure
  // (or the deferred initial configure) reflects it. Awaiting would
  // serialize wayland request processing.
  function propose(
    resource: Resource,
    proposal: import("../wm/index.js").WindowStateProposal,
  ): void {
    const id = surfaceIdOf(resource);
    if (id === null || !ctx.state.wm) return;
    void ctx.state.wm.propose(id, proposal, "client-request");
  }

  return {
    set_parent(resource, parent) {
      // `parent` is an xdg_toplevel resource (or null). Resolve to the
      // parent's surfaceId so the WM stores a stable id, not a Resource.
      const parentId = parent ? surfaceIdOf(parent) : null;
      propose(resource, { parent: parentId });
    },
    set_title(resource, title) {
      const t = rec(resource);
      if (!t) return;
      if (t.title === title) return;
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
    move(_resource, _seat, _serial) {},   // interactive move: separate work
    resize(_resource, _seat, _serial, _edges) {},   // interactive resize: separate work
    set_max_size(resource, w, h) {
      // Per spec: 0 means "no limit" on that axis. Translate to null on
      // the constraints field so the layout plugin sees a clear "no upper
      // bound" rather than a 0x0 cap.
      const maxSize = (w === 0 && h === 0) ? null : { width: w, height: h };
      propose(resource, { constraints: { maxSize } });
    },
    set_min_size(resource, w, h) {
      const minSize = (w === 0 && h === 0) ? null : { width: w, height: h };
      propose(resource, { constraints: { minSize } });
    },
    set_maximized(resource) {
      propose(resource, { presentation: "maximized" });
    },
    unset_maximized(resource) {
      // Spec: "after this request, the compositor will respond by emitting
      // a configure event without the maximized state." We go back to
      // managed (the default tiled state). If the client also wanted
      // floating, it must propose that separately.
      propose(resource, { presentation: "managed" });
    },
    set_fullscreen(resource, _output) {
      // `_output` is optional: when present, the client requests fullscreen
      // on a specific output. Multi-output is not yet supported (wl_output
      // is fabricated); ignore the hint and fullscreen on the single
      // output.
      propose(resource, { presentation: "fullscreen" });
    },
    unset_fullscreen(resource) {
      propose(resource, { presentation: "managed" });
    },
    set_minimized(resource) {
      propose(resource, { presentation: "minimized" });
    },
    destroy(resource) {
      ctx.state.toplevels?.delete(resource);
    },
  };
}
