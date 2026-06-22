#include "xwayland/xwm.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <xcb/composite.h>
#include <xcb/xcb.h>

namespace overdraw::xwayland {

namespace {

// Atoms interned at startup.
enum AtomIndex {
    ATOM_WL_SURFACE_SERIAL,
    ATOM_WM_PROTOCOLS,
    ATOM_WM_DELETE_WINDOW,
    ATOM_COUNT,
};
const char* const ATOM_NAMES[ATOM_COUNT] = {
    "WL_SURFACE_SERIAL",
    "WM_PROTOCOLS",
    "WM_DELETE_WINDOW",
};

}  // namespace

struct XwmConn {
    xcb_connection_t* conn = nullptr;
    xcb_screen_t* screen = nullptr;
    xcb_window_t root = 0;
    xcb_atom_t atoms[ATOM_COUNT] = {0};
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

}  // namespace overdraw::xwayland
