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
    // Selection bridge atoms.
    ATOM_CLIPBOARD,
    ATOM_PRIMARY,
    ATOM_TARGETS,
    ATOM_TIMESTAMP,
    ATOM_INCR,
    ATOM_TEXT,
    ATOM_STRING,
    ATOM_MULTIPLE,
    ATOM_DELETE,
    ATOM_CLIPBOARD_MANAGER,
    // The compositor's per-selection destination property (where converted
    // selection bytes land on incoming transfers and where outgoing
    // selection replies are written by us). Unique-per-WM name so it does
    // not collide with the client's own property atoms.
    ATOM_OVERDRAW_SELECTION,
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
        XfixesSelectionNotify, // an X client changed selection ownership
        SelectionRequest, // an X requestor wants our selection's bytes
        SelectionNotify,  // reply to one of our ConvertSelection requests
        AtomNameReply,    // async reply to a prior xwmGetAtomName call
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
    uint32_t cookieId = 0;     // PropertyReply / AtomNameReply: cookie returned by
                               // xwmGetProperty / xwmGetAtomName
    uint8_t format = 0;        // PropertyReply: 0 / 8 / 16 / 32
    const uint8_t* data = nullptr;  // PropertyReply / AtomNameReply: borrowed
                                    // bytes, valid only during cb()
    uint32_t length = 0;       // PropertyReply / AtomNameReply: byte length of `data`
    // PropertyNotify only: 0 = NewValue (set / appended), 1 = Delete (removed).
    // The selection-bridge incoming INCR pump fires on NewValue (next chunk
    // arrived); the outgoing INCR pump fires on Delete (requestor consumed
    // the previous chunk and is ready for more).
    uint8_t propertyState = 0;
    // SelectionRequest / SelectionNotify / XfixesSelectionNotify:
    //   selection       = the selection atom (CLIPBOARD / PRIMARY / XdndSelection)
    //   target          = the requested target atom (TARGETS, a mime atom, ...)
    //   property        = the requestor's destination property atom
    //   requestor       = the X window receiving the bytes (SelectionRequest)
    //                     or our window that asked for them (SelectionNotify)
    //   selectionOwner  = the new selection owner window (XfixesSelectionNotify)
    //   timestamp       = the X event timestamp
    uint32_t selection = 0;
    uint32_t target = 0;
    uint32_t property = 0;
    uint32_t requestor = 0;
    uint32_t selectionOwner = 0;
    uint32_t timestamp = 0;
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

// ---- Selection bridge primitives. ----
//
// The XWM creates short-lived auxiliary X windows for each selection (one
// owning window per CLIPBOARD / PRIMARY when the wayland side holds the
// selection; one per in-flight ConvertSelection when an X client owns it
// and a wayland receiver is reading the bytes). The TS bridge owns the
// state machine; native exposes only the X primitives.

// Create a 1x1 child of the root with the given event mask (typically
// SUBSTRUCTURE_NOTIFY | PROPERTY_CHANGE). `inputOnly` selects INPUT_ONLY
// vs INPUT_OUTPUT; geometry is fixed -- selection windows do not draw.
// Returns 0 on failure.
uint32_t xwmCreateSelectionWindow(XwmConn* x, uint32_t eventMask, bool inputOnly);

// Destroy a window previously created with xwmCreateSelectionWindow (or any
// WM-owned window). Safe to call on 0.
void xwmDestroyWindow(XwmConn* x, uint32_t window);

// Claim or release an X selection. `window`=0 releases (XCB_NONE).
void xwmSetSelectionOwner(XwmConn* x, uint32_t selectionAtom, uint32_t window,
                          uint32_t timestamp);

// Ask the current selection owner to convert `selection` to `target` and
// write it to `property` on `requestor`. The reply arrives as a
// SelectionNotify XwmEvent.
void xwmConvertSelection(XwmConn* x, uint32_t requestor, uint32_t selection,
                         uint32_t target, uint32_t property,
                         uint32_t timestamp);

// Send a SelectionNotify event to `requestor` -- the reply leg of a
// SelectionRequest we are handling as the selection owner. `property`=0
// means refusal (XCB_NONE).
void xwmSendSelectionNotify(XwmConn* x, uint32_t requestor,
                            uint32_t selection, uint32_t target,
                            uint32_t property, uint32_t timestamp);

// Subscribe to selection-owner-change events on `selectionAtom`. The mask
// is the standard SET_SELECTION_OWNER | SELECTION_WINDOW_DESTROY |
// SELECTION_CLIENT_CLOSE. Events arrive as XfixesSelectionNotify.
void xwmXfixesSelectSelectionInput(XwmConn* x, uint32_t window,
                                   uint32_t selectionAtom, uint32_t mask);

// Synchronously intern an atom by name. Used for MIME-type atoms minted on
// demand. The TS bridge holds a small cache (mime <-> atom) and only calls
// this on cache miss. Synchronous is safe at this point because the call
// site (xfixes-notify or wl set_selection) doesn't carry the deadlock risk
// the per-window property reads do: it does not require Xwayland to make
// progress on its wayland socket to answer.
uint32_t xwmInternAtom(XwmConn* x, const char* name);

// Asynchronously fetch the name of an atom (the reverse direction: an X
// target atom on the wire, e.g. when reading TARGETS from a non-standard
// client). Returns a cookieId; the reply arrives as AtomNameReply.
uint32_t xwmGetAtomName(XwmConn* x, uint32_t atom);

// Flush pending xcb writes. Most request wrappers flush themselves; this
// is for callers that issue several writes back-to-back and want one
// explicit flush.
void xwmFlush(XwmConn* x);

// Replace the event mask on an arbitrary X window. The selection bridge uses
// this to subscribe to PROPERTY_CHANGE on client-owned requestor windows so
// it can observe PropertyNotify(Delete) -- the INCR-continuation signal.
// Selecting events from our connection is independent of any masks the
// owning client has selected (X serves one mask per (window, client) pair).
void xwmSelectWindowEvents(XwmConn* x, uint32_t window, uint32_t mask);

}  // namespace overdraw::xwayland

#endif  // OVERDRAW_XWAYLAND_XWM_H_
