// The X11 window manager (XWM): an xcb connection over Xwayland's -wm socket.
// Pure xcb -- no libuv, no N-API, no Wayland. It becomes the WM (substructure
// redirect + composite redirect), interns atoms, decodes X events into a small
// neutral struct, and exposes request wrappers. The loop integration + the
// bridge to TS live in napi_xwayland.cpp; the window-management policy lives in
// TS (src/xwayland/xwm.ts).

#ifndef OVERDRAW_XWAYLAND_XWM_H_
#define OVERDRAW_XWAYLAND_XWM_H_

#include <cstdint>
#include <functional>

namespace overdraw::xwayland {

// A decoded X event handed to the consumer. Minimal for Phase 2; grows as
// Phase 3 adds property / focus / selection handling.
struct XwmEvent {
    enum Type {
        Create,
        Destroy,
        MapRequest,
        MapNotify,
        UnmapNotify,
        ConfigureRequest,
        SurfaceSerial,  // WL_SURFACE_SERIAL client-message (the association join)
    } type;
    uint32_t window = 0;
    int32_t x = 0, y = 0, width = 0, height = 0;
    bool overrideRedirect = false;
    uint64_t serial = 0;  // SurfaceSerial only
};

struct XwmConn;  // opaque (defined in xwm.cpp)

// Connect xcb to `wmFd` and become the WM (root event mask + composite redirect
// + atom intern). Returns null on failure (logged to stderr).
XwmConn* xwmConnect(int wmFd);
void xwmDisconnect(XwmConn* x);

// The xcb connection's fd, for polling on the event loop.
int xwmFd(XwmConn* x);

// Drain pending xcb events, decoding each into an XwmEvent and invoking `cb`.
// Returns false if the xcb connection has errored (caller should disconnect).
bool xwmProcess(XwmConn* x, const std::function<void(const XwmEvent&)>& cb);

// Request wrappers (XWM -> X), each followed by a flush.
void xwmMapWindow(XwmConn* x, uint32_t window);
void xwmConfigureWindow(XwmConn* x, uint32_t window,
                        int32_t xx, int32_t yy, int32_t w, int32_t h);

}  // namespace overdraw::xwayland

#endif  // OVERDRAW_XWAYLAND_XWM_H_
