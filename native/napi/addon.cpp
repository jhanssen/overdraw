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
#include "wayland/interface_registry.h"
#include "wayland/trampoline.h"

using overdraw::core::Compositor;
using overdraw::wayland::Server;
using overdraw::wayland::InterfaceRegistry;
using overdraw::wayland::InterfaceDesc;
using overdraw::wayland::MessageDesc;
using overdraw::wayland::ArgDesc;
using overdraw::wayland::Trampoline;

namespace {

struct Addon {
    std::unique_ptr<Compositor> compositor;
    std::unique_ptr<Server> server;
    std::unique_ptr<InterfaceRegistry> registry;
    std::unique_ptr<Trampoline> trampoline;
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

// --- helpers to read generated signature objects into InterfaceDesc ---

std::string getStr(napi_env env, napi_value obj, const char* key) {
    napi_value v;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return "";
    napi_valuetype t;
    napi_typeof(env, v, &t);
    if (t != napi_string) return "";
    size_t len = 0;
    napi_get_value_string_utf8(env, v, nullptr, 0, &len);
    std::string s(len, '\0');
    napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
    return s;
}

int getInt(napi_env env, napi_value obj, const char* key, int dflt) {
    napi_value v;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return dflt;
    napi_valuetype t; napi_typeof(env, v, &t);
    if (t != napi_number) return dflt;
    int32_t out = dflt; napi_get_value_int32(env, v, &out); return out;
}

bool getBool(napi_env env, napi_value obj, const char* key) {
    napi_value v;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return false;
    bool out = false; napi_get_value_bool(env, v, &out); return out;
}

// Wayland arg type string -> libwayland signature char.
char typeChar(const std::string& t) {
    if (t == "int") return 'i';
    if (t == "uint") return 'u';
    if (t == "fixed") return 'f';
    if (t == "string") return 's';
    if (t == "object") return 'o';
    if (t == "new_id") return 'n';
    if (t == "array") return 'a';
    if (t == "fd") return 'h';
    return 0;
}

void readMessages(napi_env env, napi_value arr, std::vector<MessageDesc>& out) {
    uint32_t n = 0; napi_get_array_length(env, arr, &n);
    for (uint32_t i = 0; i < n; ++i) {
        napi_value m; napi_get_element(env, arr, i, &m);
        MessageDesc md;
        md.name = getStr(env, m, "name");
        md.since = getInt(env, m, "since", 1);
        napi_value argsArr; napi_get_named_property(env, m, "args", &argsArr);
        uint32_t an = 0; napi_get_array_length(env, argsArr, &an);
        for (uint32_t j = 0; j < an; ++j) {
            napi_value a; napi_get_element(env, argsArr, j, &a);
            ArgDesc ad;
            ad.name = getStr(env, a, "name");
            ad.type = typeChar(getStr(env, a, "type"));
            ad.interface = getStr(env, a, "interface");  // "" if null
            ad.allowNull = getBool(env, a, "allowNull");
            md.args.push_back(std::move(ad));
        }
        out.push_back(std::move(md));
    }
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
    if (g_addon.trampoline) g_addon.trampoline.reset();
    if (g_addon.server) { g_addon.server->stop(); g_addon.server.reset(); }
    g_addon.registry.reset();
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// registerProtocols(signatures: Array<signature>) -> undefined
// Reads generated signature objects, builds the runtime wl_interfaces.
napi_value RegisterProtocols(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "registerProtocols(signatures[]) requires an array");

    if (!g_addon.registry) g_addon.registry = std::make_unique<InterfaceRegistry>();
    uint32_t n = 0; napi_get_array_length(env, argv[0], &n);
    for (uint32_t i = 0; i < n; ++i) {
        napi_value sig; napi_get_element(env, argv[0], i, &sig);
        InterfaceDesc d;
        d.name = getStr(env, sig, "name");
        d.version = getInt(env, sig, "version", 1);
        napi_value reqs, evs;
        napi_get_named_property(env, sig, "requests", &reqs);
        napi_get_named_property(env, sig, "events", &evs);
        readMessages(env, reqs, d.requests);
        readMessages(env, evs, d.events);
        g_addon.registry->add(std::move(d));
    }
    std::string err;
    if (!g_addon.registry->build(err)) return throwError(env, err.c_str());

    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// createGlobal(interfaceName: string, handler: object) -> undefined
napi_value CreateGlobal(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "createGlobal(name, handler) requires two args");
    if (!g_addon.server || !g_addon.registry)
        return throwError(env, "server + protocols must be registered first");

    if (!g_addon.trampoline)
        g_addon.trampoline = std::make_unique<Trampoline>(
            env, g_addon.server->display(), g_addon.registry.get());

    char name[256]; size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len);
    if (!g_addon.trampoline->createGlobal(name, argv[1]))
        return throwError(env, "createGlobal: unknown interface");

    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// registerInterface(interfaceName: string, handler: object) -> undefined
// Register a request handler for an interface created via requests (new_id),
// e.g. xdg_surface / xdg_toplevel, without advertising a global.
napi_value RegisterInterface(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "registerInterface(name, handler) requires two args");
    if (!g_addon.server || !g_addon.registry)
        return throwError(env, "server + protocols must be registered first");

    if (!g_addon.trampoline)
        g_addon.trampoline = std::make_unique<Trampoline>(
            env, g_addon.server->display(), g_addon.registry.get());

    char name[256]; size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len);
    if (!g_addon.trampoline->registerInterface(name, argv[1]))
        return throwError(env, "registerInterface: unknown interface");

    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// postEvent(resourceHandle, opcode, argsArray) -> undefined
// The `post` function the generated makeEvents(post) calls.
napi_value PostEvent(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) return throwError(env, "postEvent(resource, opcode, args) requires three args");
    if (!g_addon.trampoline) return throwError(env, "no trampoline");
    uint32_t opcode = 0; napi_get_value_uint32(env, argv[1], &opcode);
    if (!g_addon.trampoline->postEvent(argv[0], opcode, argv[2]))
        return throwError(env, "postEvent failed");
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
    napi_value fnRegister, fnCreateGlobal, fnPostEvent, fnRegisterIface;
    napi_create_function(env, "registerProtocols", NAPI_AUTO_LENGTH, RegisterProtocols, nullptr, &fnRegister);
    napi_create_function(env, "registerInterface", NAPI_AUTO_LENGTH, RegisterInterface, nullptr, &fnRegisterIface);
    napi_create_function(env, "createGlobal", NAPI_AUTO_LENGTH, CreateGlobal, nullptr, &fnCreateGlobal);
    napi_create_function(env, "postEvent", NAPI_AUTO_LENGTH, PostEvent, nullptr, &fnPostEvent);
    napi_set_named_property(env, exports, "start", fnStart);
    napi_set_named_property(env, exports, "stop", fnStop);
    napi_set_named_property(env, exports, "presentedCount", fnPresented);
    napi_set_named_property(env, exports, "startServer", fnStartServer);
    napi_set_named_property(env, exports, "stopServer", fnStopServer);
    napi_set_named_property(env, exports, "registerProtocols", fnRegister);
    napi_set_named_property(env, exports, "registerInterface", fnRegisterIface);
    napi_set_named_property(env, exports, "createGlobal", fnCreateGlobal);
    napi_set_named_property(env, exports, "postEvent", fnPostEvent);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
