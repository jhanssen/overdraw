// Xwayland orchestrator: spawn a rootless Xwayland that connects to our
// Wayland server as a client and reports the X display it chose. This module
// owns start/stop and the resulting DISPLAY; the X11 window-manager side
// (xwm, surface association, selection) lives in the sibling modules under
// this directory.
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
  // Explicit display number to request. Pass an integer N for Xwayland to
  // bind ":N" (no fallback -- fails hard if taken). Omit to let Xwayland
  // scan from :0 upward via -displayfd alone; the latter can collide with
  // an existing X session and is only appropriate for tests.
  displayNumber?: number;
}

// Start Xwayland and resolve once it reports its X display. Rejects if the
// fork fails (synchronously, surfaced as a rejected promise) or if Xwayland
// exits before becoming ready.
//
// `config.displayNumber` is REQUIRED. Without it, Xwayland's -displayfd
// autopick scans from :0 upward and can steal a live host session's display
// (the socket file gets replaced and the host can no longer connect to its
// own X server). Callers must pick a number (50+ recommended to stay clear
// of typical session ranges). Tests using this must each pick a UNIQUE
// number so parallel runs don't collide on Xwayland's lock files.
export function startXwayland(addon: Addon, config: XwaylandConfig): Promise<XwaylandHandle> {
  return new Promise<XwaylandHandle>((resolve, reject) => {
    if (config.displayNumber === undefined) {
      reject(new Error(
        "startXwayland: `displayNumber` is required (autopick can steal :0 from "
        + "the host session). Pick an integer >= 50, e.g. { displayNumber: 50 }."));
      return;
    }
    try {
      const { pid, wmFd } = addon.xwaylandStart(
        {
          waylandDisplay: config.waylandDisplay,
          ...(config.xwaylandPath !== undefined ? { xwaylandPath: config.xwaylandPath } : {}),
          ...(config.terminate !== undefined ? { terminate: config.terminate } : {}),
          ...(config.enableWm !== undefined ? { enableWm: config.enableWm } : {}),
          displayNumber: config.displayNumber,
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

// Stop Xwayland: synchronous SIGKILL + reap. SIGKILL (not SIGTERM) is
// load-bearing -- the node thread also runs the Wayland server, and Xwayland's
// clean-shutdown path needs that thread to service it, so a synchronous wait
// on SIGTERM deadlocks. See native/xwayland/server.cpp.
export function stopXwayland(addon: Addon, handle: XwaylandHandle): void {
  addon.xwaylandStop(handle.pid);
}
