// overdraw core N-API addon: glue only.
//
// Owns a core::Compositor instance and the libuv handles that drive its steady
// state (wire poll + frame timer). All native logic lives in native/core/*.
//
// Raw node_api.h (C API) is used deliberately: node-addon-api is exception/RTTI
// based and the project builds -fno-rtti to match Dawn.

#include <node_api.h>
#include <uv.h>

#include <memory>

#include "core/compositor.h"
#include "core/gpu_process.h"
#include "wayland/server.h"

using overdraw::core::Compositor;
using overdraw::wayland::Server;

namespace {

struct Addon {
    std::unique_ptr<Compositor> compositor;
    std::unique_ptr<Server> server;
    uv_poll_t wirePoll{};
    uv_timer_t frameTimer{};
    bool loopRunning = false;

    // Optional JS callback for frame events. Stored as a ref; called directly
    // from the frame timer (same thread as Node, so no threadsafe function is
    // needed). Cross-thread events (e.g. Dawn callbacks on Dawn-internal
    // threads) will need napi_threadsafe_function -- not exercised yet.
    napi_env env = nullptr;
    napi_ref onFrame = nullptr;
    uint64_t lastNotified = 0;
};
Addon g_addon;

// Call the JS onFrame(presentedCount) callback if registered. Same-thread.
void notifyFrame() {
    if (!g_addon.onFrame || !g_addon.compositor) return;
    napi_env env = g_addon.env;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined, arg;
    napi_get_reference_value(env, g_addon.onFrame, &cb);
    napi_get_undefined(env, &undefined);
    napi_create_uint32(env, static_cast<uint32_t>(g_addon.compositor->presented()), &arg);
    napi_call_function(env, undefined, cb, 1, &arg, nullptr);
    napi_close_handle_scope(env, scope);
}

napi_value throwError(napi_env env, const char* msg) {
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

void onWireReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.compositor) return;
    g_addon.compositor->drainWire();
}

void onFrameTimer(uv_timer_t*) {
    if (!g_addon.compositor) return;
    g_addon.compositor->renderFrame();
    // Notify JS once per ~60 frames (≈1Hz) to prove the C++->JS event path
    // without flooding.
    uint64_t n = g_addon.compositor->presented();
    if (n - g_addon.lastNotified >= 60) {
        g_addon.lastNotified = n;
        notifyFrame();
    }
}

// start(gpuBinPath, onFrame?) -> { width, height }
napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "start(gpuBinPath) requires a path");

    char gpuBin[4096];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[0], gpuBin, sizeof(gpuBin), &len) != napi_ok)
        return throwError(env, "gpuBinPath must be a string");

    // Optional frame-event callback.
    g_addon.env = env;
    if (argc >= 2) {
        napi_valuetype t;
        napi_typeof(env, argv[1], &t);
        if (t == napi_function) napi_create_reference(env, argv[1], 1, &g_addon.onFrame);
    }

    auto gpu = overdraw::core::spawnGpuProcess(gpuBin);
    if (gpu.pid < 0) return throwError(env, "failed to spawn gpu process");

    g_addon.compositor = std::make_unique<Compositor>(gpu.wireFd, gpu.ctrlFd, gpu.pid);
    if (!g_addon.compositor->bringUp()) {
        const char* e = g_addon.compositor->error().c_str();
        // Compositor dtor reaps the GPU process.
        g_addon.compositor.reset();
        return throwError(env, e);
    }

    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    uv_poll_init(loop, &g_addon.wirePoll, g_addon.compositor->wireFd());
    uv_poll_start(&g_addon.wirePoll, UV_READABLE, onWireReadable);
    uv_timer_init(loop, &g_addon.frameTimer);
    uv_timer_start(&g_addon.frameTimer, onFrameTimer, 0, 16);  // ~60Hz
    g_addon.loopRunning = true;

    napi_value result, w, h;
    napi_create_object(env, &result);
    napi_create_uint32(env, g_addon.compositor->windowWidth(), &w);
    napi_create_uint32(env, g_addon.compositor->windowHeight(), &h);
    napi_set_named_property(env, result, "width", w);
    napi_set_named_property(env, result, "height", h);
    return result;
}

napi_value PresentedCount(napi_env env, napi_callback_info) {
    uint32_t n = g_addon.compositor ? static_cast<uint32_t>(g_addon.compositor->presented()) : 0;
    napi_value v;
    napi_create_uint32(env, n, &v);
    return v;
}

napi_value Stop(napi_env env, napi_callback_info) {
    if (g_addon.loopRunning) {
        uv_timer_stop(&g_addon.frameTimer);
        uv_poll_stop(&g_addon.wirePoll);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.frameTimer), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.wirePoll), nullptr);
        g_addon.loopRunning = false;
    }
    if (g_addon.compositor) {
        g_addon.compositor->shutdown();
        g_addon.compositor.reset();
    }
    if (g_addon.onFrame) {
        napi_delete_reference(env, g_addon.onFrame);
        g_addon.onFrame = nullptr;
    }
    g_addon.lastNotified = 0;
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// startServer() -> string (socket name) : stand up the Wayland server on the
// libuv loop. Independent of the present loop for now.
napi_value StartServer(napi_env env, napi_callback_info) {
    if (!g_addon.server) g_addon.server = std::make_unique<Server>();
    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    if (!g_addon.server->start(loop)) {
        g_addon.server.reset();
        return throwError(env, "failed to start wayland server");
    }
    napi_value name;
    napi_create_string_utf8(env, g_addon.server->socketName().c_str(), NAPI_AUTO_LENGTH, &name);
    return name;
}

napi_value StopServer(napi_env env, napi_callback_info) {
    if (g_addon.server) { g_addon.server->stop(); g_addon.server.reset(); }
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_value fnStart, fnStop, fnPresented, fnStartServer, fnStopServer;
    napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fnStart);
    napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr, &fnStop);
    napi_create_function(env, "presentedCount", NAPI_AUTO_LENGTH, PresentedCount, nullptr, &fnPresented);
    napi_create_function(env, "startServer", NAPI_AUTO_LENGTH, StartServer, nullptr, &fnStartServer);
    napi_create_function(env, "stopServer", NAPI_AUTO_LENGTH, StopServer, nullptr, &fnStopServer);
    napi_set_named_property(env, exports, "start", fnStart);
    napi_set_named_property(env, exports, "stop", fnStop);
    napi_set_named_property(env, exports, "presentedCount", fnPresented);
    napi_set_named_property(env, exports, "startServer", fnStartServer);
    napi_set_named_property(env, exports, "stopServer", fnStopServer);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
