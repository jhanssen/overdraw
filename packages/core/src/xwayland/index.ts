// Xwayland orchestrator. Phase 1 is lifecycle only: spawn a rootless Xwayland
// that connects to our Wayland server as a client and reports the X display it
// chose. The X11 window-manager side (xwm, surface association, selection) and
// the `xwayland_shell_v1` global land in later phases; this module owns
// start/stop and the resulting DISPLAY.
//
// All X11/xcb work is native and lives under native/xwayland/; this file only
// drives the lifecycle through the addon binding -- no Wayland-protocol code.

import type { Addon } from "../types.js";

export interface XwaylandHandle {
  pid: number;
  display: string;       // ":N" -- export as DISPLAY for X clients
  displayNumber: number;
  wmFd: number;          // the XWM's xcb fd (-1 unless enableWm); pass to startXwm
}

export interface XwaylandConfig {
  // The compositor's Wayland socket name (e.g. addon.startServer() result);
  // handed to Xwayland as WAYLAND_DISPLAY.
  waylandDisplay: string;
  xwaylandPath?: string;
  terminate?: boolean;
  enableWm?: boolean;    // pass -wm so the XWM (startXwm) can manage windows
}

// Start Xwayland and resolve once it reports its X display. Rejects if the
// fork fails (synchronously, surfaced as a rejected promise) or if Xwayland
// exits before becoming ready.
export function startXwayland(addon: Addon, config: XwaylandConfig): Promise<XwaylandHandle> {
  return new Promise<XwaylandHandle>((resolve, reject) => {
    try {
      const { pid, wmFd } = addon.xwaylandStart(
        {
          waylandDisplay: config.waylandDisplay,
          ...(config.xwaylandPath !== undefined ? { xwaylandPath: config.xwaylandPath } : {}),
          ...(config.terminate !== undefined ? { terminate: config.terminate } : {}),
          ...(config.enableWm !== undefined ? { enableWm: config.enableWm } : {}),
        },
        (err, infoArg) => {
          if (err || !infoArg) {
            reject(new Error(`Xwayland failed to start: ${err ?? "unknown"}`));
            return;
          }
          resolve({ pid, wmFd, display: infoArg.display, displayNumber: infoArg.displayNumber });
        },
      );
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

// Stop Xwayland (SIGTERM + reap).
export function stopXwayland(addon: Addon, handle: XwaylandHandle): void {
  addon.xwaylandStop(handle.pid);
}
