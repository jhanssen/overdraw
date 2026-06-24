// Example overdraw config that enables rootless Xwayland.
// Run it:
//   npm run build:js
//   node packages/core/dist/main.js --config examples/xwayland/config.mjs
//
// The launcher prints two lines once startup is done, e.g.:
//   Wayland server listening.
//   run a client with:  WAYLAND_DISPLAY=wayland-N <your-client>
//   Xwayland up; DISPLAY=:50 (pid <n>)
//   run an X client with:  DISPLAY=:50 <x-client>
//
// Point a Wayland client at the printed WAYLAND_DISPLAY:
//   WAYLAND_DISPLAY=wayland-N foot
//
// Point an X11 client at DISPLAY:
//   DISPLAY=:50 xterm        # or xeyes / xclock / xcalc (x11-apps package)
//
// No hotkeys are wired here; Ctrl+C in the launcher terminal to quit.
// See examples/hotkeys/ for a config that binds Mod+Q to compositor.quit etc.

export default {
  xwayland: {
    // Spawn a rootless Xwayland that connects to overdraw as a normal
    // Wayland client. Default is false.
    enabled: true,

    // Explicit X display number. Required: autopick (omit / set null) lets
    // Xwayland scan from :0 upward via -displayfd and can steal a live host
    // session's display. Pick a number well outside the typical 0-9 range.
    displayNumber: 50,

    // Pass `-terminate` to Xwayland so it exits when its last X client
    // disconnects. Defaults to false (Xwayland stays up for the lifetime of
    // the compositor). The launcher does NOT yet re-spawn on demand, so
    // enabling this means no further X clients after the first batch
    // disconnects (until the compositor restarts).
    terminate: false,

    // Path to the Xwayland binary. Omit / null to use `Xwayland` from PATH.
    // xwaylandPath: "/usr/bin/Xwayland",
  },
};
