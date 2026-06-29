// xdg_toplevel: the application-window role. Tracks title/app_id and routes
// behavioral-state requests through wm.propose -- which emits window.proposed
// (interceptable by policy plugins) and commits the final state. The next
// configure carries the resolved presentation in its states array.
//
// Interactive move / resize start a pointer grab on the seat (the same
// mechanism the hotkey-initiated grab uses). The serial passed by the
// client must match a recent input serial; stale grab requests are
// dropped silently. show_window_menu remains a no-op (would surface a
// compositor-side menu we don't have).

import type { XdgToplevelHandler } from "#protocols-gen/xdg_toplevel.js";
import { signature as toplevelSig } from "#protocols-gen/xdg_toplevel.js";
import type { Ctx, ResizeEdges } from "./ctx.js";
import type { Resource } from "../types.js";
import { markWindowChanged } from "./window-changes.js";
import { detachSurfaceRole } from "./wl_surface.js";
import { resolveOutputArg } from "./output-resolve.js";

const RESIZE_EDGE = toplevelSig.enums.resize_edge.entries;
//   none=0 top=1 bottom=2 left=4 top_left=5 bottom_left=6
//   right=8 top_right=9 bottom_right=10
const EDGE_MAP: { [k: number]: ResizeEdges } = {
  [RESIZE_EDGE.top]: "top",
  [RESIZE_EDGE.bottom]: "bottom",
  [RESIZE_EDGE.left]: "left",
  [RESIZE_EDGE.right]: "right",
  [RESIZE_EDGE.top_left]: "top-left",
  [RESIZE_EDGE.top_right]: "top-right",
  [RESIZE_EDGE.bottom_left]: "bottom-left",
  [RESIZE_EDGE.bottom_right]: "bottom-right",
};

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

  // Start an interactive move or resize grab on the seat, in response to
  // xdg_toplevel.move / .resize. The serial must reference a recent
  // input event; stale serials are silently dropped (matches the
  // protocol convention used for cursor + popup grabs).
  //
  // Transitions the window to 'floating' presentation if it isn't
  // already (the grab only manipulates floating geometry), captures the
  // current outer rect as the grab's startRect, then calls
  // seat.beginGrab. The seat's motion path drives the floating rect
  // until the client (typically) releases the pointer button -- which
  // also triggers wl_pointer.button.release; clients are expected to
  // observe their own button-up and call... actually no: per
  // xdg-shell, the compositor ENDS the grab when the user releases the
  // button. We need to install a button-release listener that calls
  // endGrab. The simplest path: have the seat itself end the grab on
  // the matching button-up.
  async function beginInteractiveGrab(
    resource: Resource,
    serial: number,
    kind: "move" | "resize",
    edges: ResizeEdges,
  ): Promise<void> {
    const id = surfaceIdOf(resource);
    if (id === null || !ctx.state.wm || !ctx.state.seat) return;
    // Serial validation: accept only serials in [last 256, latest].
    // (Wayland serials are 32-bit and monotonic; "recent" here means
    // issued within the last bounded number of input events. A more
    // strict implementation would track button-press serials
    // explicitly; this is the same approximation popups use today.)
    const latest = ctx.state.nextSerial;
    if (serial === 0 || serial > latest || latest - serial > 256) return;

    const startRect = ctx.state.wm.outerRectOf(id);
    if (!startRect) return;

    // Transition to the floating lane if needed. Interactive
    // move/resize is a compositor decision (user-input), not a client
    // request, so it writes `tiling` directly.
    const ws = ctx.state.wm.getWindowState(id);
    if (ws && ws.tiling !== "floating") {
      await ctx.state.wm.propose(id, { tiling: "floating" }, "user-input");
    }
    if (!ctx.state.seat) return;
    const pos = ctx.state.seat.pointerPosition();
    if (kind === "move") {
      ctx.state.seat.beginGrab({
        kind: "move", surfaceId: id,
        anchorX: pos.x, anchorY: pos.y,
        startRect,
        endOnButtonUp: true,
      });
    } else {
      ctx.state.seat.beginGrab({
        kind: "resize", surfaceId: id,
        anchorX: pos.x, anchorY: pos.y,
        startRect, edges,
        endOnButtonUp: true,
      });
    }
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
    move(resource, _seat, serial) {
      void beginInteractiveGrab(resource, serial, "move", "bottom-right");
    },
    resize(resource, _seat, serial, edges) {
      const e = EDGE_MAP[edges];
      // Per spec: edges=0 (none) is invalid; clients rarely send it.
      // Other invalid bitmask combinations (anything not in EDGE_MAP)
      // are silently dropped -- matches wlroots behavior.
      if (!e) return;
      void beginInteractiveGrab(resource, serial, "resize", e);
    },
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
      // The client wishes to be maximized. The decision (whether to
      // honor) is made by the policy seam in wm.propose -- pre-content
      // requests are suppressed by default; post-content requests are
      // honored by default. A window-rules plugin may override either
      // way via window.proposed / window.preconfigure.
      propose(resource, { clientRequests: { wantsMaximized: true } });
    },
    unset_maximized(resource) {
      // Spec: "after this request, the compositor will respond by
      // emitting a configure event without the maximized state."
      // Clearing the wish lets resolveDecisions revert exclusive to
      // "none" only when the WM is currently in exclusive=maximized
      // (so a floating window prophylactically sending unset_maximized
      // doesn't leak into the tiling lane).
      propose(resource, { clientRequests: { wantsMaximized: false } });
    },
    set_fullscreen(resource, output) {
      propose(resource, { clientRequests: { wantsFullscreen: true } });
      // Optional target output: ask the workspace plugin (which owns output
      // placement) to move the window there. It's already exclusive=fullscreen,
      // so the layout driver fullscreens it on whichever output it lands on.
      if (output) {
        const surfaceId = ctx.state.toplevels?.get(resource)?.xdgSurface.surface?.id;
        const outputId = resolveOutputArg(ctx.state, output);
        if (surfaceId !== undefined && ctx.state.pluginBus)
          ctx.state.pluginBus.emit("window.fullscreen-output-request", { surfaceId, outputId });
      }
    },
    unset_fullscreen(resource) {
      propose(resource, { clientRequests: { wantsFullscreen: false } });
    },
    set_minimized(resource) {
      propose(resource, { clientRequests: { wantsMinimized: true } });
    },
    destroy(resource) {
      // Tear down the WM + compositor + bus state attached to this
      // toplevel BEFORE dropping the toplevel record itself. A client
      // is allowed to destroy xdg_toplevel without destroying its
      // wl_surface (the spec permits re-roling). detachSurfaceRole
      // emits window.unmap, drops the WM entry + compositor stack
      // slot, and resets the wl_surface's mapped flag so a fresh
      // role binding works.
      const t = ctx.state.toplevels?.get(resource);
      const surface = t?.xdgSurface.surface;
      if (surface) detachSurfaceRole(ctx.state, surface);
      ctx.state.toplevels?.delete(resource);
    },
  };
}
