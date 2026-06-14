// overdraw core N-API addon: glue only.
//
// Owns a core::Compositor instance and the libuv handles that drive its steady
// state (wire poll + frame timer). All native logic lives in native/core/*.
//
// Raw node_api.h (C API) is used deliberately: node-addon-api is exception/RTTI
// based and the project builds -fno-rtti to match Dawn.

#include <node_api.h>
#include <uv.h>

#include <execinfo.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/types.h>  // dev_t
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>

#include "core/compositor.h"
#include "core/gpu_process.h"
#include "core/input.h"
#include "core/input_wayland.h"
#if OVERDRAW_KMS
#include "core/seat.h"
#include "core/input_libinput.h"
#endif
#include "input_channel.h"
#include "core/shm.h"
#include "wayland/server.h"
#include "wayland/interface_registry.h"
#include "wayland/trampoline.h"
#include "wayland/wayland_fd.h"
#include "wayland/keymap.h"
#include "cursor/xcursor.h"

using overdraw::core::Compositor;
using overdraw::core::InputEvent;
using overdraw::core::InputEventType;
using overdraw::core::InputSink;
using overdraw::core::ButtonState;
using overdraw::core::AxisKind;
using overdraw::core::WaylandInputBackend;
using overdraw::core::ShmRegistry;
using overdraw::wayland::Server;
using overdraw::wayland::InterfaceRegistry;
using overdraw::wayland::InterfaceDesc;
using overdraw::wayland::MessageDesc;
using overdraw::wayland::ArgDesc;
using overdraw::wayland::Trampoline;
using overdraw::wayland::Keymap;

namespace {

// Crash handler: dump a native backtrace to a file then re-raise. Mirrors the
// GPU-process handler in `gpu-process/src/main.cpp`. Without this, a SIGSEGV
// inside the addon (or inside any code reachable from a libuv handle the
// addon installed) leaves no trace -- Node prints nothing to stderr because
// the fatal signal short-circuits the runtime. The file is the only artifact.
void coreCrashHandler(int sig) {
    const char* path = "/tmp/overdraw-core-crash.txt";
    int fd = ::open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
        char hdr[64];
        int n = std::snprintf(hdr, sizeof(hdr), "core (node addon) caught signal %d\n", sig);
        ssize_t w = ::write(fd, hdr, static_cast<size_t>(n));
        (void)w;
        void* frames[64];
        int got = ::backtrace(frames, 64);
        ::backtrace_symbols_fd(frames, got, fd);
        ::close(fd);
    }
    ::signal(sig, SIG_DFL);
    ::raise(sig);
}

void installCoreCrashHandler() {
    ::signal(SIGSEGV, coreCrashHandler);
    ::signal(SIGABRT, coreCrashHandler);
    ::signal(SIGBUS,  coreCrashHandler);
    ::signal(SIGILL,  coreCrashHandler);
    ::signal(SIGFPE,  coreCrashHandler);
}

struct Addon {
    std::unique_ptr<Compositor> compositor;
    std::unique_ptr<Server> server;
    std::unique_ptr<InterfaceRegistry> registry;
    std::unique_ptr<Trampoline> trampoline;
    // The active input backend, paired with the output backend:
    //   backend=kms    -> LibinputBackend (reads /dev/input/* via libseat).
    //   backend=nested -> WaylandInputBackend (events forwarded from the GPU
    //                     process's host wl_seat).
    // Exactly one is active per Start(). The wayland pointer is kept separately
    // for the injectHostInput test seam, which only applies to the nested path.
    std::unique_ptr<overdraw::core::InputBackend> input;
    WaylandInputBackend* waylandInput = nullptr;  // non-owning; points into `input` when active
#if OVERDRAW_KMS
    std::unique_ptr<overdraw::core::Seat> seat;
    uv_poll_t seatPoll{};
    bool seatPollActive = false;
    int drmCardFd = -1;        // KMS: our copy of the DRM fd (libseat-owned tracking)
    int drmCardDeviceId = -1;  // KMS: libseat device id for closeDevice on shutdown
#endif
    std::unique_ptr<Keymap> keymap;  // xkbcommon keymap + modifier state
    ShmRegistry shm;  // wl_shm pool mappings (CPU-side, independent of the loop)
    uv_poll_t wirePoll{};
    uv_poll_t ctrlPoll{};
    uv_poll_t inputPoll{};
    uv_timer_t frameTimer{};
    int inputFd = -1;  // core-side input socket; owned here, closed in Stop()
    bool loopRunning = false;

    // Optional JS callback for frame events. Stored as a ref; called directly
    // from the frame timer (same thread as Node, so no threadsafe function is
    // needed). Cross-thread events (e.g. Dawn callbacks on Dawn-internal
    // threads) will need napi_threadsafe_function -- not exercised yet.
    napi_env env = nullptr;
    napi_ref onFrame = nullptr;
    napi_ref onInput = nullptr;  // optional JS callback(event) for input events
    napi_ref onOutput = nullptr; // optional JS callback(descriptor) for OutputDescriptor msgs
    uint64_t lastNotified = 0;
};
Addon g_addon;

// The plugin GPU model: the plugin WORKER owns its wire client + device
// (overdraw_plugin_native.node); the CORE only brokers the side channel. The
// addon's plugin methods are that broker surface. Everything below is async,
// resolved from the libuv ctrl poll.

// uint32 from a napi value argument.
uint32_t u32(napi_env env, napi_value v) { uint32_t o = 0; napi_get_value_uint32(env, v, &o); return o; }

// A surface-buffer allocation in flight. Resolved by the ctrl poll when
// SurfaceBufAllocated arrives. cb({surfaceBufId} | null) -- the Worker owns the
// producer texture, so only the id is reported back.
struct PendingAlloc { uint32_t surfaceBufId; uint32_t connId; napi_ref cb; };
std::vector<PendingAlloc> g_pendingAllocs;

// Connection brokering (the Worker owns the wire client; the core brokers the
// side channel). Resolve from the ctrl poll.
//   PendingConnBroker: addWireConnection -> WireConnAdded -> cb({connId, fd}).
//   PendingInject: injectPluginInstance -> PluginInstanceInjected -> cb(ok).
struct PendingConnBroker { uint32_t connId; int clientFd; napi_ref cb; };
std::vector<PendingConnBroker> g_pendingConnBrokers;
struct PendingInject { uint32_t connId; napi_ref cb; };
std::vector<PendingInject> g_pendingInjects;

// Defined below; declared here so the ctrl poll (above them) can advance them.
void advancePendingAllocs(napi_env env);
void advanceConnBrokers(napi_env env);
void advanceInjects(napi_env env);

// Forwards normalized input events to the JS onInput callback. Same Node thread
// (driven from the inputPoll handle), so a direct napi_call_function is safe.
class JsInputSink : public InputSink {
  public:
    void onInputEvent(const InputEvent& ev) override;
};
JsInputSink g_inputSink;

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

// Map the event type to a stable string for the JS payload.
const char* inputTypeName(InputEventType t) {
    switch (t) {
        case InputEventType::PointerEnter:      return "pointerEnter";
        case InputEventType::PointerLeave:      return "pointerLeave";
        case InputEventType::PointerMotion:     return "pointerMotion";
        case InputEventType::PointerButton:     return "pointerButton";
        case InputEventType::PointerAxis:       return "pointerAxis";
        case InputEventType::PointerFrame:      return "pointerFrame";
        case InputEventType::KeyboardEnter:     return "keyboardEnter";
        case InputEventType::KeyboardLeave:     return "keyboardLeave";
        case InputEventType::KeyboardKey:       return "keyboardKey";
        case InputEventType::KeyboardModifiers: return "keyboardModifiers";
    }
    return "unknown";
}

void setU32(napi_env env, napi_value obj, const char* key, uint32_t v) {
    napi_value n; napi_create_uint32(env, v, &n);
    napi_set_named_property(env, obj, key, n);
}
void setF64(napi_env env, napi_value obj, const char* key, double v) {
    napi_value n; napi_create_double(env, v, &n);
    napi_set_named_property(env, obj, key, n);
}
void setBool(napi_env env, napi_value obj, const char* key, bool v) {
    napi_value n; napi_get_boolean(env, v, &n);
    napi_set_named_property(env, obj, key, n);
}

void JsInputSink::onInputEvent(const InputEvent& ev) {
    if (!g_addon.onInput) return;
    napi_env env = g_addon.env;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);

    napi_value obj; napi_create_object(env, &obj);
    napi_value typeStr;
    napi_create_string_utf8(env, inputTypeName(ev.type), NAPI_AUTO_LENGTH, &typeStr);
    napi_set_named_property(env, obj, "type", typeStr);
    setU32(env, obj, "serial", ev.serial);
    setU32(env, obj, "time", ev.time);

    switch (ev.type) {
        case InputEventType::PointerEnter:
        case InputEventType::PointerMotion:
            setF64(env, obj, "x", ev.x);
            setF64(env, obj, "y", ev.y);
            break;
        case InputEventType::PointerButton:
            setU32(env, obj, "button", ev.button);
            setBool(env, obj, "pressed", ev.buttonState == ButtonState::Pressed);
            break;
        case InputEventType::PointerAxis:
            setBool(env, obj, "horizontal", ev.axis == AxisKind::HorizontalScroll);
            setF64(env, obj, "value", ev.axisValue);
            setU32(env, obj, "discrete", static_cast<uint32_t>(ev.axisDiscrete));
            break;
        case InputEventType::KeyboardKey:
            setU32(env, obj, "key", ev.key);  // raw evdev keycode
            setBool(env, obj, "pressed", ev.buttonState == ButtonState::Pressed);
            break;
        case InputEventType::KeyboardModifiers:
            setU32(env, obj, "modsDepressed", ev.modsDepressed);
            setU32(env, obj, "modsLatched", ev.modsLatched);
            setU32(env, obj, "modsLocked", ev.modsLocked);
            setU32(env, obj, "group", ev.group);
            break;
        default:
            break;  // enter/leave/frame: type+serial+time only
    }

    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onInput, &cb);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, cb, 1, &obj, nullptr);
    napi_close_handle_scope(env, scope);
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

// Number-getters used by start() headless opts + input-event objects.
uint32_t getU32(napi_env env, napi_value obj, const char* key, uint32_t dflt = 0) {
    napi_value v;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return dflt;
    napi_valuetype t; napi_typeof(env, v, &t);
    if (t != napi_number) return dflt;
    uint32_t out = dflt; napi_get_value_uint32(env, v, &out); return out;
}
double getF64(napi_env env, napi_value obj, const char* key, double dflt = 0.0) {
    napi_value v;
    if (napi_get_named_property(env, obj, key, &v) != napi_ok) return dflt;
    napi_valuetype t; napi_typeof(env, v, &t);
    if (t != napi_number) return dflt;
    double out = dflt; napi_get_value_double(env, v, &out); return out;
}
bool getBoolProp(napi_env env, napi_value obj, const char* key) {
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
        // The generator emits `type` as the XML <request>/<event> type
        // attribute ("destructor" for destructor requests, otherwise null/
        // missing). Only "destructor" is acted on; other values are ignored.
        md.isDestructor = getStr(env, m, "type") == "destructor";
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

void onWireReadable(uv_poll_t*, int status, int events);
void fireJsImports(napi_env env);
void fireOutputDescriptors(napi_env env);

// Arm the wire poll for READABLE always, plus WRITABLE iff outbound wire bytes
// are queued (so we get told when the socket can take more). Call after anything
// that may have queued wire output.
void armWirePoll() {
    if (!g_addon.loopRunning || !g_addon.compositor) return;
    int events = UV_READABLE;
    if (g_addon.compositor->wireHasPendingOut()) events |= UV_WRITABLE;
    uv_poll_start(&g_addon.wirePoll, events, onWireReadable);
}

// Mirror of armWirePoll for the ctrl fd: steady-state ctrl sends are buffered
// through Compositor::ctrlSender_, and a backed-up queue must be drained on
// fd-writable. Call after anything that may have queued ctrl output (every
// site that hands a Message to the compositor's broker methods).
void armCtrlPoll();

// Advance every pending plugin-broker op against the latest drained ctrl state.
// MUST run after ANY drainCtrl() on the Node thread: drainCtrl only RECORDS the
// replies (SurfaceBufAllocated / *BeginDone / WireConnAdded / PluginInstanceInjected);
// these advancers invoke the JS callbacks. Both the ctrl-fd poll AND the wire-fd
// poll drain ctrl (the wire poll drains it for dmabuf-import replies), so if only
// the ctrl poll advanced, a plugin reply consumed by the wire poll's drainCtrl
// would be recorded-but-never-advanced -> the awaiting plugin op hangs (the ctrl
// fd is now empty, so onCtrlReadable never fires to advance it). Calling this from
// both polls closes that race.
void advanceAllPending(napi_env env) {
    if (g_pendingAllocs.empty() &&
        g_pendingConnBrokers.empty() && g_pendingInjects.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    advancePendingAllocs(env);    // SurfaceBufAllocated
    advanceConnBrokers(env);      // WireConnAdded
    advanceInjects(env);          // PluginInstanceInjected
    napi_close_handle_scope(env, scope);
}

void onWireReadable(uv_poll_t*, int status, int events) {
    if (status < 0 || !g_addon.compositor) return;
    if (events & UV_WRITABLE) g_addon.compositor->wirePumpOut();
    if (events & UV_READABLE) {
        // drainWire() advances the wire client's event manager, which may resolve
        // JS promises owned by a wire WebGPU binding (dawn.node) sharing this
        // connection (buffer map, work-done). Those resolutions call into N-API,
        // so an open HandleScope is required here.
        napi_handle_scope scope;
        napi_open_handle_scope(g_addon.env, &scope);
        g_addon.compositor->drainWire();
        // The wire advancing may let deferred imports complete on the GPU side,
        // whose ClientTexImported replies arrive on the ctrl fd; drain it too.
        g_addon.compositor->drainCtrl();
        fireJsImports(g_addon.env);
        fireOutputDescriptors(g_addon.env);
        // drainCtrl above may have consumed plugin-broker replies (alloc/begin/...);
        // advance them here too, else they are stranded (see advanceAllPending).
        advanceAllPending(g_addon.env);
        napi_close_handle_scope(g_addon.env, scope);
    }
    armWirePoll();  // update WRITABLE arming based on remaining queue
}

// Steady-state ctrl-fd drain: dispatches async control replies (ClientTexImported
// finishing dmabuf imports). Same Node thread; no threadsafe function needed.
// Also handles UV_WRITABLE: every steady-state ctrl send is buffered through
// CtrlSender, and a peer that briefly stops draining queues bytes here; this
// pumps what the socket can now accept so the queue eventually empties.
void onCtrlReadable(uv_poll_t*, int status, int events) {
    if (status < 0 || !g_addon.compositor) return;
    if (events & UV_WRITABLE) g_addon.compositor->ctrlPumpOut();
    if (events & UV_READABLE) {
        g_addon.compositor->drainCtrl();
        fireJsImports(g_addon.env);  // resolve JS dmabuf imports (opens its own scope)
        fireOutputDescriptors(g_addon.env);
        advanceAllPending(g_addon.env);
        armWirePoll();  // finishing an import flushes wire output (bind group etc.)
    }
    armCtrlPoll();  // re-arm UV_WRITABLE based on remaining queue
}

void armCtrlPoll() {
    if (!g_addon.loopRunning || !g_addon.compositor) return;
    int events = UV_READABLE;
    if (g_addon.compositor->ctrlHasPendingOut()) events |= UV_WRITABLE;
    uv_poll_start(&g_addon.ctrlPoll, events, onCtrlReadable);
}

void onInputReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.input) return;
    g_addon.input->drain();
}

#if OVERDRAW_KMS
void onSeatReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.seat) return;
    g_addon.seat->dispatch();
}
#endif

// Resolve `cb` with `result` (or null) and release the ref. Same Node thread.
void invokePluginCb(napi_env env, napi_ref cbRef, napi_value result) {
    napi_value cb, undefined;
    napi_get_reference_value(env, cbRef, &cb);
    napi_get_undefined(env, &undefined);
    napi_value arg = result;
    if (arg == nullptr) napi_get_null(env, &arg);
    napi_call_function(env, undefined, cb, 1, &arg, nullptr);
    napi_delete_reference(env, cbRef);
}

// Resolve in-flight surface-buffer allocations when SurfaceBufAllocated arrives
// (ctrl). cb({surfaceBufId} | null) -- the Worker owns the producer texture.
void advancePendingAllocs(napi_env env) {
    for (size_t i = 0; i < g_pendingAllocs.size();) {
        PendingAlloc& pa = g_pendingAllocs[i];
        int st = g_addon.compositor->surfaceBufAllocated(pa.surfaceBufId);
        if (st == 0) { ++i; continue; }  // pending
        napi_value result = nullptr;
        if (st == 1) {
            napi_value obj, sv;
            napi_create_object(env, &obj);
            napi_create_uint32(env, pa.surfaceBufId, &sv);
            napi_set_named_property(env, obj, "surfaceBufId", sv);
            result = obj;
        }
        invokePluginCb(env, pa.cb, result);
        g_pendingAllocs.erase(g_pendingAllocs.begin() + static_cast<long>(i));
    }
}

// Resolve pluginCreateConnection when WireConnAdded arrives.
void advanceConnBrokers(napi_env env) {
    for (size_t i = 0; i < g_pendingConnBrokers.size();) {
        PendingConnBroker& b = g_pendingConnBrokers[i];
        int st = g_addon.compositor->wireConnAdded(b.connId);
        if (st == 0) { ++i; continue; }
        napi_value result = nullptr;
        if (st == 1) {
            napi_value o, cv, fv;
            napi_create_object(env, &o);
            napi_create_uint32(env, b.connId, &cv);
            napi_create_int32(env, b.clientFd, &fv);
            napi_set_named_property(env, o, "connId", cv);
            napi_set_named_property(env, o, "fd", fv);
            result = o;
        } else {
            ::close(b.clientFd);
        }
        invokePluginCb(env, b.cb, result);
        g_pendingConnBrokers.erase(g_pendingConnBrokers.begin() + static_cast<long>(i));
    }
}

// Worker-brokered: resolve pluginInjectInstance when PluginInstanceInjected arrives.
void advanceInjects(napi_env env) {
    for (size_t i = 0; i < g_pendingInjects.size();) {
        PendingInject& pi = g_pendingInjects[i];
        int st = g_addon.compositor->pluginInstanceInjected(pi.connId);
        if (st == 0) { ++i; continue; }
        napi_value result; napi_get_boolean(env, st == 1, &result);
        invokePluginCb(env, pi.cb, result);
        g_pendingInjects.erase(g_pendingInjects.begin() + static_cast<long>(i));
    }
}

void onFrameTimer(uv_timer_t*) {
    if (!g_addon.compositor) return;
    // Dispatch client frame callbacks + dmabuf buffer releases FIRST, before
    // rendering. renderFrame() calls GetCurrentTexture on the HOST swapchain,
    // which can block/stall on host present pacing; if releases were gated
    // behind it, a Vulkan-WSI client would starve in vkAcquireNextImageKHR
    // whenever overdraw's own present stalled. Releasing first decouples the
    // client's buffer recycling from overdraw's host present cadence.
    notifyFrame();
    g_addon.lastNotified = g_addon.compositor->presented();
    g_addon.compositor->renderFrame();
    armWirePoll();  // renderFrame may have queued wire output (Submit/Present)
}

// start(gpuBinPath, onFrame?, onInput?, opts?) -> { width, height }
// opts (object, optional): one of
//   { width, height }                    -> headless mode (legacy shape)
//   { backend: "kms" | "nested", card?: "/dev/dri/cardN" }
//                                         -> select output backend.
//                                         -> default if absent: KMS.
//                                         -> headless takes precedence if width+height set.
// `card` defaults to "/dev/dri/card0" for KMS (libseat picks the first
// connected if absent). Used only when backend == "kms".
napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 4;
    napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "start(gpuBinPath) requires a path");

    char gpuBin[4096];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[0], gpuBin, sizeof(gpuBin), &len) != napi_ok)
        return throwError(env, "gpuBinPath must be a string");

    // Optional frame-event + input-event callbacks.
    g_addon.env = env;
    if (argc >= 2) {
        napi_valuetype t;
        napi_typeof(env, argv[1], &t);
        if (t == napi_function) napi_create_reference(env, argv[1], 1, &g_addon.onFrame);
    }
    if (argc >= 3) {
        napi_valuetype t;
        napi_typeof(env, argv[2], &t);
        if (t == napi_function) napi_create_reference(env, argv[2], 1, &g_addon.onInput);
    }

    // Optional opts object. Headless takes precedence (legacy + test path);
    // otherwise the backend choice picks KMS or nested.
    uint32_t hw = 0, hh = 0;
    std::string backend = "kms";  // production default
    std::string drmCardPath = "/dev/dri/card0";
    if (argc >= 4) {
        napi_valuetype t;
        napi_typeof(env, argv[3], &t);
        if (t == napi_object) {
            hw = getU32(env, argv[3], "width");
            hh = getU32(env, argv[3], "height");
            // backend string (optional). Headless ignores it.
            char buf[16] = {};
            size_t n = 0;
            napi_value v;
            if (napi_get_named_property(env, argv[3], "backend", &v) == napi_ok) {
                napi_valuetype bt;
                napi_typeof(env, v, &bt);
                if (bt == napi_string) {
                    napi_get_value_string_utf8(env, v, buf, sizeof(buf), &n);
                    backend = buf;
                }
            }
            char cbuf[256] = {};
            if (napi_get_named_property(env, argv[3], "card", &v) == napi_ok) {
                napi_valuetype bt;
                napi_typeof(env, v, &bt);
                if (bt == napi_string) {
                    napi_get_value_string_utf8(env, v, cbuf, sizeof(cbuf), &n);
                    drmCardPath = cbuf;
                }
            }
        }
    }
    const bool headless = hw != 0 && hh != 0;
    const bool wantKms = !headless && backend == "kms";

    auto gpu = overdraw::core::spawnGpuProcess(
        gpuBin, hw, hh,
        wantKms ? overdraw::core::OutputBackendKind::Kms
                : overdraw::core::OutputBackendKind::Nested);
    if (gpu.pid < 0) return throwError(env, "failed to spawn gpu process");
    g_addon.inputFd = gpu.inputFd;

#if OVERDRAW_KMS
    // In KMS mode, open the DRM card via libseat and SCM_RIGHTS-pass the fd
    // to the GPU process BEFORE bringUp's Hello dance. The GPU process is
    // blocked waiting for SetDrmFd before it constructs the KmsOutputBackend.
    if (wantKms) {
        if (!g_addon.seat) {
            g_addon.seat = std::make_unique<overdraw::core::Seat>();
            if (!g_addon.seat->open(nullptr, nullptr)) {
                const std::string err = "libseat open failed: " + g_addon.seat->error();
                g_addon.seat.reset();
                if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
                return throwError(env, err.c_str());
            }
            g_addon.seat->dispatch();
            if (!g_addon.seat->isActive()) {
                g_addon.seat.reset();
                if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
                return throwError(env, "libseat opened but seat not active (logind session?)");
            }
        }
        int drmFd = -1;
        int drmDeviceId = -1;
        if (!g_addon.seat->openDevice(drmCardPath.c_str(), drmFd, drmDeviceId)) {
            const std::string err = "libseat openDevice(" + drmCardPath + ") failed: "
                                  + g_addon.seat->error();
            g_addon.seat.reset();
            if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
            return throwError(env, err.c_str());
        }
        // Track for later closeDevice on Stop().
        g_addon.drmCardFd = drmFd;
        g_addon.drmCardDeviceId = drmDeviceId;
        // SCM_RIGHTS the fd to the GPU process via the ctrl socket.
        overdraw::ipc::Message msg{};
        msg.tag = overdraw::ipc::Tag::SetDrmFd;
        int fds[1] = { drmFd };
        if (!overdraw::ipc::sendMessageFds(gpu.ctrlFd, msg, fds, 1)) {
            g_addon.seat->closeDevice(drmDeviceId);
            ::close(drmFd);
            g_addon.drmCardFd = -1;
            g_addon.drmCardDeviceId = -1;
            g_addon.seat.reset();
            if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
            return throwError(env, "SetDrmFd sendmsg failed");
        }
        // The GPU process receives a dup'd fd; we keep ours open so libseat
        // can revoke / track it. Closed in Stop().
    }
#endif

    g_addon.compositor =
        std::make_unique<Compositor>(gpu.wireFd, gpu.ctrlFd, gpu.pid, headless, hw, hh, wantKms);
    if (!g_addon.compositor->bringUp()) {
        // Copy the error string out of the compositor BEFORE the dtor frees it.
        const std::string err = g_addon.compositor->error();
        g_addon.compositor.reset();
        if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
#if OVERDRAW_KMS
        // KMS bring-up may have opened a DRM card via libseat and a seat
        // handle; release both so a retry sees a clean slot.
        if (g_addon.drmCardFd >= 0) {
            if (g_addon.seat && g_addon.drmCardDeviceId >= 0) {
                g_addon.seat->closeDevice(g_addon.drmCardDeviceId);
            }
            ::close(g_addon.drmCardFd);
            g_addon.drmCardFd = -1;
            g_addon.drmCardDeviceId = -1;
        }
        if (g_addon.seat) {
            g_addon.seat->close();
            g_addon.seat.reset();
        }
#endif
        return throwError(env, err.c_str());
    }

    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    uv_poll_init(loop, &g_addon.wirePoll, g_addon.compositor->wireFd());
    uv_poll_start(&g_addon.wirePoll, UV_READABLE, onWireReadable);

    // Steady-state ctrl-fd drain: async dmabuf import replies (ClientTexImported)
    // are dispatched here off the Node thread's libuv loop, so commitSurfaceDmabuf
    // never blocks waiting for the round-trip.
    uv_poll_init(loop, &g_addon.ctrlPoll, g_addon.compositor->ctrlFd());
    uv_poll_start(&g_addon.ctrlPoll, UV_READABLE, onCtrlReadable);

    // Input backend follows the output backend: KMS uses libinput (the seat
    // already opened above for the DRM card opens evdev devices on libinput's
    // behalf); nested uses WaylandInputBackend (host-forwarded events from the
    // GPU process's host wl_seat). Headless has no display and no input source
    // on libuv -- it accepts injected events via injectHostInput from tests.
    if (wantKms) {
#if OVERDRAW_KMS
        // The seat is already open (KMS bring-up above opened it for the DRM
        // card). Reuse it for libinput device opens.
        const std::string seatName = g_addon.seat->name();
        auto libiBackend = std::make_unique<overdraw::core::LibinputBackend>(
            *g_addon.seat, seatName,
            g_addon.compositor->windowWidth(),
            g_addon.compositor->windowHeight());
        if (!libiBackend->init()) {
            const std::string err = "libinput init failed: " + libiBackend->error();
            // Mirror the bringUp() failure cleanup above: release the DRM card
            // and the seat so a retry sees a clean slate.
            if (g_addon.drmCardFd >= 0) {
                if (g_addon.drmCardDeviceId >= 0)
                    g_addon.seat->closeDevice(g_addon.drmCardDeviceId);
                ::close(g_addon.drmCardFd);
                g_addon.drmCardFd = -1;
                g_addon.drmCardDeviceId = -1;
            }
            g_addon.seat->close();
            g_addon.seat.reset();
            g_addon.compositor.reset();
            if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
            return throwError(env, err.c_str());
        }
        const int liFd = libiBackend->pollFd();
        libiBackend->start(&g_inputSink);
        g_addon.input = std::move(libiBackend);
        uv_poll_init(loop, &g_addon.inputPoll, liFd);
        uv_poll_start(&g_addon.inputPoll, UV_READABLE, onInputReadable);

        const int seatFd = g_addon.seat->pollFd();
        if (seatFd >= 0) {
            uv_poll_init(loop, &g_addon.seatPoll, seatFd);
            uv_poll_start(&g_addon.seatPoll, UV_READABLE, onSeatReadable);
            g_addon.seatPollActive = true;
        }

        // The input socket forwarded from the GPU process carries no events
        // in KMS mode (no host wl_seat on that side); close it.
        if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
#else
        g_addon.compositor.reset();
        if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
        return throwError(env, "backend=kms but build has OVERDRAW_KMS=OFF");
#endif
    } else if (g_addon.inputFd >= 0) {
        // Nested input backend: maps host-forwarded events to normalized
        // events. Output logical size == host window size in phase 1 (scale 1).
        auto wlBackend = std::make_unique<WaylandInputBackend>(
            g_addon.inputFd, g_addon.compositor->windowWidth(),
            g_addon.compositor->windowHeight());
        g_addon.waylandInput = wlBackend.get();
        wlBackend->start(&g_inputSink);
        g_addon.input = std::move(wlBackend);
        uv_poll_init(loop, &g_addon.inputPoll, g_addon.inputFd);
        uv_poll_start(&g_addon.inputPoll, UV_READABLE, onInputReadable);
    }

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

// gpuHandles() -> { instance: bigint, device: bigint } | null
// Raw wire-client handle pointers for the core's compositing instance+device,
// for a wire-retargeted dawn.node to wrap (dawn.node's wrapDevice). Both addons
// share the process-global wire proc table, so commands on the wrapped device
// dispatch over the core's existing wire connection.
napi_value GpuHandles(napi_env env, napi_callback_info) {
    if (!g_addon.compositor) return nullptr;
    g_addon.compositor->markWireSharedWithJs();
    auto inst = reinterpret_cast<uint64_t>(g_addon.compositor->instanceHandle());
    auto dev = reinterpret_cast<uint64_t>(g_addon.compositor->deviceHandle());
    napi_value obj, iv, dv;
    napi_create_object(env, &obj);
    napi_create_bigint_uint64(env, inst, &iv);
    napi_create_bigint_uint64(env, dev, &dv);
    napi_set_named_property(env, obj, "instance", iv);
    napi_set_named_property(env, obj, "device", dv);
    return obj;
}

// === Plugin GPU broker (the plugin Worker owns its wire client; the core only
// brokers the side channel) ================================================

// pluginCreateConnection(cb): addWireConnection + wait WireConnAdded; cb({connId,
// fd} | null). The fd (client end) is handed to the Worker (a plain integer --
// same process). Async via the ctrl poll.
napi_value PluginCreateConnection(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto h = g_addon.compositor->addWireConnection();
    if (h.clientFd < 0) return throwError(env, "addWireConnection failed");
    napi_ref cbRef; napi_create_reference(env, argv[0], 1, &cbRef);
    g_pendingConnBrokers.push_back({h.connId, h.clientFd, cbRef});
    armCtrlPoll();
    return nullptr;
}

// pluginInjectInstance(connId, instId, instGen, cb): relay the instance handle the
// Worker reserved; cb(ok) when PluginInstanceInjected arrives. Async.
napi_value PluginInjectInstance(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t connId = 0, id = 0, gen = 0;
    napi_get_value_uint32(env, argv[0], &connId);
    napi_get_value_uint32(env, argv[1], &id);
    napi_get_value_uint32(env, argv[2], &gen);
    g_addon.compositor->injectPluginInstance(connId, id, gen);
    napi_ref cbRef; napi_create_reference(env, argv[3], 1, &cbRef);
    g_pendingInjects.push_back({connId, cbRef});
    armCtrlPoll();
    return nullptr;
}

// pluginSetTickDevice(connId, devId, devGen): relay the Worker's device handle so
// the GPU process DeviceTick's it. Fire-and-forget.
napi_value PluginSetTickDevice(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t connId = 0, id = 0, gen = 0;
    napi_get_value_uint32(env, argv[0], &connId);
    napi_get_value_uint32(env, argv[1], &id);
    napi_get_value_uint32(env, argv[2], &gen);
    g_addon.compositor->setPluginTickDevice(connId, id, gen);
    armCtrlPoll();
    return nullptr;
}

// pluginConsumerTexture(surfaceBufId) -> bigint: the core's wrapped-able wire
// texture handle for the consumer side (the JS compositor wraps + samples it).
napi_value PluginConsumerTexture(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    auto t = reinterpret_cast<uint64_t>(
        g_addon.compositor->coreSurfaceTexture(u32(env, argv[0])));
    napi_value out; napi_create_bigint_uint64(env, t, &out);
    return out;
}

// pluginAllocSurfaceBufferW(connId, w, h, prodTexId, prodTexGen, prodDevId,
// prodDevGen, cb): Worker-brokered surface alloc. The WORKER reserved the producer
// texture on its wire client and passes the handles; the core reserves the
// consumer texture and sends AllocSurfaceBuf. cb({surfaceBufId, consumerTexture} |
// null) -- the Worker already has its producer handle. Async.
// 9th arg `pluginReservePointSerial` (BigInt) is the worker's wire-bytesQueued
// sampled AFTER its flush that committed the producer-texture reserve. The core
// captures the analogous core-wire serial inside reserveCoreSurfaceTexture and
// passes both into AllocSurfaceBuf, so the GPU process can gate each side's
// InjectTexture on its own wire reader catching up (the recycled-handle hazard).
napi_value PluginAllocSurfaceBufferW(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 9; napi_value argv[9];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 9) return throwError(env, "pluginAllocSurfaceBufferW(connId,w,h,ptId,ptGen,pdId,pdGen,pluginSerial,cb)");
    uint32_t connId = u32(env, argv[0]), w = u32(env, argv[1]), h = u32(env, argv[2]);
    uint32_t ptId = u32(env, argv[3]), ptGen = u32(env, argv[4]);
    uint32_t pdId = u32(env, argv[5]), pdGen = u32(env, argv[6]);
    if (w == 0 || h == 0) return throwError(env, "pluginAllocSurfaceBufferW: bad size");
    uint64_t pluginSerial = 0; bool lossless = false;
    napi_get_value_bigint_uint64(env, argv[7], &pluginSerial, &lossless);
    auto core = g_addon.compositor->reserveCoreSurfaceTexture(w, h);
    if (core.surfaceBufId == 0) return throwError(env, "core texture reserve failed");
    g_addon.compositor->sendAllocSurfaceBuf(
        core.surfaceBufId, connId, w, h, {pdId, pdGen}, {ptId, ptGen},
        {core.device.id, core.device.generation}, {core.texture.id, core.texture.generation},
        pluginSerial, core.coreWireSerial);
    napi_ref cbRef; napi_create_reference(env, argv[8], 1, &cbRef);
    g_pendingAllocs.push_back({core.surfaceBufId, connId, cbRef});
    armCtrlPoll();
    return nullptr;
}

// coreAllocComposeBufferW(connId, w, h, conTexId, conTexGen, conDevId, conDevGen,
// pluginSerial, cb): the reverse-direction alloc (phase 5b). The core is the
// PRODUCER (renders into the dmabuf), the plugin is the CONSUMER (samples it).
// The WORKER reserved its consumer-side texture on its wire client and passes
// those handles; the core reserves its producer-side texture and sends
// AllocComposeBuf. cb({surfaceBufId, producerTexture} | null) -- the Worker
// already has its consumer handle. Async.
// pluginSerial is the worker's PLUGIN-wire bytesQueued AFTER the flush that
// committed the consumer-texture reserve (it gates the consumer-side
// InjectTexture on the plugin wire's barrier).
napi_value CoreAllocComposeBufferW(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 9; napi_value argv[9];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 9) return throwError(env, "coreAllocComposeBufferW(connId,w,h,ctId,ctGen,cdId,cdGen,pluginSerial,cb)");
    uint32_t connId = u32(env, argv[0]), w = u32(env, argv[1]), h = u32(env, argv[2]);
    uint32_t ctId = u32(env, argv[3]), ctGen = u32(env, argv[4]);
    uint32_t cdId = u32(env, argv[5]), cdGen = u32(env, argv[6]);
    if (w == 0 || h == 0) return throwError(env, "coreAllocComposeBufferW: bad size");
    uint64_t pluginSerial = 0; bool lossless = false;
    napi_get_value_bigint_uint64(env, argv[7], &pluginSerial, &lossless);
    auto core = g_addon.compositor->reserveCoreComposeTexture(w, h);
    if (core.surfaceBufId == 0) return throwError(env, "core compose texture reserve failed");
    // Wire shape is identical to AllocSurfaceBuf: pluginDevice/pluginTexture
    // name the plugin-side handles (here the CONSUMER), device/texture name
    // the core-side handles (here the PRODUCER).
    g_addon.compositor->sendAllocComposeBuf(
        core.surfaceBufId, connId, w, h, {cdId, cdGen}, {ctId, ctGen},
        {core.device.id, core.device.generation}, {core.texture.id, core.texture.generation},
        pluginSerial, core.coreWireSerial);
    napi_ref cbRef; napi_create_reference(env, argv[8], 1, &cbRef);
    g_pendingAllocs.push_back({core.surfaceBufId, connId, cbRef});
    armCtrlPoll();
    return nullptr;
}

// Extract argv[0] as a uint32 (used by the surface-buffer entry points below).
static uint32_t arg0u32(napi_env env, napi_callback_info info, napi_value* argv, size_t n) {
    size_t argc = n; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t v = 0; napi_get_value_uint32(env, argv[0], &v); return v;
}

// writeConsumerBegin(surfaceBufId) / writeConsumerEnd(surfaceBufId): in-band
// consumer Begin/End on the core wire (replaces the pluginSurfaceConsumerBegin/
// End ctrl round-trips). Synchronous frame writes -- no pendingBegins callback;
// the FIFO wire ordering replaces the begin-done acknowledgement. The caller
// still gates End on afterCurrentFrame (GPU-read completion).
napi_value WriteConsumerBegin(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[1]; uint32_t id = arg0u32(env, info, argv, 1);
    g_addon.compositor->writeConsumerBeginAccess(id);
    return nullptr;
}
napi_value WriteConsumerEnd(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[1]; uint32_t id = arg0u32(env, info, argv, 1);
    g_addon.compositor->writeConsumerEndAccess(id);
    return nullptr;
}

// writeProducerBegin / writeProducerEnd: in-band producer Begin/End on the
// core wire (phase 5b). The core IS the producer for compose buffers, so
// producer Begin/End ride the core wire (inverted from plugin-overlay
// surfaces where producer Begin/End ride the plugin wire).
napi_value WriteProducerBegin(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[1]; uint32_t id = arg0u32(env, info, argv, 1);
    g_addon.compositor->writeProducerBeginAccess(id);
    return nullptr;
}
napi_value WriteProducerEnd(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[1]; uint32_t id = arg0u32(env, info, argv, 1);
    g_addon.compositor->writeProducerEndAccess(id);
    return nullptr;
}

// pluginReleaseSurfaceBuffer(surfaceBufId): destroy a ring slot's surfaceBuf (GPU
// process frees the dmabuf/STM/textures; core reclaims its reservation). The JS
// caller has gated this on the consumer's GPU read completing. Fire-and-forget.
napi_value PluginReleaseSurfaceBuffer(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[1]; uint32_t id = arg0u32(env, info, argv, 1);
    g_addon.compositor->releaseSurfaceBuf(id);
    armCtrlPoll();
    return nullptr;
}

// Pending JS dmabuf-import callbacks, keyed by importId. The callback fires once
// when the import completes (or fails), then the ref is released.
std::unordered_map<uint32_t, napi_ref> g_jsImportCbs;

// Drain completed JS dmabuf imports and invoke their JS callbacks with the
// injected texture handle (BigInt) or null on failure. Runs on the Node thread
// (from the ctrl/wire poll). Opens its own HandleScope.
void fireJsImports(napi_env env) {
    if (!g_addon.compositor) return;
    std::vector<Compositor::JsImportDone> done;
    g_addon.compositor->takeCompletedJsImports(done);
    if (done.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    for (auto& d : done) {
        auto it = g_jsImportCbs.find(d.importId);
        if (it == g_jsImportCbs.end()) continue;
        napi_value cb, undefined, arg;
        napi_get_reference_value(env, it->second, &cb);
        napi_get_undefined(env, &undefined);
        if (d.ok) {
            napi_create_bigint_uint64(env, reinterpret_cast<uint64_t>(d.tex.Get()), &arg);
        } else {
            napi_get_null(env, &arg);
        }
        napi_call_function(env, undefined, cb, 1, &arg, nullptr);
        napi_delete_reference(env, it->second);
        g_jsImportCbs.erase(it);
    }
    napi_close_handle_scope(env, scope);
    // `done` destructs here: each JsImportDone.tex releases the core's ref, having
    // handed ownership to JS (wrapTexture AddRef'd inside the callback).
}

// Drain queued OutputDescriptor messages and invoke the JS onOutput callback
// for each (one call per descriptor; the JS layer applies the per-descriptor
// update to state.outputs). Same Node thread as ctrl/wire poll.
void fireOutputDescriptors(napi_env env) {
    if (!g_addon.compositor || !g_addon.onOutput) return;
    std::vector<Compositor::OutputDescriptorMsg> descs;
    g_addon.compositor->takePendingOutputDescriptors(descs);
    if (descs.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onOutput, &cb);
    napi_get_undefined(env, &undefined);
    for (const auto& d : descs) {
        napi_value obj, v, sname, smake, smodel;
        napi_create_object(env, &obj);
        napi_create_uint32(env, d.width,            &v); napi_set_named_property(env, obj, "width", v);
        napi_create_uint32(env, d.height,           &v); napi_set_named_property(env, obj, "height", v);
        napi_create_uint32(env, d.refreshMhz,       &v); napi_set_named_property(env, obj, "refreshMhz", v);
        napi_create_uint32(env, d.scale,            &v); napi_set_named_property(env, obj, "scale", v);
        napi_create_uint32(env, d.transform,        &v); napi_set_named_property(env, obj, "transform", v);
        napi_create_uint32(env, d.physicalWidthMm,  &v); napi_set_named_property(env, obj, "physicalWidthMm", v);
        napi_create_uint32(env, d.physicalHeightMm, &v); napi_set_named_property(env, obj, "physicalHeightMm", v);
        napi_create_string_utf8(env, d.name.c_str(),  d.name.size(),  &sname);
        napi_create_string_utf8(env, d.make.c_str(),  d.make.size(),  &smake);
        napi_create_string_utf8(env, d.model.c_str(), d.model.size(), &smodel);
        napi_set_named_property(env, obj, "name",  sname);
        napi_set_named_property(env, obj, "make",  smake);
        napi_set_named_property(env, obj, "model", smodel);
        napi_call_function(env, undefined, cb, 1, &obj, nullptr);
    }
    napi_close_handle_scope(env, scope);
}

// createTextureFromDmabuf(fd, w, h, fourcc, modHi, modLo, offset, stride, cb)
// Async: imports a client dmabuf as a wire texture (server-side reserve/inject)
// and invokes cb(handleBigInt | null) when done. JS wraps the handle via
// dawn.node wrapTexture. The JS API layer presents this as a Promise.
napi_value CreateTextureFromDmabuf(napi_env env, napi_callback_info info) {
    size_t argc = 9; napi_value argv[9];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 9) return throwError(env, "createTextureFromDmabuf(fd,w,h,fourcc,modHi,modLo,offset,stride,cb)");
    if (!g_addon.compositor) return throwError(env, "compositor not running");
    uint32_t w = 0, h = 0, fourcc = 0, modHi = 0, modLo = 0, offset = 0, stride = 0;
    napi_get_value_uint32(env, argv[1], &w);
    napi_get_value_uint32(env, argv[2], &h);
    napi_get_value_uint32(env, argv[3], &fourcc);
    napi_get_value_uint32(env, argv[4], &modHi);
    napi_get_value_uint32(env, argv[5], &modLo);
    napi_get_value_uint32(env, argv[6], &offset);
    napi_get_value_uint32(env, argv[7], &stride);
    napi_ref cbRef;
    napi_create_reference(env, argv[8], 1, &cbRef);

    int fd = overdraw::wayland::peekWaylandFd(env, argv[0]);
    uint32_t importId = 0;
    if (fd >= 0) {
        uint64_t modifier = (static_cast<uint64_t>(modHi) << 32) | modLo;
        importId = g_addon.compositor->importDmabufForJs(fd, w, h, fourcc, modifier, offset, stride);
        ::close(fd);  // GPU process dup'd it over SCM_RIGHTS
    }
    armCtrlPoll();
    if (importId == 0) {
        // Could not start: invoke cb(null) now.
        napi_value cb, undefined, nul;
        napi_get_reference_value(env, cbRef, &cb);
        napi_get_undefined(env, &undefined);
        napi_get_null(env, &nul);
        napi_call_function(env, undefined, cb, 1, &nul, nullptr);
        napi_delete_reference(env, cbRef);
        napi_value zero; napi_create_uint32(env, 0, &zero);
        return zero;
    }
    g_jsImportCbs[importId] = cbRef;
    napi_value out; napi_create_uint32(env, importId, &out);
    return out;  // JS uses this importId to release later
}

// setExternalCompositor(bool) -> undefined. When true, the C++ Compositor stops
// rendering/presenting (the JS compositor drives the frame via acquireOutputTexture
// + presentOutput).
// acquireOutputTexture() -> bigint | null. The host swapchain's current texture
// handle (nested), for the JS compositor to wrap + render into this frame.
napi_value AcquireOutputTexture(napi_env env, napi_callback_info) {
    if (!g_addon.compositor) return nullptr;
    WGPUTexture t = g_addon.compositor->acquireOutputTextureHandle();
    if (!t) return nullptr;
    napi_value out;
    napi_create_bigint_uint64(env, reinterpret_cast<uint64_t>(t), &out);
    return out;
}

// presentOutput() -> undefined. Present the acquired output texture.
napi_value PresentOutput(napi_env env, napi_callback_info) {
    if (g_addon.compositor) g_addon.compositor->presentOutput();
    return nullptr;
}

// outputFormat() -> string. The swapchain's WGPUTextureFormat as a WebGPU format
// string, so the JS pipeline's color target matches the swapchain.
napi_value OutputFormat(napi_env env, napi_callback_info) {
    const char* s = "bgra8unorm";
    if (g_addon.compositor) {
        switch (g_addon.compositor->outputFormat()) {
            case wgpu::TextureFormat::BGRA8Unorm: s = "bgra8unorm"; break;
            case wgpu::TextureFormat::RGBA8Unorm: s = "rgba8unorm"; break;
            case wgpu::TextureFormat::BGRA8UnormSrgb: s = "bgra8unorm-srgb"; break;
            case wgpu::TextureFormat::RGBA8UnormSrgb: s = "rgba8unorm-srgb"; break;
            default: s = "bgra8unorm"; break;
        }
    }
    napi_value out; napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &out);
    return out;
}

// releaseDmabufImport(importId) -> undefined
napi_value ReleaseDmabufImport(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!g_addon.compositor) return nullptr;
    uint32_t importId = 0;
    napi_get_value_uint32(env, argv[0], &importId);
    if (importId != 0) g_addon.compositor->releaseDmabufImport(importId);
    armCtrlPoll();
    return nullptr;
}

// writeBeginAccess(importId) -> bool. In-band per-frame BeginAccess: write a
// kind=1 frame on the core WIRE socket for the client texture importId resolves
// to. Replaces beginClientAccessSync's ctrl round-trip; does NOT block the Node
// thread. The frame's FIFO position before the sample's wire batch guarantees
// the GPU process opens the bracket before HandleCommands decodes the sample
// (appendFrame flushes staged Dawn bytes first). Returns false iff the import
// is unknown (a JS-gate bug -- the caller gates Begin on the import being live).
napi_value WriteBeginAccess(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!g_addon.compositor) { napi_value f; napi_get_boolean(env, false, &f); return f; }
    uint32_t importId = 0;
    napi_get_value_uint32(env, argv[0], &importId);
    const bool ok = importId != 0 && g_addon.compositor->writeClientTexBeginAccess(importId);
    napi_value out; napi_get_boolean(env, ok, &out); return out;
}

// writeEndAccess(importId) -> undefined. In-band per-frame EndAccess: write a
// kind=2 frame on the core WIRE socket. Its FIFO position after the submit's
// wire batch guarantees the GPU process closes the bracket only after decoding
// the sample commands -- no wireSerial tag, no WireBarrier deferral. (The GPU
// completion-ordering for buffer recycling stays the caller's concern, as it
// was: this only orders decode, not GPU execution.)
napi_value WriteEndAccess(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!g_addon.compositor) return nullptr;
    uint32_t importId = 0;
    napi_get_value_uint32(env, argv[0], &importId);
    if (importId != 0) g_addon.compositor->writeClientTexEndAccess(importId);
    return nullptr;
}

// shmView(poolId, offset, length) -> ArrayBuffer | null
// Zero-copy external ArrayBuffer over the pool's mmap region, so JS can upload
// shm pixels with device.queue.writeTexture without a copy. The buffer aliases
// the live mapping; it MUST be consumed synchronously (at commit) and not held
// past the pool's lifetime (no finalizer -- the mapping is owned by ShmRegistry).
napi_value ShmView(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t poolId = 0, offset = 0, length = 0;
    napi_get_value_uint32(env, argv[0], &poolId);
    napi_get_value_uint32(env, argv[1], &offset);
    napi_get_value_uint32(env, argv[2], &length);
    const uint8_t* p = g_addon.shm.view(poolId, offset, length);
    if (!p) return nullptr;
    napi_value ab;
    if (napi_create_external_arraybuffer(env, const_cast<uint8_t*>(p), length,
                                         nullptr, nullptr, &ab) != napi_ok) {
        return nullptr;
    }
    return ab;
}

napi_value Stop(napi_env env, napi_callback_info) {
    if (g_addon.loopRunning) {
        uv_timer_stop(&g_addon.frameTimer);
        uv_poll_stop(&g_addon.wirePoll);
        uv_poll_stop(&g_addon.ctrlPoll);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.frameTimer), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.wirePoll), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.ctrlPoll), nullptr);
        if (g_addon.input) {
            uv_poll_stop(&g_addon.inputPoll);
            uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.inputPoll), nullptr);
        }
#if OVERDRAW_KMS
        if (g_addon.seatPollActive) {
            uv_poll_stop(&g_addon.seatPoll);
            uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.seatPoll), nullptr);
            g_addon.seatPollActive = false;
        }
#endif
        g_addon.loopRunning = false;
    }
    // Reject any still-pending plugin broker requests.
    for (auto& b : g_pendingConnBrokers) { ::close(b.clientFd); napi_delete_reference(env, b.cb); }
    g_pendingConnBrokers.clear();
    for (auto& pi : g_pendingInjects) napi_delete_reference(env, pi.cb);
    g_pendingInjects.clear();
    for (auto& pa : g_pendingAllocs) napi_delete_reference(env, pa.cb);
    g_pendingAllocs.clear();
    if (g_addon.input) {
        g_addon.input->stop();
        g_addon.input.reset();
        g_addon.waylandInput = nullptr;
    }
#if OVERDRAW_KMS
    // Release the DRM card (if we opened one for KMS) BEFORE closing the seat,
    // so libseat's accounting stays consistent.
    if (g_addon.drmCardFd >= 0) {
        if (g_addon.seat && g_addon.drmCardDeviceId >= 0) {
            g_addon.seat->closeDevice(g_addon.drmCardDeviceId);
        }
        ::close(g_addon.drmCardFd);
        g_addon.drmCardFd = -1;
        g_addon.drmCardDeviceId = -1;
    }
    // Seat closes after libinput so libinput's close_restricted can release
    // device ids through it.
    if (g_addon.seat) {
        g_addon.seat->close();
        g_addon.seat.reset();
    }
#endif
    if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
    if (g_addon.compositor) {
        // Drain the wire briefly so any in-flight GPU completion callbacks (e.g.
        // the last frame's queue.onSubmittedWorkDone, used by the JS compositor's
        // buffer-release lifecycle) resolve with Success BEFORE we disconnect.
        // Disconnect cancels pending futures, and a wire WebGPU binding (dawn.node)
        // throws on a cancelled callback -> teardown crash. The frame timer is
        // already stopped above, so no new callbacks are issued during this drain.
        napi_handle_scope drainScope;
        napi_open_handle_scope(env, &drainScope);
        for (int i = 0; i < 25; ++i) {  // ~50ms; the last submit completes within a frame
            g_addon.compositor->drainWire();
            g_addon.compositor->drainCtrl();
            fireJsImports(env);
            ::usleep(2000);
        }
        napi_close_handle_scope(env, drainScope);
        g_addon.compositor->shutdown();
        g_addon.compositor.reset();
    }
    if (g_addon.onFrame) {
        napi_delete_reference(env, g_addon.onFrame);
        g_addon.onFrame = nullptr;
    }
    if (g_addon.onInput) {
        napi_delete_reference(env, g_addon.onInput);
        g_addon.onInput = nullptr;
    }
    if (g_addon.onOutput) {
        napi_delete_reference(env, g_addon.onOutput);
        g_addon.onOutput = nullptr;
    }
    // Release the xkb keymap singleton. Built on demand by ensureKeymap()
    // from either keymapInfo (client wl_keyboard bind) or keyUpdate (host
    // key-down); a subsequent start()/stop() cycle must see fresh state.
    g_addon.keymap.reset();
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
    napi_value minted = nullptr;
    if (!g_addon.trampoline->postEvent(argv[0], opcode, argv[2], &minted))
        return throwError(env, "postEvent failed");
    // If the event minted a server-side new_id (e.g. wl_data_device.data_offer),
    // return the wrapped new resource so JS can send events on it; else undefined.
    if (minted) return minted;
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// destroyResource(resource) -> undefined
// Server-initiated destruction (e.g. wl_callback after its `done` event was
// sent: the protocol says the callback IS the event and the resource has no
// more uses). Trampoline drops the libwayland resource + its napi wrapper;
// no-op if already destroyed.
napi_value DestroyResource(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1 || !g_addon.trampoline) {
        napi_value undef; napi_get_undefined(env, &undef); return undef;
    }
    g_addon.trampoline->destroyResource(argv[0]);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// clientId(resource) -> number : a stable per-client id (wl_client pointer) for
// associating resources created by the same client. 0 on error.
napi_value ClientId(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1 || !g_addon.trampoline) { napi_value z; napi_create_double(env, 0, &z); return z; }
    uint64_t id = g_addon.trampoline->clientIdOf(argv[0]);
    napi_value out; napi_create_double(env, static_cast<double>(id), &out);
    return out;
}

// Build the singleton keymap if it doesn't exist yet. Both keymapInfo()
// (a client binds wl_keyboard) and keyUpdate() (every host key-down) can
// be the first caller -- the binding chain consults keysyms whether or
// not any overdraw client has bound a keyboard. Returns false only if
// xkbcommon failed to compile the default keymap.
bool ensureKeymap() {
    if (g_addon.keymap) return true;
    auto km = std::make_unique<Keymap>();
    if (!km->init()) return false;
    g_addon.keymap = std::move(km);
    return true;
}

// updateOutputSize(width, height) -> undefined
// Update the input backend's notion of output size (used for pointer coordinate
// mapping / cursor clamping). Called when state.outputs's logicalSize changes
// (host-window resize in nested mode; KMS mode change later). Silent no-op if
// no input backend is active.
napi_value UpdateOutputSize(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "updateOutputSize(width, height) requires 2 args");
    uint32_t w = 0, h = 0;
    napi_get_value_uint32(env, argv[0], &w);
    napi_get_value_uint32(env, argv[1], &h);
    if (g_addon.input) g_addon.input->setOutputSize(w, h);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnOutputDescriptor(cb) -> undefined
// Register a JS callback fired for each OutputDescriptor message arriving from
// the GPU process. The callback receives one object per descriptor with
// {width, height, refreshMhz, scale, transform, physicalWidthMm,
//  physicalHeightMm, name, make, model}. Called on the Node thread from the
// ctrl/wire poll. Passing null (or omitting the arg) clears the callback.
napi_value SetOnOutputDescriptor(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (g_addon.onOutput) {
        napi_delete_reference(env, g_addon.onOutput);
        g_addon.onOutput = nullptr;
    }
    if (argc >= 1) {
        napi_valuetype t; napi_typeof(env, argv[0], &t);
        if (t == napi_function) napi_create_reference(env, argv[0], 1, &g_addon.onOutput);
    }
    // The GPU process sends the first OutputDescriptor right after SurfaceReady
    // (during bringUp). bringUp doesn't drain past SurfaceReady, so the
    // descriptor may still be in the ctrl-fd kernel buffer when JS registers
    // its callback. Drain ctrl now and fire so the freshly-registered callback
    // sees the bring-up descriptor synchronously; without this, state.outputs
    // can be the seed values when the first client binds wl_output.
    if (g_addon.compositor) g_addon.compositor->drainCtrl();
    fireOutputDescriptors(env);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// keymapInfo() -> { fd: WaylandFd, format, size } | null
// Each call returns a fresh dup of the keymap memfd wrapped as a WaylandFd
// (each client gets its own to mmap).
napi_value KeymapInfo(napi_env env, napi_callback_info) {
    if (!ensureKeymap()) { napi_value n; napi_get_null(env, &n); return n; }
    int fd = g_addon.keymap->dupFd();
    if (fd < 0) { napi_value n; napi_get_null(env, &n); return n; }
    napi_value obj; napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "fd", overdraw::wayland::makeWaylandFd(env, fd));
    napi_value fmt; napi_create_uint32(env, g_addon.keymap->format(), &fmt);
    napi_set_named_property(env, obj, "format", fmt);
    napi_value sz; napi_create_uint32(env, g_addon.keymap->size(), &sz);
    napi_set_named_property(env, obj, "size", sz);
    return obj;
}

// keyUpdate(evdevKey, pressed) -> { modsDepressed, modsLatched, modsLocked, group, keysym }
// Feeds the key into the xkb state and returns the resulting modifier masks for
// wl_keyboard.modifiers, plus the resolved keysym (post-update) for binding-chain
// matching. Returns zeros if the keymap cannot be built.
napi_value KeyUpdate(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t key = 0; bool pressed = false;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &key);
    if (argc >= 2) napi_get_value_bool(env, argv[1], &pressed);
    uint32_t dep = 0, lat = 0, lock = 0, grp = 0, sym = 0;
    if (ensureKeymap()) {
        g_addon.keymap->updateKey(key, pressed);
        g_addon.keymap->modifiers(dep, lat, lock, grp);
        sym = g_addon.keymap->keysym(key);
    }
    napi_value obj; napi_create_object(env, &obj);
    auto setU = [&](const char* k, uint32_t val) {
        napi_value n; napi_create_uint32(env, val, &n);
        napi_set_named_property(env, obj, k, n);
    };
    setU("modsDepressed", dep);
    setU("modsLatched", lat);
    setU("modsLocked", lock);
    setU("group", grp);
    setU("keysym", sym);
    return obj;
}

// resolveCursorShape(name, sizePx, scale)
//   -> { width, height, hotspotX, hotspotY, rgba: Uint8Array } | null
// Looks up the XCursor shape in the current theme (XCURSOR_THEME env, with
// inheritance walk). Returns BGRA8 pixel bytes tightly packed at width*height*4.
// For 'default', a built-in 16x16 fallback ensures the call never fails.
napi_value ResolveCursorShape(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) { napi_value n; napi_get_null(env, &n); return n; }

    char nameBuf[256];
    size_t nameLen = 0;
    if (napi_get_value_string_utf8(env, argv[0], nameBuf, sizeof(nameBuf), &nameLen)
        != napi_ok) {
        napi_value n; napi_get_null(env, &n); return n;
    }
    std::string name(nameBuf, nameLen);

    uint32_t sizePx = 24;
    if (argc >= 2) napi_get_value_uint32(env, argv[1], &sizePx);
    if (sizePx == 0) sizePx = 24;
    uint32_t scale = 1;
    if (argc >= 3) napi_get_value_uint32(env, argv[2], &scale);
    if (scale == 0) scale = 1;

    overdraw::cursor::ResolvedShape r;
    if (!overdraw::cursor::resolveShape(name, sizePx, scale, r)) {
        napi_value n; napi_get_null(env, &n); return n;
    }

    napi_value obj; napi_create_object(env, &obj);
    auto setU = [&](const char* k, uint32_t val) {
        napi_value n; napi_create_uint32(env, val, &n);
        napi_set_named_property(env, obj, k, n);
    };
    setU("width", r.width);
    setU("height", r.height);
    setU("hotspotX", r.hotspotX);
    setU("hotspotY", r.hotspotY);

    // Copy the pixel bytes into a JS-owned ArrayBuffer (not external; the
    // ResolvedShape's vector is freed when this function returns).
    napi_value ab; void* data;
    napi_create_arraybuffer(env, r.rgba.size(), &data, &ab);
    if (!r.rgba.empty()) std::memcpy(data, r.rgba.data(), r.rgba.size());
    napi_value ta;
    napi_create_typedarray(env, napi_uint8_array, r.rgba.size(), ab, 0, &ta);
    napi_set_named_property(env, obj, "rgba", ta);
    return obj;
}

// shmCreatePool(fd, size) -> poolId (0 on failure)
// `fd` is a WaylandFd; we take the raw fd out of it (transferring ownership) and
// mmap it.
napi_value ShmCreatePool(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "shmCreatePool(fd, size) requires two args");
    uint32_t size = 0; napi_get_value_uint32(env, argv[1], &size);
    int fd = overdraw::wayland::takeWaylandFd(env, argv[0]);
    uint32_t poolId = g_addon.shm.createPool(fd, size);  // closes fd on failure
    napi_value out; napi_create_uint32(env, poolId, &out);
    return out;
}

// shmResizePool(poolId, newSize) -> boolean
napi_value ShmResizePool(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "shmResizePool(poolId, newSize) requires two args");
    uint32_t poolId = 0; napi_get_value_uint32(env, argv[0], &poolId);
    uint32_t newSize = 0; napi_get_value_uint32(env, argv[1], &newSize);
    napi_value out; napi_get_boolean(env, g_addon.shm.resizePool(poolId, newSize), &out);
    return out;
}

// shmDestroyPool(poolId) -> undefined
napi_value ShmDestroyPool(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "shmDestroyPool(poolId) requires a poolId");
    uint32_t poolId = 0; napi_get_value_uint32(env, argv[0], &poolId);
    g_addon.shm.destroyPool(poolId);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// shmBufferRef(poolId) / shmBufferUnref(poolId): a wl_buffer carved from a pool
// keeps its mapping alive past wl_shm_pool.destroy (per the Wayland spec).
napi_value ShmBufferRef(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t poolId = 0; if (argc >= 1) napi_get_value_uint32(env, argv[0], &poolId);
    g_addon.shm.addBufferRef(poolId);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}
napi_value ShmBufferUnref(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t poolId = 0; if (argc >= 1) napi_get_value_uint32(env, argv[0], &poolId);
    g_addon.shm.releaseBufferRef(poolId);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// commitSurfaceBuffer(surfaceId, poolId, offset, width, height, stride) -> boolean
// Resolve the pool region and upload it to the surface's GPU texture. Requires
// the compositor to be running. Returns false if pool/region invalid.
// commitSurfaceDmabuf(surfaceId, fdHandle, width, height, drmFourcc,
//                     modifierHi, modifierLo, offset, stride) -> boolean
// Take the client dmabuf fd (a WaylandFd) and import it as a sampled texture for
// the surface. Returns false if the import is rejected.
// takeImportedSurfaces() -> Array<{ id, width, height }>
// Surfaces that gained presentable content (first or later commit completed),
// for both shm and dmabuf. JS uses this as a single map-on-first-content signal.
// takeFreedBuffers() -> number[]  (dmabuf bufferIds whose GPU read completed)
// injectInput(event) -> undefined
// Synthetic input backend (test seam): build a normalized InputEvent from a plain
// JS object and feed it through the SAME InputSink the host seat uses, so it
// flows to the JS onInput callback and the seat routing exactly as a real host
// event would. `event.type` is one of the inputTypeName() strings; the remaining
// fields mirror the onInput payload. Same Node thread; no marshaling.
napi_value InjectInput(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "injectInput(event) requires an event object");

    std::string type = getStr(env, argv[0], "type");
    InputEvent ev{};
    ev.serial = getU32(env, argv[0], "serial");
    ev.time = getU32(env, argv[0], "time");

    if (type == "pointerEnter")            ev.type = InputEventType::PointerEnter;
    else if (type == "pointerLeave")       ev.type = InputEventType::PointerLeave;
    else if (type == "pointerMotion")      ev.type = InputEventType::PointerMotion;
    else if (type == "pointerButton")      ev.type = InputEventType::PointerButton;
    else if (type == "pointerAxis")        ev.type = InputEventType::PointerAxis;
    else if (type == "pointerFrame")       ev.type = InputEventType::PointerFrame;
    else if (type == "keyboardEnter")      ev.type = InputEventType::KeyboardEnter;
    else if (type == "keyboardLeave")      ev.type = InputEventType::KeyboardLeave;
    else if (type == "keyboardKey")        ev.type = InputEventType::KeyboardKey;
    else if (type == "keyboardModifiers")  ev.type = InputEventType::KeyboardModifiers;
    else return throwError(env, "injectInput: unknown event.type");

    switch (ev.type) {
        case InputEventType::PointerEnter:
        case InputEventType::PointerMotion:
            ev.x = getF64(env, argv[0], "x");
            ev.y = getF64(env, argv[0], "y");
            break;
        case InputEventType::PointerButton:
            ev.button = getU32(env, argv[0], "button");
            ev.buttonState = getBoolProp(env, argv[0], "pressed")
                                 ? ButtonState::Pressed : ButtonState::Released;
            break;
        case InputEventType::PointerAxis:
            ev.axis = getBoolProp(env, argv[0], "horizontal")
                          ? AxisKind::HorizontalScroll : AxisKind::VerticalScroll;
            ev.axisValue = getF64(env, argv[0], "value");
            ev.axisDiscrete = static_cast<int32_t>(getU32(env, argv[0], "discrete"));
            break;
        case InputEventType::KeyboardKey:
            ev.key = getU32(env, argv[0], "key");
            ev.buttonState = getBoolProp(env, argv[0], "pressed")
                                 ? ButtonState::Pressed : ButtonState::Released;
            break;
        case InputEventType::KeyboardModifiers:
            ev.modsDepressed = getU32(env, argv[0], "modsDepressed");
            ev.modsLatched = getU32(env, argv[0], "modsLatched");
            ev.modsLocked = getU32(env, argv[0], "modsLocked");
            ev.group = getU32(env, argv[0], "group");
            break;
        default:
            break;
    }

    g_inputSink.onInputEvent(ev);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// injectHostInput(event) -> boolean
// Like injectInput, but feeds a forwarded ipc::InputMessage through the REAL
// WaylandInputBackend normalization (fixed-point -> output space, evdev codes,
// state/axis enums) -- the layer injectInput skips. Pointer x/y are LOGICAL
// output-space doubles here; we encode them to wl_fixed_t (x256) so the test
// exercises the round-trip. Returns false if no input backend is active.
napi_value InjectHostInput(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "injectHostInput(event) requires an event object");
    if (!g_addon.waylandInput) { napi_value f; napi_get_boolean(env, false, &f); return f; }

    std::string type = getStr(env, argv[0], "type");
    overdraw::ipc::InputMessage m{};
    m.serial = getU32(env, argv[0], "serial");
    m.time = getU32(env, argv[0], "time");
    auto toFixed = [](double v) { return static_cast<int32_t>(v * 256.0); };

    if (type == "pointerEnter") {
        m.tag = overdraw::ipc::InputTag::PointerEnter;
        m.surfaceX = toFixed(getF64(env, argv[0], "x"));
        m.surfaceY = toFixed(getF64(env, argv[0], "y"));
    } else if (type == "pointerLeave") {
        m.tag = overdraw::ipc::InputTag::PointerLeave;
    } else if (type == "pointerMotion") {
        m.tag = overdraw::ipc::InputTag::PointerMotion;
        m.surfaceX = toFixed(getF64(env, argv[0], "x"));
        m.surfaceY = toFixed(getF64(env, argv[0], "y"));
    } else if (type == "pointerButton") {
        m.tag = overdraw::ipc::InputTag::PointerButton;
        m.button = getU32(env, argv[0], "button");
        m.state = getBoolProp(env, argv[0], "pressed")
                      ? static_cast<uint32_t>(overdraw::ipc::KeyState::Pressed)
                      : static_cast<uint32_t>(overdraw::ipc::KeyState::Released);
    } else if (type == "pointerAxis") {
        m.tag = overdraw::ipc::InputTag::PointerAxis;
        m.axis = getBoolProp(env, argv[0], "horizontal")
                     ? static_cast<uint32_t>(overdraw::ipc::PointerAxisKind::HorizontalScroll)
                     : static_cast<uint32_t>(overdraw::ipc::PointerAxisKind::VerticalScroll);
        m.axisValue = toFixed(getF64(env, argv[0], "value"));
        m.axisDiscrete = static_cast<int32_t>(getU32(env, argv[0], "discrete"));
    } else if (type == "pointerFrame") {
        m.tag = overdraw::ipc::InputTag::PointerFrame;
    } else if (type == "keyboardEnter") {
        m.tag = overdraw::ipc::InputTag::KeyboardEnter;
    } else if (type == "keyboardLeave") {
        m.tag = overdraw::ipc::InputTag::KeyboardLeave;
    } else if (type == "keyboardKey") {
        m.tag = overdraw::ipc::InputTag::KeyboardKey;
        m.key = getU32(env, argv[0], "key");
        m.state = getBoolProp(env, argv[0], "pressed")
                      ? static_cast<uint32_t>(overdraw::ipc::KeyState::Pressed)
                      : static_cast<uint32_t>(overdraw::ipc::KeyState::Released);
    } else if (type == "keyboardModifiers") {
        m.tag = overdraw::ipc::InputTag::KeyboardMods;
        m.modsDepressed = getU32(env, argv[0], "modsDepressed");
        m.modsLatched = getU32(env, argv[0], "modsLatched");
        m.modsLocked = getU32(env, argv[0], "modsLocked");
        m.group = getU32(env, argv[0], "group");
    } else {
        return throwError(env, "injectHostInput: unknown event.type");
    }

    g_addon.waylandInput->injectMessage(m);
    napi_value t; napi_get_boolean(env, true, &t);
    return t;
}

// removeSurface(surfaceId) -> undefined
// setSurfaceLayout(surfaceId, x, y, w, h) -> undefined
// Placement is owned by JS; this stores the surface's output-pixel rect. w/h of
// 0 means "use the surface's content size".
// setStack(idsArray) -> undefined. Back-to-front draw order; JS owns it.
// surfaceReadback(surfaceId, cb) -> boolean
// Test hook: ASYNCHRONOUSLY read the uploaded surface texture back to CPU. Kicks
// off the copy + map and returns true if started (false if the surface is
// unknown / has no texture). The callback `cb(px | null)` is invoked later on
// this same Node thread when the map completes (driven by the wire pump), with a
// Uint8Array of width*height*4 BGRA bytes on success or null on failure. The
// swapchain uses a non-blocking present mode (Mailbox) so the GPU process's
// command thread is not parked in a blocking Surface::GetCurrentTexture while
// the buffer-map command waits behind it.
// frameReadback(cb) -> boolean
// Async readback of the COMPOSITED frame (headless: the offscreen capture
// texture, the full placed+stacked+blended output). cb(px | null) fires on the
// Node thread when the GPU map completes. Returns false if no capture texture
// exists (e.g. not headless). Use this (not surfaceReadback) to verify
// compositing correctness.
// dmabufFeedbackInfo() -> {
//   formatTableFd: WaylandFd, formatTableSize, entryCount,
//   mainDevice: Uint8Array(dev_t bytes), trancheFormats: Uint8Array(u16 indices)
// } | null
// Returns the GPU-process-supplied linux-dmabuf-v1 default-feedback data. The
// fd is a fresh dup of the format_table memfd (caller owns; pass to
// send_format_table). mainDevice/trancheFormats are pre-encoded byte arrays for
// the 'a' (wl_array) event args. Returns null if the GPU process sent no
// feedback data (then the caller falls back to the v3 format/modifier events).
napi_value DmabufFeedbackInfo(napi_env env, napi_callback_info) {
    if (!g_addon.compositor) { napi_value n; napi_get_null(env, &n); return n; }
    const auto& fb = g_addon.compositor->dmabufFeedback();
    if (fb.formatTableFd < 0 || fb.entryCount == 0) {
        napi_value n; napi_get_null(env, &n); return n;
    }
    int fd = g_addon.compositor->dupDmabufFormatTableFd();
    if (fd < 0) { napi_value n; napi_get_null(env, &n); return n; }

    napi_value obj; napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "formatTableFd",
                            overdraw::wayland::makeWaylandFd(env, fd));
    napi_value sz; napi_create_uint32(env, fb.formatTableSize, &sz);
    napi_set_named_property(env, obj, "formatTableSize", sz);
    napi_value ec; napi_create_uint32(env, fb.entryCount, &ec);
    napi_set_named_property(env, obj, "entryCount", ec);

    // main_device: the dev_t as raw bytes (Wayland carries it as a byte array
    // whose size the client asserts == sizeof(dev_t)).
    {
        dev_t dev = static_cast<dev_t>(fb.mainDevice);
        napi_value ab; void* data;
        napi_create_arraybuffer(env, sizeof(dev), &data, &ab);
        std::memcpy(data, &dev, sizeof(dev));
        napi_value ta;
        napi_create_typedarray(env, napi_uint8_array, sizeof(dev), ab, 0, &ta);
        napi_set_named_property(env, obj, "mainDevice", ta);
    }
    // tranche_formats: array of u16 indices [0 .. entryCount) into the table.
    {
        const size_t n = fb.entryCount;
        napi_value ab; void* data;
        napi_create_arraybuffer(env, n * sizeof(uint16_t), &data, &ab);
        auto* idx = static_cast<uint16_t*>(data);
        for (size_t i = 0; i < n; ++i) idx[i] = static_cast<uint16_t>(i);
        napi_value ta;
        napi_create_typedarray(env, napi_uint8_array, n * sizeof(uint16_t), ab, 0, &ta);
        napi_set_named_property(env, obj, "trancheFormats", ta);
    }
    return obj;
}

napi_value Init(napi_env env, napi_value exports) {
    installCoreCrashHandler();
    napi_value fnStart, fnStop, fnPresented, fnStartServer, fnStopServer;
    napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fnStart);
    napi_create_function(env, "stop", NAPI_AUTO_LENGTH, Stop, nullptr, &fnStop);
    napi_create_function(env, "presentedCount", NAPI_AUTO_LENGTH, PresentedCount, nullptr, &fnPresented);
    napi_value fnGpuHandles;
    napi_create_function(env, "gpuHandles", NAPI_AUTO_LENGTH, GpuHandles, nullptr, &fnGpuHandles);
    napi_set_named_property(env, exports, "gpuHandles", fnGpuHandles);
    napi_value fnShmView;
    napi_create_function(env, "shmView", NAPI_AUTO_LENGTH, ShmView, nullptr, &fnShmView);
    napi_set_named_property(env, exports, "shmView", fnShmView);
    napi_value fnCreateTexDmabuf;
    napi_create_function(env, "createTextureFromDmabuf", NAPI_AUTO_LENGTH,
                         CreateTextureFromDmabuf, nullptr, &fnCreateTexDmabuf);
    napi_set_named_property(env, exports, "createTextureFromDmabuf", fnCreateTexDmabuf);
    napi_value fnReleaseDmabuf;
    napi_create_function(env, "releaseDmabufImport", NAPI_AUTO_LENGTH,
                         ReleaseDmabufImport, nullptr, &fnReleaseDmabuf);
    napi_set_named_property(env, exports, "releaseDmabufImport", fnReleaseDmabuf);
    napi_value fnWriteBeginAccess;
    napi_create_function(env, "writeBeginAccess", NAPI_AUTO_LENGTH,
                         WriteBeginAccess, nullptr, &fnWriteBeginAccess);
    napi_set_named_property(env, exports, "writeBeginAccess", fnWriteBeginAccess);
    napi_value fnWriteEndAccess;
    napi_create_function(env, "writeEndAccess", NAPI_AUTO_LENGTH,
                         WriteEndAccess, nullptr, &fnWriteEndAccess);
    napi_set_named_property(env, exports, "writeEndAccess", fnWriteEndAccess);
    for (auto& [name, fn] : std::initializer_list<std::pair<const char*, napi_callback>>{
             {"acquireOutputTexture", AcquireOutputTexture},
             {"presentOutput", PresentOutput},
             {"outputFormat", OutputFormat}}) {
        napi_value f; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f);
        napi_set_named_property(env, exports, name, f);
    }
    napi_create_function(env, "startServer", NAPI_AUTO_LENGTH, StartServer, nullptr, &fnStartServer);
    napi_create_function(env, "stopServer", NAPI_AUTO_LENGTH, StopServer, nullptr, &fnStopServer);
    napi_value fnRegister, fnCreateGlobal, fnPostEvent, fnRegisterIface;
    napi_create_function(env, "registerProtocols", NAPI_AUTO_LENGTH, RegisterProtocols, nullptr, &fnRegister);
    napi_create_function(env, "registerInterface", NAPI_AUTO_LENGTH, RegisterInterface, nullptr, &fnRegisterIface);
    napi_create_function(env, "createGlobal", NAPI_AUTO_LENGTH, CreateGlobal, nullptr, &fnCreateGlobal);
    napi_create_function(env, "postEvent", NAPI_AUTO_LENGTH, PostEvent, nullptr, &fnPostEvent);

    // shm / client-surface bridge (the first server <-> compositor connection).
    auto reg = [&](const char* name, napi_callback fn) {
        napi_value f; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f);
        napi_set_named_property(env, exports, name, f);
    };
    reg("shmCreatePool", ShmCreatePool);
    reg("shmResizePool", ShmResizePool);
    reg("shmDestroyPool", ShmDestroyPool);
    reg("shmBufferRef", ShmBufferRef);
    reg("shmBufferUnref", ShmBufferUnref);
    reg("injectInput", InjectInput);
    reg("injectHostInput", InjectHostInput);
    reg("clientId", ClientId);
    reg("destroyResource", DestroyResource);
    reg("keymapInfo", KeymapInfo);
    reg("keyUpdate", KeyUpdate);
    reg("resolveCursorShape", ResolveCursorShape);
    reg("dmabufFeedbackInfo", DmabufFeedbackInfo);
    reg("pluginCreateConnection", PluginCreateConnection);
    reg("pluginInjectInstance", PluginInjectInstance);
    reg("pluginSetTickDevice", PluginSetTickDevice);
    reg("pluginAllocSurfaceBufferW", PluginAllocSurfaceBufferW);
    reg("coreAllocComposeBufferW", CoreAllocComposeBufferW);
    reg("pluginConsumerTexture", PluginConsumerTexture);
    reg("writeConsumerBegin", WriteConsumerBegin);
    reg("writeConsumerEnd", WriteConsumerEnd);
    reg("writeProducerBegin", WriteProducerBegin);
    reg("writeProducerEnd", WriteProducerEnd);
    reg("pluginReleaseSurfaceBuffer", PluginReleaseSurfaceBuffer);
    reg("setOnOutputDescriptor", SetOnOutputDescriptor);
    reg("updateOutputSize", UpdateOutputSize);

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
