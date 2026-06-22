// Role-dispatched close. The compositor closes a window by surfaceId without
// knowing whether it is an xdg_toplevel or an xwayland window; this helper
// owns that branch.
//
// For xdg_toplevel we send xdg_toplevel.close. For xwayland the XWM owns the
// decision: WM_PROTOCOLS/WM_DELETE_WINDOW client-message when the client
// advertises it, KillClient as the fallback.

import type { CompositorState } from "./ctx.js";

// Send a close-request to the window backing `surfaceId`. No-op when the
// surface isn't a closable role (e.g. a layer-shell surface), or when the
// XWM isn't running for an xwayland surface.
export function closeSurface(state: CompositorState, surfaceId: number): void {
  for (const s of state.surfaces.values()) {
    if (s.id !== surfaceId) continue;
    if (s.role === "xwayland") {
      state.xwm?.closeBySurfaceId(surfaceId);
      return;
    }
    const tl = s.xdgSurface?.toplevel;
    if (tl && !tl.destroyed) state.events?.xdg_toplevel.send_close(tl);
    return;
  }
}
