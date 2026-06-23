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
#include <vector>

namespace overdraw::xwayland {

// Atoms exposed to TS. The order must match ATOM_NAMES in xwm.cpp; TS receives
// the interned numeric values keyed by these names so its parsers can match
// against type/state/window-type atoms in property data.
//
// Kept here so napi_xwayland.cpp can expose the same name list without
// re-defining it.
enum AtomIndex {
    ATOM_WL_SURFACE_SERIAL = 0,
    ATOM_WM_PROTOCOLS,
    ATOM_WM_DELETE_WINDOW,
    ATOM_WM_TAKE_FOCUS,
    ATOM_WM_STATE,
    ATOM_WM_NAME,
    ATOM_WM_CLASS,
    ATOM_WM_NORMAL_HINTS,
    ATOM_WM_HINTS,
    ATOM_WM_TRANSIENT_FOR,
    ATOM_NET_WM_NAME,
    ATOM_NET_WM_STATE,
    ATOM_NET_WM_WINDOW_TYPE,
    ATOM_NET_WM_PID,
    ATOM_NET_WM_STATE_FULLSCREEN,
    ATOM_NET_WM_STATE_MAXIMIZED_VERT,
    ATOM_NET_WM_STATE_MAXIMIZED_HORZ,
    ATOM_NET_WM_STATE_MODAL,
    ATOM_NET_WM_STATE_FOCUSED,
    ATOM_NET_ACTIVE_WINDOW,
    ATOM_NET_WM_WINDOW_TYPE_NORMAL,
    ATOM_NET_WM_WINDOW_TYPE_DIALOG,
    ATOM_NET_WM_WINDOW_TYPE_UTILITY,
    ATOM_NET_WM_WINDOW_TYPE_MENU,
    ATOM_NET_WM_WINDOW_TYPE_DROPDOWN_MENU,
    ATOM_NET_WM_WINDOW_TYPE_POPUP_MENU,
    ATOM_NET_WM_WINDOW_TYPE_TOOLTIP,
    ATOM_NET_WM_WINDOW_TYPE_COMBO,
    ATOM_UTF8_STRING,
    ATOM_COUNT,
};

const char* atomName(int i);  // names indexed by AtomIndex; ATOM_COUNT range

// A decoded X event handed to the consumer.
struct XwmEvent {
    enum Type {
        Create,
        Destroy,
        MapRequest,
        MapNotify,
        UnmapNotify,
        ConfigureRequest,
        ConfigureNotify,  // X-side geometry changed (root's substructure-notify)
        SurfaceSerial,    // WL_SURFACE_SERIAL client-message (the association join)
        PropertyNotify,   // a watched property on a managed window changed
        PropertyReply,    // async reply to a prior xwmGetProperty call
        FocusIn,          // X-side focus moved to this window (X -> compositor)
    } type;
    uint32_t window = 0;
    int32_t x = 0, y = 0, width = 0, height = 0;
    bool overrideRedirect = false;
    uint64_t serial = 0;       // SurfaceSerial only
    uint32_t eventSequence = 0; // FocusIn only: the X event's sequence number,
                                // for serial validation against lastFocusSeq

    // PropertyNotify / PropertyReply only.
    uint32_t atom = 0;
    uint32_t replyType = 0;    // PropertyReply: the X type atom of the reply
    uint32_t cookieId = 0;     // PropertyReply: the cookie returned by xwmGetProperty
    uint8_t format = 0;        // PropertyReply: 0 / 8 / 16 / 32
    const uint8_t* data = nullptr;  // PropertyReply: borrowed bytes, valid only during cb()
    uint32_t length = 0;       // PropertyReply: byte length of `data`
};

struct XwmConn;  // opaque (defined in xwm.cpp)

// Connect xcb to `wmFd` and become the WM (root event mask + composite redirect
// + atom intern). Returns null on failure (logged to stderr).
XwmConn* xwmConnect(int wmFd);
void xwmDisconnect(XwmConn* x);

// The xcb connection's fd, for polling on the event loop.
int xwmFd(XwmConn* x);

// Drain pending xcb events AND pending property-get replies, decoding each
// into an XwmEvent and invoking `cb`. Returns false if the xcb connection has
// errored (caller should disconnect).
bool xwmProcess(XwmConn* x, const std::function<void(const XwmEvent&)>& cb);

// Interned atom values, indexed by AtomIndex. Stable for the connection's
// lifetime.
uint32_t xwmAtom(XwmConn* x, int idx);

// Request wrappers (XWM -> X), each followed by a flush.
void xwmMapWindow(XwmConn* x, uint32_t window);
void xwmConfigureWindow(XwmConn* x, uint32_t window,
                        int32_t xx, int32_t yy, int32_t w, int32_t h);

// Send a synthetic ConfigureNotify per ICCCM §4.2.3. After the WM picks a
// new rect for the window, X clients (gtk/qt) expect this event to read the
// window's position in root coordinates -- the real ConfigureNotify generated
// by xcb_configure_window reports parent-relative coordinates, which for
// reparented windows are not what apps need for popup placement etc. We send
// the synthetic form unconditionally after a configure so the client always
// has authoritative root-relative geometry.
void xwmSendConfigureNotify(XwmConn* x, uint32_t window,
                            int32_t xx, int32_t yy, int32_t w, int32_t h);

// Issue an async GetProperty. Returns a non-zero cookie id; the reply arrives
// as a PropertyReply XwmEvent (matched by cookieId) during a later xwmProcess.
// `maxLengthWords` is the property data cap in 32-bit words (xcb convention);
// long titles / atom lists may need it raised.
uint32_t xwmGetProperty(XwmConn* x, uint32_t window, uint32_t atom,
                        uint32_t maxLengthWords);

// Send a ClientMessage to `window` of type WM_PROTOCOLS carrying `proto` in
// data[0] (e.g. WM_DELETE_WINDOW or WM_TAKE_FOCUS). The standard ICCCM path.
// `timestamp` goes in data[1]: pass XCB_CURRENT_TIME (0) for messages where
// time doesn't matter (WM_DELETE_WINDOW); a real X timestamp is required for
// WM_TAKE_FOCUS so focus-stealing-prevention in modern clients doesn't drop
// it on the floor.
void xwmSendWmProtocol(XwmConn* x, uint32_t window, uint32_t proto, uint32_t timestamp);

// Force-kill the window's owning client (KillClient). The fallback when the
// client doesn't advertise WM_DELETE_WINDOW.
void xwmKillClient(XwmConn* x, uint32_t window);

// SetInputFocus(window, RevertToPointerRoot, timestamp). Records the request
// sequence on the connection so FocusIn events older than the most recent
// WM-initiated focus change can be filtered out (race-break against an X
// client's own XSetInputFocus that's in flight). Returns the X request
// sequence (the same value stashed as lastFocusSeq).
uint32_t xwmSetInputFocus(XwmConn* x, uint32_t window, uint32_t timestamp);

// Set or replace a property on a window. One-way: no reply. Used for
// _NET_ACTIVE_WINDOW on the root, _NET_WM_STATE_FOCUSED on managed windows,
// etc. `format` is 8/16/32. `nelements` is the count in those units.
void xwmChangeProperty(XwmConn* x, uint32_t window, uint32_t atom,
                       uint32_t type, uint8_t format,
                       const void* data, uint32_t nelements);

// Delete a property on a window (e.g. clear _NET_WM_STATE_FOCUSED on
// unfocus).
void xwmDeleteProperty(XwmConn* x, uint32_t window, uint32_t atom);

// The bookkeeper X window: a 1x1 override-redirect window the XWM creates
// at connect-time to own X-side focus when no managed client should hold
// it. Returns 0 before connect / after disconnect.
uint32_t xwmBookkeeperWindow(XwmConn* x);

// The X screen's root window id (for _NET_ACTIVE_WINDOW property writes).
uint32_t xwmRootWindow(XwmConn* x);

}  // namespace overdraw::xwayland

#endif  // OVERDRAW_XWAYLAND_XWM_H_
