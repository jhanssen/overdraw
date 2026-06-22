// Xwayland server lifecycle: fork/exec a rootless Xwayland that connects to our
// Wayland server as a client. No X11 window manager here -- that is the XWM
// (xwm.{h,cpp}); this file contains no xcb/X11 code.
//
// Readiness is NOT awaited here. Xwayland reports ready by writing its display
// number to the -displayfd pipe, but that only happens once it has completed
// its Wayland handshake with our server -- which runs on the same libuv loop
// the caller is on. Blocking for it here would deadlock. So spawn returns the
// read end of the pipe; the napi layer polls it on the loop (see
// napi_xwayland.cpp).

#ifndef OVERDRAW_XWAYLAND_SERVER_H_
#define OVERDRAW_XWAYLAND_SERVER_H_

#include <string>
#include <sys/types.h>

namespace overdraw::xwayland {

struct XwaylandSpawn {
    pid_t pid = -1;
    int displayReadFd = -1;  // read end of the -displayfd pipe (non-blocking)
    int wmFd = -1;           // our end of the -wm socketpair (xcb connects here),
                             // or -1 when enableWm is false
};

struct XwaylandOptions {
    std::string xwaylandPath;   // binary; empty -> "Xwayland" on PATH
    std::string waylandDisplay; // our wl socket name -> child's WAYLAND_DISPLAY
    // -terminate: Xwayland exits when its last X client disconnects. Off by
    // default so a freshly-spawned server (no clients yet) stays up.
    bool terminate = false;
    // -wm: pass an X11 window-manager socket so the XWM (xcb) can manage
    // windows. Off by default (the Phase 1 lifecycle path needs no WM).
    bool enableWm = false;
    // Explicit display number to request. When >= 0, Xwayland is asked to
    // bind ":N" -- it FAILS HARD if :N is already in use (no fallback). When
    // < 0 (the default), -displayfd alone is used and Xwayland scans from :0
    // upward; that path can collide with an existing X session, which is why
    // production startups SHOULD set a number well outside the common range
    // (e.g. 50).
    int displayNumber = -1;
};

// Fork/exec rootless Xwayland. Returns the pid and the read end of the
// -displayfd pipe (poll it for the readiness/display-number signal). On failure
// pid < 0 and a message is written to stderr.
XwaylandSpawn spawnXwayland(const XwaylandOptions& opts);

// Reap: poll briefly for a clean exit, then SIGKILL + wait. SIGKILL (not
// SIGTERM) is load-bearing -- see server.cpp for the deadlock rationale.
void reapXwayland(pid_t pid);

}  // namespace overdraw::xwayland

#endif  // OVERDRAW_XWAYLAND_SERVER_H_
