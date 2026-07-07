#include "wayland_fd.h"

#include <cstdio>

#include <fcntl.h>
#include <unistd.h>

namespace overdraw::wayland {
namespace {

// Native backing held in the WaylandFd object's external. Owns the dup'd fd.
struct WaylandFdState {
    int fd = -1;
    bool taken = false;
    bool closed = false;
};

const char* kTokenKey = "__wlfd";  // external property name on the JS object

// Recover the state from `this` (the WaylandFd object). Returns nullptr if the
// receiver is not a WaylandFd.
WaylandFdState* stateOf(napi_env env, napi_value self) {
    napi_value ext;
    if (napi_get_named_property(env, self, kTokenKey, &ext) != napi_ok) return nullptr;
    napi_valuetype t;
    if (napi_typeof(env, ext, &t) != napi_ok || t != napi_external) return nullptr;
    void* p = nullptr;
    if (napi_get_value_external(env, ext, &p) != napi_ok) return nullptr;
    return static_cast<WaylandFdState*>(p);
}

void finalizeState(napi_env, void* data, void*) {
    auto* st = static_cast<WaylandFdState*>(data);
    if (st->fd >= 0 && !st->taken && !st->closed) {
        std::fprintf(stderr,
            "[wlfd] WARNING: WaylandFd garbage-collected while still open (fd=%d); "
            "closing. Well-behaved code should takeRawFd() or close() it.\n", st->fd);
        ::close(st->fd);
    }
    delete st;
}

// takeRawFd(): transfer the fd out; mark taken. Throws if taken/closed.
napi_value jsTakeRawFd(napi_env env, napi_callback_info info) {
    napi_value self;
    napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr);
    WaylandFdState* st = stateOf(env, self);
    if (!st) { napi_throw_error(env, nullptr, "not a WaylandFd"); return nullptr; }
    if (st->taken || st->closed) {
        napi_throw_error(env, nullptr, "WaylandFd already taken or closed");
        return nullptr;
    }
    int fd = st->fd;
    st->taken = true;
    st->fd = -1;
    napi_value out; napi_create_int32(env, fd, &out);
    return out;
}

// close(): close the fd now. No-op if taken/closed.
napi_value jsClose(napi_env env, napi_callback_info info) {
    napi_value self;
    napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr);
    WaylandFdState* st = stateOf(env, self);
    if (st && !st->taken && !st->closed) {
        if (st->fd >= 0) ::close(st->fd);
        st->closed = true;
        st->fd = -1;
    }
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// dup(): return a NEW WaylandFd owning an independent F_DUPFD_CLOEXEC copy of
// this fd, leaving this wrapper untouched. For forwarding a request fd onto
// an async wire event while the handler keeps (and eventually close()s) the
// original. Request fds are handler-owned: libwayland does NOT close them
// after dispatch (see trampoline.cpp 'h' demarshal).
napi_value jsDup(napi_env env, napi_callback_info info) {
    napi_value self;
    napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr);
    WaylandFdState* st = stateOf(env, self);
    if (!st || st->taken || st->closed || st->fd < 0) {
        napi_throw_error(env, nullptr, "WaylandFd not dup-able (taken/closed)");
        return nullptr;
    }
    int dupFd = ::fcntl(st->fd, F_DUPFD_CLOEXEC, 0);
    return makeWaylandFd(env, dupFd);
}

// fd getter: the raw fd, or -1 if taken/closed. (Borrow; does not transfer.)
napi_value jsGetFd(napi_env env, napi_callback_info info) {
    napi_value self;
    napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr);
    WaylandFdState* st = stateOf(env, self);
    napi_value out; napi_create_int32(env, st ? st->fd : -1, &out);
    return out;
}

// closed getter: true once taken or closed.
napi_value jsGetClosed(napi_env env, napi_callback_info info) {
    napi_value self;
    napi_get_cb_info(env, info, nullptr, nullptr, &self, nullptr);
    WaylandFdState* st = stateOf(env, self);
    napi_value out; napi_get_boolean(env, st ? (st->taken || st->closed) : true, &out);
    return out;
}

}  // namespace

napi_value makeWaylandFd(napi_env env, int fd) {
    auto* st = new WaylandFdState{fd, false, false};

    napi_value obj;
    napi_create_object(env, &obj);

    napi_value ext;
    napi_create_external(env, st, finalizeState, nullptr, &ext);
    napi_set_named_property(env, obj, kTokenKey, ext);

    napi_value fn;
    napi_create_function(env, "takeRawFd", NAPI_AUTO_LENGTH, jsTakeRawFd, nullptr, &fn);
    napi_set_named_property(env, obj, "takeRawFd", fn);
    napi_create_function(env, "close", NAPI_AUTO_LENGTH, jsClose, nullptr, &fn);
    napi_set_named_property(env, obj, "close", fn);
    napi_create_function(env, "dup", NAPI_AUTO_LENGTH, jsDup, nullptr, &fn);
    napi_set_named_property(env, obj, "dup", fn);

    // fd / closed as accessor getters.
    napi_property_descriptor props[] = {
        {"fd", nullptr, nullptr, jsGetFd, nullptr, nullptr, napi_enumerable, nullptr},
        {"closed", nullptr, nullptr, jsGetClosed, nullptr, nullptr, napi_enumerable, nullptr},
    };
    napi_define_properties(env, obj, 2, props);

    return obj;
}

int takeWaylandFd(napi_env env, napi_value obj) {
    WaylandFdState* st = stateOf(env, obj);
    if (!st || st->taken || st->closed) return -1;
    int fd = st->fd;
    st->taken = true;
    st->fd = -1;
    return fd;
}

int peekWaylandFd(napi_env env, napi_value obj) {
    WaylandFdState* st = stateOf(env, obj);
    if (!st || st->taken || st->closed || st->fd < 0) return -1;
    return ::fcntl(st->fd, F_DUPFD_CLOEXEC, 0);  // caller owns the dup; wrapper keeps its fd
}

}  // namespace overdraw::wayland
