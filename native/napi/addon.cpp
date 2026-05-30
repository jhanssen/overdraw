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

using overdraw::core::Compositor;

namespace {

struct Addon {
    std::unique_ptr<Compositor> compositor;
    uv_poll_t wirePoll{};
    uv_timer_t frameTimer{};
    bool loopRunning = false;
};
Addon g_addon;

napi_value throwError(napi_env env, const char* msg) {
    napi_throw_error(env, nullptr, msg);
    return nullptr;
}

void onWireReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.compositor) return;
    g_addon.compositor->drainWire();
}

void onFrameTimer(uv_timer_t*) {
    if (g_addon.compositor) g_addon.compositor->renderFrame();
}

// start(gpuBinPath) -> { width, height }
napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "start(gpuBinPath) requires a path");

    char gpuBin[4096];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[0], gpuBin, sizeof(gpuBin), &len) != napi_ok)
        return throwError(env, "gpuBinPath must be a string");

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
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

napi_value Init(napi_env env, napi_value exports) {
    napi_value fnStart, fnStop, fnPresented;
    napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fnStart);
    napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr, &fnStop);
    napi_create_function(env, "presentedCount", NAPI_AUTO_LENGTH, PresentedCount, nullptr, &fnPresented);
    napi_set_named_property(env, exports, "start", fnStart);
    napi_set_named_property(env, exports, "stop", fnStop);
    napi_set_named_property(env, exports, "presentedCount", fnPresented);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
