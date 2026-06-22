#include "xwayland/xwm.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

#include <xcb/composite.h>
#include <xcb/xcb.h>
#include <xcb/xcbext.h>  // xcb_poll_for_reply

namespace overdraw::xwayland {

namespace {

// Indexed by AtomIndex. Keep in lockstep with the enum in xwm.h.
const char* const ATOM_NAMES[ATOM_COUNT] = {
    "WL_SURFACE_SERIAL",
    "WM_PROTOCOLS",
    "WM_DELETE_WINDOW",
    "WM_TAKE_FOCUS",
    "WM_STATE",
    "WM_NAME",
    "WM_CLASS",
    "WM_NORMAL_HINTS",
    "WM_HINTS",
    "WM_TRANSIENT_FOR",
    "_NET_WM_NAME",
    "_NET_WM_STATE",
    "_NET_WM_WINDOW_TYPE",
    "_NET_WM_STATE_FULLSCREEN",
    "_NET_WM_STATE_MAXIMIZED_VERT",
    "_NET_WM_STATE_MAXIMIZED_HORZ",
    "_NET_WM_STATE_MODAL",
    "_NET_WM_WINDOW_TYPE_NORMAL",
    "_NET_WM_WINDOW_TYPE_DIALOG",
    "_NET_WM_WINDOW_TYPE_UTILITY",
    "_NET_WM_WINDOW_TYPE_MENU",
    "_NET_WM_WINDOW_TYPE_DROPDOWN_MENU",
    "_NET_WM_WINDOW_TYPE_POPUP_MENU",
    "_NET_WM_WINDOW_TYPE_TOOLTIP",
    "_NET_WM_WINDOW_TYPE_COMBO",
    "UTF8_STRING",
};

// One outstanding xcb_get_property reply. Keyed by `cookieId` on the TS side;
// the xcb sequence number is what xcb_poll_for_reply matches against.
struct PendingProperty {
    uint32_t cookieId = 0;
    uint32_t window = 0;
    uint32_t atom = 0;
    unsigned int sequence = 0;  // xcb cookie's .sequence
};

}  // namespace

const char* atomName(int i) {
    return (i >= 0 && i < ATOM_COUNT) ? ATOM_NAMES[i] : "";
}

struct XwmConn {
    xcb_connection_t* conn = nullptr;
    xcb_screen_t* screen = nullptr;
    xcb_window_t root = 0;
    xcb_atom_t atoms[ATOM_COUNT] = {0};

    // Pending GetProperty replies. Walked every xwmProcess call.
    std::vector<PendingProperty> pending;
    uint32_t nextCookieId = 1;
};

XwmConn* xwmConnect(int wmFd) {
    auto* x = new XwmConn();
    x->conn = xcb_connect_to_fd(wmFd, nullptr);
    if (xcb_connection_has_error(x->conn)) {
        std::fprintf(stderr, "[xwm] xcb_connect_to_fd failed\n");
        xcb_disconnect(x->conn);  // also closes wmFd
        delete x;
        return nullptr;
    }
    x->screen = xcb_setup_roots_iterator(xcb_get_setup(x->conn)).data;
    if (!x->screen) {
        std::fprintf(stderr, "[xwm] no screen\n");
        xcb_disconnect(x->conn);
        delete x;
        return nullptr;
    }
    x->root = x->screen->root;

    // Become the WM: redirect substructure (intercept map/configure requests)
    // and watch child lifecycle + root property changes.
    const uint32_t rootMask = XCB_EVENT_MASK_SUBSTRUCTURE_REDIRECT |
                              XCB_EVENT_MASK_SUBSTRUCTURE_NOTIFY |
                              XCB_EVENT_MASK_PROPERTY_CHANGE;
    xcb_change_window_attributes(x->conn, x->root, XCB_CW_EVENT_MASK, &rootMask);

    // Composite-redirect the root's subwindows (manual) so Xwayland presents
    // each toplevel as its own wl_surface instead of painting the root.
    xcb_composite_redirect_subwindows(x->conn, x->root, XCB_COMPOSITE_REDIRECT_MANUAL);

    // Intern atoms (pipelined: issue all, then collect).
    xcb_intern_atom_cookie_t cookies[ATOM_COUNT];
    for (int i = 0; i < ATOM_COUNT; ++i) {
        cookies[i] = xcb_intern_atom(
            x->conn, 0, static_cast<uint16_t>(std::strlen(ATOM_NAMES[i])), ATOM_NAMES[i]);
    }
    for (int i = 0; i < ATOM_COUNT; ++i) {
        xcb_intern_atom_reply_t* r = xcb_intern_atom_reply(x->conn, cookies[i], nullptr);
        if (r) {
            x->atoms[i] = r->atom;
            free(r);
        }
    }

    xcb_flush(x->conn);
    return x;
}

void xwmDisconnect(XwmConn* x) {
    if (!x) return;
    if (x->conn) xcb_disconnect(x->conn);
    delete x;
}

int xwmFd(XwmConn* x) { return xcb_get_file_descriptor(x->conn); }

uint32_t xwmAtom(XwmConn* x, int idx) {
    if (idx < 0 || idx >= ATOM_COUNT) return 0;
    return x->atoms[idx];
}

namespace {

// Drain any pending GetProperty replies that xcb has already buffered. We poll
// each outstanding cookie; xcb_poll_for_reply does not block. A returned
// reply (or error) consumes that pending entry.
void drainPropertyReplies(XwmConn* x,
                          const std::function<void(const XwmEvent&)>& cb) {
    auto it = x->pending.begin();
    while (it != x->pending.end()) {
        void* reply = nullptr;
        xcb_generic_error_t* err = nullptr;
        const int ready = xcb_poll_for_reply(x->conn, it->sequence, &reply, &err);
        if (ready == 0) { ++it; continue; }  // not yet -- keep pending

        XwmEvent o;
        o.type = XwmEvent::PropertyReply;
        o.window = it->window;
        o.atom = it->atom;
        o.cookieId = it->cookieId;
        if (reply != nullptr) {
            auto* r = static_cast<xcb_get_property_reply_t*>(reply);
            o.replyType = r->type;
            o.format = r->format;
            o.length = static_cast<uint32_t>(xcb_get_property_value_length(r));
            o.data = static_cast<const uint8_t*>(xcb_get_property_value(r));
            cb(o);
            free(reply);
        } else {
            // Error or BadWindow: deliver an empty reply (format=0) so the
            // TS state machine can clear the pending entry.
            cb(o);
            if (err) free(err);
        }
        it = x->pending.erase(it);
    }
}

}  // namespace

bool xwmProcess(XwmConn* x, const std::function<void(const XwmEvent&)>& cb) {
    xcb_generic_event_t* ev;
    while ((ev = xcb_poll_for_event(x->conn))) {
        switch (ev->response_type & 0x7f) {
            case XCB_CREATE_NOTIFY: {
                auto* e = reinterpret_cast<xcb_create_notify_event_t*>(ev);
                // Select per-window events (focus + property changes); this also
                // routes the window's client-messages (incl. WL_SURFACE_SERIAL)
                // to us.
                const uint32_t mask =
                    XCB_EVENT_MASK_FOCUS_CHANGE | XCB_EVENT_MASK_PROPERTY_CHANGE;
                xcb_change_window_attributes(x->conn, e->window, XCB_CW_EVENT_MASK, &mask);
                XwmEvent o;
                o.type = XwmEvent::Create;
                o.window = e->window;
                o.x = e->x;
                o.y = e->y;
                o.width = e->width;
                o.height = e->height;
                o.overrideRedirect = e->override_redirect;
                cb(o);
                break;
            }
            case XCB_DESTROY_NOTIFY: {
                auto* e = reinterpret_cast<xcb_destroy_notify_event_t*>(ev);
                XwmEvent o;
                o.type = XwmEvent::Destroy;
                o.window = e->window;
                cb(o);
                break;
            }
            case XCB_MAP_REQUEST: {
                auto* e = reinterpret_cast<xcb_map_request_event_t*>(ev);
                XwmEvent o;
                o.type = XwmEvent::MapRequest;
                o.window = e->window;
                cb(o);
                break;
            }
            case XCB_MAP_NOTIFY: {
                auto* e = reinterpret_cast<xcb_map_notify_event_t*>(ev);
                XwmEvent o;
                o.type = XwmEvent::MapNotify;
                o.window = e->window;
                o.overrideRedirect = e->override_redirect;
                cb(o);
                break;
            }
            case XCB_UNMAP_NOTIFY: {
                auto* e = reinterpret_cast<xcb_unmap_notify_event_t*>(ev);
                XwmEvent o;
                o.type = XwmEvent::UnmapNotify;
                o.window = e->window;
                cb(o);
                break;
            }
            case XCB_CONFIGURE_REQUEST: {
                auto* e = reinterpret_cast<xcb_configure_request_event_t*>(ev);
                XwmEvent o;
                o.type = XwmEvent::ConfigureRequest;
                o.window = e->window;
                o.x = e->x;
                o.y = e->y;
                o.width = e->width;
                o.height = e->height;
                cb(o);
                break;
            }
            case XCB_PROPERTY_NOTIFY: {
                auto* e = reinterpret_cast<xcb_property_notify_event_t*>(ev);
                XwmEvent o;
                o.type = XwmEvent::PropertyNotify;
                o.window = e->window;
                o.atom = e->atom;
                cb(o);
                break;
            }
            case XCB_CLIENT_MESSAGE: {
                auto* e = reinterpret_cast<xcb_client_message_event_t*>(ev);
                if (e->type == x->atoms[ATOM_WL_SURFACE_SERIAL] && e->format == 32) {
                    const uint32_t lo = e->data.data32[0];
                    const uint32_t hi = e->data.data32[1];
                    XwmEvent o;
                    o.type = XwmEvent::SurfaceSerial;
                    o.window = e->window;
                    o.serial = (static_cast<uint64_t>(hi) << 32) | lo;
                    cb(o);
                }
                break;
            }
            default:
                break;
        }
        free(ev);
    }

    drainPropertyReplies(x, cb);

    return !xcb_connection_has_error(x->conn);
}

void xwmMapWindow(XwmConn* x, uint32_t window) {
    xcb_map_window(x->conn, window);
    xcb_flush(x->conn);
}

void xwmConfigureWindow(XwmConn* x, uint32_t window,
                        int32_t xx, int32_t yy, int32_t w, int32_t h) {
    const uint32_t values[] = {
        static_cast<uint32_t>(xx), static_cast<uint32_t>(yy),
        static_cast<uint32_t>(w), static_cast<uint32_t>(h),
    };
    const uint16_t mask = XCB_CONFIG_WINDOW_X | XCB_CONFIG_WINDOW_Y |
                          XCB_CONFIG_WINDOW_WIDTH | XCB_CONFIG_WINDOW_HEIGHT;
    xcb_configure_window(x->conn, window, mask, values);
    xcb_flush(x->conn);
}

uint32_t xwmGetProperty(XwmConn* x, uint32_t window, uint32_t atom,
                        uint32_t maxLengthWords) {
    // delete=0, type=AnyPropertyType(0), offset=0, long_length=maxLengthWords.
    xcb_get_property_cookie_t c = xcb_get_property(
        x->conn, /*_delete=*/0, window, atom, /*type=*/0,
        /*long_offset=*/0, maxLengthWords);
    xcb_flush(x->conn);
    PendingProperty p;
    p.cookieId = x->nextCookieId++;
    if (p.cookieId == 0) p.cookieId = x->nextCookieId++;  // skip 0 sentinel
    p.window = window;
    p.atom = atom;
    p.sequence = c.sequence;
    x->pending.push_back(p);
    return p.cookieId;
}

void xwmSendWmProtocol(XwmConn* x, uint32_t window, uint32_t proto) {
    xcb_client_message_event_t ev = {};
    ev.response_type = XCB_CLIENT_MESSAGE;
    ev.format = 32;
    ev.window = window;
    ev.type = x->atoms[ATOM_WM_PROTOCOLS];
    ev.data.data32[0] = proto;
    ev.data.data32[1] = XCB_CURRENT_TIME;
    ev.data.data32[2] = 0;
    ev.data.data32[3] = 0;
    ev.data.data32[4] = 0;
    xcb_send_event(x->conn, /*propagate=*/0, window, XCB_EVENT_MASK_NO_EVENT,
                   reinterpret_cast<const char*>(&ev));
    xcb_flush(x->conn);
}

void xwmKillClient(XwmConn* x, uint32_t window) {
    xcb_kill_client(x->conn, window);
    xcb_flush(x->conn);
}

}  // namespace overdraw::xwayland
