#include "xwayland/napi_xwayland.h"

#include <cerrno>
#include <cstdlib>
#include <string>

#include <unistd.h>
#include <uv.h>

#include "xwayland/server.h"
#include "xwayland/xwm.h"

namespace overdraw::xwayland {
namespace {

napi_value throwErr(napi_env env, const char* msg) {
    napi_throw_error(env, nullptr, msg);
    napi_value u;
    napi_get_undefined(env, &u);
    return u;
}

std::string getStr(napi_env env, napi_value obj, const char* key) {
    napi_value v;
    napi_valuetype t;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return {};
    if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) return {};
    size_t len = 0;
    napi_get_value_string_utf8(env, v, nullptr, 0, &len);
    std::string s(len, '\0');
    napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
    return s;
}

bool getBool(napi_env env, napi_value obj, const char* key, bool dflt) {
    napi_value v;
    napi_valuetype t;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return dflt;
    if (napi_typeof(env, v, &t) != napi_ok || t != napi_boolean) return dflt;
    bool b = dflt;
    napi_get_value_bool(env, v, &b);
    return b;
}

// Per-spawn readiness watcher: polls the -displayfd pipe on the libuv loop and
// invokes the JS onReady(err, info) callback once Xwayland reports its display
// number (or the pipe closes -- Xwayland died before becoming ready). Polling
// (not a blocking read) keeps the loop free to service Xwayland's Wayland
// handshake, which is what unblocks the readiness signal in the first place.
struct ReadyWatch {
    uv_poll_t poll;
    int fd = -1;
    std::string digits;
    bool done = false;
    napi_env env = nullptr;
    napi_ref cb = nullptr;
};

void onPollClosed(uv_handle_t* h) {
    delete static_cast<ReadyWatch*>(h->data);
}

// Deliver the result to JS and tear down the watcher. `err` non-null => failure.
void finish(ReadyWatch* w, const char* err, int displayNumber) {
    if (w->done) return;
    w->done = true;
    uv_poll_stop(&w->poll);

    napi_env env = w->env;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);

    napi_value cb;
    napi_get_reference_value(env, w->cb, &cb);
    napi_value undef;
    napi_get_undefined(env, &undef);

    napi_value argv[2];
    if (err) {
        napi_create_string_utf8(env, err, NAPI_AUTO_LENGTH, &argv[0]);
        argv[1] = undef;
    } else {
        argv[0] = undef;  // no error
        napi_value info;
        napi_create_object(env, &info);
        napi_value dn;
        napi_create_int32(env, displayNumber, &dn);
        napi_set_named_property(env, info, "displayNumber", dn);
        const std::string name = ":" + std::to_string(displayNumber);
        napi_value nameV;
        napi_create_string_utf8(env, name.c_str(), NAPI_AUTO_LENGTH, &nameV);
        napi_set_named_property(env, info, "display", nameV);
        argv[1] = info;
    }
    napi_call_function(env, undef, cb, 2, argv, nullptr);
    napi_close_handle_scope(env, scope);

    napi_delete_reference(env, w->cb);
    w->cb = nullptr;
    if (w->fd >= 0) {
        ::close(w->fd);
        w->fd = -1;
    }
    uv_close(reinterpret_cast<uv_handle_t*>(&w->poll), onPollClosed);
}

void onReadable(uv_poll_t* h, int status, int /*events*/) {
    auto* w = static_cast<ReadyWatch*>(h->data);
    if (status < 0) {
        finish(w, "poll error on displayfd", -1);
        return;
    }
    char buf[32];
    for (;;) {
        const ssize_t n = ::read(w->fd, buf, sizeof(buf));
        if (n == 0) {
            finish(w, "Xwayland exited before reporting a display", -1);
            return;
        }
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;  // wait for more
            finish(w, "read error on displayfd", -1);
            return;
        }
        for (ssize_t i = 0; i < n; ++i) {
            const char c = buf[i];
            if (c == '\n') {
                if (w->digits.empty()) {
                    finish(w, "empty display number from Xwayland", -1);
                    return;
                }
                finish(w, nullptr, std::atoi(w->digits.c_str()));
                return;
            }
            if (c >= '0' && c <= '9') w->digits.push_back(c);
            if (w->digits.size() > 9) {
                finish(w, "implausible display number from Xwayland", -1);
                return;
            }
        }
    }
}

// xwaylandStart({ waylandDisplay, xwaylandPath?, terminate? }, onReady) -> { pid }
// onReady(err: string|null, info: { displayNumber, display } | undefined).
napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwErr(env, "xwaylandStart(opts, onReady) requires two args");
    napi_valuetype t;
    napi_typeof(env, argv[1], &t);
    if (t != napi_function) return throwErr(env, "xwaylandStart: onReady must be a function");

    XwaylandOptions opts;
    opts.waylandDisplay = getStr(env, argv[0], "waylandDisplay");
    opts.xwaylandPath = getStr(env, argv[0], "xwaylandPath");
    opts.terminate = getBool(env, argv[0], "terminate", false);
    opts.enableWm = getBool(env, argv[0], "enableWm", false);
    // displayNumber: optional number; <0 / absent / wrong-type leaves the
    // default (-1 = let Xwayland autopick via -displayfd).
    {
        napi_value v;
        napi_valuetype t;
        if (napi_get_named_property(env, argv[0], "displayNumber", &v) == napi_ok
            && napi_typeof(env, v, &t) == napi_ok && t == napi_number) {
            int32_t n = -1;
            napi_get_value_int32(env, v, &n);
            opts.displayNumber = n;
        }
    }

    XwaylandSpawn sp = spawnXwayland(opts);
    if (sp.pid < 0) return throwErr(env, "failed to spawn Xwayland");

    auto* w = new ReadyWatch();
    w->fd = sp.displayReadFd;
    w->env = env;
    napi_create_reference(env, argv[1], 1, &w->cb);

    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    uv_poll_init(loop, &w->poll, w->fd);
    w->poll.data = w;
    uv_poll_start(&w->poll, UV_READABLE, onReadable);

    napi_value obj;
    napi_create_object(env, &obj);
    napi_value pid;
    napi_create_int32(env, sp.pid, &pid);
    napi_set_named_property(env, obj, "pid", pid);
    napi_value wmFd;
    napi_create_int32(env, sp.wmFd, &wmFd);
    napi_set_named_property(env, obj, "wmFd", wmFd);
    return obj;
}

// xwaylandStop(pid) -> undefined
napi_value Stop(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int32_t pid = -1;
    if (argc >= 1) napi_get_value_int32(env, argv[0], &pid);
    reapXwayland(pid);
    napi_value u;
    napi_get_undefined(env, &u);
    return u;
}

// ---- XWM (X11 window manager over the -wm socket) ----
//
// One XWM at a time (Phase 2). The xcb fd is polled on the libuv loop; decoded
// events marshal to the JS onEvent callback. Request wrappers operate on the
// live connection.

struct XwmJsState {
    XwmConn* conn = nullptr;
    uv_poll_t poll;
    napi_env env = nullptr;
    napi_ref cb = nullptr;
    bool active = false;
};
XwmJsState g_xwm;

void deliverXwmEvent(const XwmEvent& e) {
    napi_env env = g_xwm.env;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);

    const char* typeStr = "?";
    switch (e.type) {
        case XwmEvent::Create: typeStr = "create"; break;
        case XwmEvent::Destroy: typeStr = "destroy"; break;
        case XwmEvent::MapRequest: typeStr = "map-request"; break;
        case XwmEvent::MapNotify: typeStr = "map"; break;
        case XwmEvent::UnmapNotify: typeStr = "unmap"; break;
        case XwmEvent::ConfigureRequest: typeStr = "configure-request"; break;
        case XwmEvent::SurfaceSerial: typeStr = "surface-serial"; break;
    }
    napi_value obj;
    napi_create_object(env, &obj);
    const auto setStr = [&](const char* k, const char* v) {
        napi_value s;
        napi_create_string_utf8(env, v, NAPI_AUTO_LENGTH, &s);
        napi_set_named_property(env, obj, k, s);
    };
    const auto setI32 = [&](const char* k, int32_t v) {
        napi_value n;
        napi_create_int32(env, v, &n);
        napi_set_named_property(env, obj, k, n);
    };
    const auto setU32 = [&](const char* k, uint32_t v) {
        napi_value n;
        napi_create_uint32(env, v, &n);
        napi_set_named_property(env, obj, k, n);
    };
    napi_value boolV;
    napi_get_boolean(env, e.overrideRedirect, &boolV);
    setStr("type", typeStr);
    setU32("window", e.window);
    setI32("x", e.x);
    setI32("y", e.y);
    setI32("width", e.width);
    setI32("height", e.height);
    napi_set_named_property(env, obj, "overrideRedirect", boolV);
    // 64-bit serial split into two u32 so JS reconstructs the exact BigInt the
    // wayland-side set_serial used.
    setU32("serialLo", static_cast<uint32_t>(e.serial & 0xffffffffu));
    setU32("serialHi", static_cast<uint32_t>(e.serial >> 32));

    napi_value cb, undef;
    napi_get_reference_value(env, g_xwm.cb, &cb);
    napi_get_undefined(env, &undef);
    napi_call_function(env, undef, cb, 1, &obj, nullptr);
    napi_close_handle_scope(env, scope);
}

void xwmTeardown() {
    if (!g_xwm.active) return;
    g_xwm.active = false;
    uv_poll_stop(&g_xwm.poll);
    uv_close(reinterpret_cast<uv_handle_t*>(&g_xwm.poll), nullptr);
    if (g_xwm.conn) {
        xwmDisconnect(g_xwm.conn);  // closes the wm fd
        g_xwm.conn = nullptr;
    }
    if (g_xwm.cb) {
        napi_delete_reference(g_xwm.env, g_xwm.cb);
        g_xwm.cb = nullptr;
    }
}

void onXcbReadable(uv_poll_t* /*h*/, int status, int /*events*/) {
    if (status < 0) {
        xwmTeardown();
        return;
    }
    if (!xwmProcess(g_xwm.conn, deliverXwmEvent)) xwmTeardown();  // xcb errored
}

// xwmStart(wmFd, onEvent) -> undefined
napi_value XwmStart(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwErr(env, "xwmStart(wmFd, onEvent) requires two args");
    napi_valuetype t;
    napi_typeof(env, argv[1], &t);
    if (t != napi_function) return throwErr(env, "xwmStart: onEvent must be a function");
    if (g_xwm.active) return throwErr(env, "xwmStart: an XWM is already running");

    int32_t wmFd = -1;
    napi_get_value_int32(env, argv[0], &wmFd);
    if (wmFd < 0) return throwErr(env, "xwmStart: invalid wmFd");

    XwmConn* conn = xwmConnect(wmFd);
    if (!conn) return throwErr(env, "xwmStart: failed to connect xcb to the wm socket");

    g_xwm.conn = conn;
    g_xwm.env = env;
    napi_create_reference(env, argv[1], 1, &g_xwm.cb);
    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    uv_poll_init(loop, &g_xwm.poll, xwmFd(conn));
    uv_poll_start(&g_xwm.poll, UV_READABLE, onXcbReadable);
    g_xwm.active = true;

    // Drain anything already queued before the poll was armed.
    if (!xwmProcess(conn, deliverXwmEvent)) xwmTeardown();

    napi_value u;
    napi_get_undefined(env, &u);
    return u;
}

napi_value XwmStop(napi_env env, napi_callback_info /*info*/) {
    xwmTeardown();
    napi_value u;
    napi_get_undefined(env, &u);
    return u;
}

napi_value XwmMapWindow(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!g_xwm.active) return throwErr(env, "xwmMapWindow: no XWM running");
    uint32_t window = 0;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &window);
    xwmMapWindow(g_xwm.conn, window);
    napi_value u;
    napi_get_undefined(env, &u);
    return u;
}

napi_value XwmConfigureWindow(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value argv[5];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!g_xwm.active) return throwErr(env, "xwmConfigureWindow: no XWM running");
    if (argc < 5) return throwErr(env, "xwmConfigureWindow(window, x, y, w, h)");
    uint32_t window = 0;
    int32_t x = 0, y = 0, w = 0, h = 0;
    napi_get_value_uint32(env, argv[0], &window);
    napi_get_value_int32(env, argv[1], &x);
    napi_get_value_int32(env, argv[2], &y);
    napi_get_value_int32(env, argv[3], &w);
    napi_get_value_int32(env, argv[4], &h);
    xwmConfigureWindow(g_xwm.conn, window, x, y, w, h);
    napi_value u;
    napi_get_undefined(env, &u);
    return u;
}

}  // namespace

void RegisterXwayland(napi_env env, napi_value exports) {
    const auto reg = [&](const char* name, napi_callback fn) {
        napi_value f;
        napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f);
        napi_set_named_property(env, exports, name, f);
    };
    reg("xwaylandStart", Start);
    reg("xwaylandStop", Stop);
    reg("xwmStart", XwmStart);
    reg("xwmStop", XwmStop);
    reg("xwmMapWindow", XwmMapWindow);
    reg("xwmConfigureWindow", XwmConfigureWindow);
}

}  // namespace overdraw::xwayland
