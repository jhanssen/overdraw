#include "xwayland/napi_xwayland.h"

#include <cerrno>
#include <cstdlib>
#include <string>

#include <unistd.h>
#include <uv.h>

#include "xwayland/server.h"

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

}  // namespace

void RegisterXwayland(napi_env env, napi_value exports) {
    napi_value fnStart, fnStop;
    napi_create_function(env, "xwaylandStart", NAPI_AUTO_LENGTH, Start, nullptr, &fnStart);
    napi_create_function(env, "xwaylandStop", NAPI_AUTO_LENGTH, Stop, nullptr, &fnStop);
    napi_set_named_property(env, exports, "xwaylandStart", fnStart);
    napi_set_named_property(env, exports, "xwaylandStop", fnStop);
}

}  // namespace overdraw::xwayland
