// overdraw core N-API addon: glue only.
//
// Owns a core::Compositor instance and the libuv handles that drive its steady
// state (wire poll + frame timer). All native logic lives in native/core/*.
//
// Raw node_api.h (C API) is used deliberately: node-addon-api is exception/RTTI
// based and the project builds -fno-rtti to match Dawn.

#include <node_api.h>
#include <uv.h>

#include <sys/types.h>  // dev_t
#include <unistd.h>

#include <cstring>
#include <memory>
#include <vector>

#include "core/compositor.h"
#include "core/gpu_process.h"
#include "core/plugin_wire.h"
#include "core/input.h"
#include "core/input_wayland.h"
#include "input_channel.h"
#include "core/shm.h"
#include "wayland/server.h"
#include "wayland/interface_registry.h"
#include "wayland/trampoline.h"
#include "wayland/wayland_fd.h"
#include "wayland/keymap.h"

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

struct Addon {
    std::unique_ptr<Compositor> compositor;
    std::unique_ptr<Server> server;
    std::unique_ptr<InterfaceRegistry> registry;
    std::unique_ptr<Trampoline> trampoline;
    std::unique_ptr<WaylandInputBackend> input;
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
    uint64_t lastNotified = 0;
};
Addon g_addon;

// A live plugin wire connection + its libuv poll (steady-state pump). Heap-owned
// so the uv_poll_t address is stable. The poll calls pw->pump() (HandleScope'd)
// to advance bring-up and drive steady-state wire I/O.
struct PluginWireEntry {
    std::unique_ptr<overdraw::core::PluginWireClient> pw;
    uv_poll_t poll{};
    bool pollStarted = false;
};
std::vector<std::unique_ptr<PluginWireEntry>> g_pluginWires;

// A plugin connect request in flight (async, non-blocking). Resolved/rejected by
// advancePendingConnects() as the WireConnAdded reply (ctrl) then the bring-up
// (plugin wire) complete. `cb` is a JS callback(result|null) the JS SDK wraps in
// a Promise.
struct PendingConnect {
    uint32_t connId;
    int clientFd;
    napi_ref cb;
    PluginWireEntry* entry = nullptr;  // set once WireConnAdded arrives
    enum { kWaitConnAdded, kBringingUp } stage = kWaitConnAdded;
};
std::vector<PendingConnect> g_pendingConnects;

// A surface-buffer allocation in flight. Resolved by the ctrl poll when
// SurfaceBufAllocated arrives. cb({surfaceBufId,producerTexture,consumerTexture}
// | null).
struct PendingAlloc {
    uint32_t surfaceBufId;
    uint32_t connId;
    napi_ref cb;
};
std::vector<PendingAlloc> g_pendingAllocs;

// A surface Begin (producer or consumer) in flight; resolved when the matching
// *BeginDone arrives on the ctrl poll. `expected` is 1 (producer) or 2 (consumer).
struct PendingSurfaceBegin { uint32_t surfaceBufId; int expected; napi_ref cb; };
std::vector<PendingSurfaceBegin> g_pendingBegins;

// Worker-brokered connection flow (the Worker owns the wire client; the core just
// brokers the side channel). These resolve from the ctrl poll.
//   PendingConnBroker: addWireConnection -> WireConnAdded -> cb({connId, fd}).
//   PendingInject: injectPluginInstance -> PluginInstanceInjected -> cb(ok).
struct PendingConnBroker { uint32_t connId; int clientFd; napi_ref cb; };
std::vector<PendingConnBroker> g_pendingConnBrokers;
// uint32 from a napi value argument.
uint32_t u32(napi_env env, napi_value v) { uint32_t o = 0; napi_get_value_uint32(env, v, &o); return o; }
struct PendingInject { uint32_t connId; napi_ref cb; };
std::vector<PendingInject> g_pendingInjects;

// Defined below; declared here so the ctrl poll (above them) can advance them.
void advancePendingConnects(napi_env env);
void advancePendingAllocs(napi_env env);
void advancePendingBegins(napi_env env);
void advanceConnBrokers(napi_env env);
void advanceInjects(napi_env env);

PluginWireEntry* findPluginWire(uint32_t connId) {
    for (auto& e : g_pluginWires) if (e->pw && e->pw->connId() == connId) return e.get();
    return nullptr;
}

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

// Arm the wire poll for READABLE always, plus WRITABLE iff outbound wire bytes
// are queued (so we get told when the socket can take more). Call after anything
// that may have queued wire output.
void armWirePoll() {
    if (!g_addon.loopRunning || !g_addon.compositor) return;
    int events = UV_READABLE;
    if (g_addon.compositor->wireHasPendingOut()) events |= UV_WRITABLE;
    uv_poll_start(&g_addon.wirePoll, events, onWireReadable);
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
        napi_close_handle_scope(g_addon.env, scope);
    }
    armWirePoll();  // update WRITABLE arming based on remaining queue
}

// Steady-state ctrl-fd drain: dispatches async control replies (ClientTexImported
// finishing dmabuf imports). Same Node thread; no threadsafe function needed.
void onCtrlReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.compositor) return;
    g_addon.compositor->drainCtrl();
    fireJsImports(g_addon.env);  // resolve JS dmabuf imports (opens its own scope)
    if (!g_pendingConnects.empty() || !g_pendingAllocs.empty() || !g_pendingBegins.empty() ||
        !g_pendingConnBrokers.empty() || !g_pendingInjects.empty()) {
        napi_handle_scope scope;
        napi_open_handle_scope(g_addon.env, &scope);
        advancePendingConnects(g_addon.env);  // (legacy main-thread path)
        advancePendingAllocs(g_addon.env);    // SurfaceBufAllocated
        advancePendingBegins(g_addon.env);    // Producer/ConsumerBeginDone
        advanceConnBrokers(g_addon.env);      // WireConnAdded (Worker-brokered)
        advanceInjects(g_addon.env);          // PluginInstanceInjected (Worker-brokered)
        napi_close_handle_scope(g_addon.env, scope);
    }
    armWirePoll();  // finishing an import flushes wire output (bind group etc.)
}

void onInputReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.input) return;
    g_addon.input->drain();
}

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

// Advance every in-flight plugin connect: WaitConnAdded (ctrl reply) -> create
// the PluginWireEntry + start bring-up + register its poll; kBringingUp -> when
// the device is up, resolve cb with { connId, instance, device }. Non-blocking;
// called from the ctrl poll and each plugin-wire poll. Opens its own HandleScope.
// Per-plugin-wire libuv poll: pump the plugin wire (drives bring-up + steady
// state) then advance any pending connect. HandleScope'd (wire pump may resolve
// dawn.node JS objects once the SDK shares this connection).
// Arm a plugin wire's poll: READABLE always, WRITABLE iff outbound is queued (so
// commands the plugin device queued via dawn.node actually drain to the GPU
// process). Mirrors armWirePoll for the core wire -- without WRITABLE arming the
// plugin's submitted work never leaves the client and its device never advances.
void onPluginWireReadable(uv_poll_t* h, int status, int events);
void armPluginWire(PluginWireEntry* e) {
    if (!e->pollStarted) return;
    int events = UV_READABLE;
    if (e->pw->hasPendingOut()) events |= UV_WRITABLE;
    uv_poll_start(&e->poll, events, onPluginWireReadable);
}

void onPluginWireReadable(uv_poll_t* h, int status, int events) {
    if (status < 0) return;
    auto* entry = static_cast<PluginWireEntry*>(h->data);
    if (!entry || !entry->pw) return;
    napi_handle_scope scope;
    napi_open_handle_scope(g_addon.env, &scope);
    if (events & UV_WRITABLE) entry->pw->pumpOut();
    entry->pw->pump();
    advancePendingConnects(g_addon.env);
    napi_close_handle_scope(g_addon.env, scope);
    armPluginWire(entry);  // update WRITABLE arming based on remaining queue
}

void advancePendingConnects(napi_env env) {
    for (size_t i = 0; i < g_pendingConnects.size();) {
        PendingConnect& pc = g_pendingConnects[i];
        bool done = false;

        if (pc.stage == PendingConnect::kWaitConnAdded) {
            int st = g_addon.compositor->wireConnAdded(pc.connId);
            if (st == 2) {  // GPU process failed to register
                ::close(pc.clientFd);
                invokePluginCb(env, pc.cb, nullptr);
                done = true;
            } else if (st == 1) {
                // Create the wire client + register its libuv poll; start bring-up.
                auto entry = std::make_unique<PluginWireEntry>();
                entry->pw = std::make_unique<overdraw::core::PluginWireClient>(
                    pc.clientFd, pc.connId, g_addon.compositor.get());
                entry->pw->markSharedWithJs();
                entry->pw->startBringUp();
                uv_loop_t* loop = nullptr;
                napi_get_uv_event_loop(env, &loop);
                uv_poll_init(loop, &entry->poll, entry->pw->wireFd());
                entry->poll.data = entry.get();
                entry->pollStarted = true;
                uv_poll_start(&entry->poll, UV_READABLE, onPluginWireReadable);
                pc.entry = entry.get();
                pc.stage = PendingConnect::kBringingUp;
                g_pluginWires.push_back(std::move(entry));
            }
        } else {  // kBringingUp
            // Kick the state machine even without a wire-readable event (the
            // injection completes on ctrl, not wire).
            pc.entry->pw->pump();
            auto s = pc.entry->pw->state();
            if (s == overdraw::core::PluginWireClient::State::kFailed) {
                invokePluginCb(env, pc.cb, nullptr);
                done = true;
            } else if (s == overdraw::core::PluginWireClient::State::kDone) {
                // Tell the GPU process to tick the plugin device (its queue must
                // advance for map/work-done to resolve).
                auto dwh = pc.entry->pw->deviceWireHandle();
                g_addon.compositor->setPluginTickDevice(pc.connId, dwh.id, dwh.generation);
                auto inst = reinterpret_cast<uint64_t>(pc.entry->pw->instanceHandle());
                auto dev = reinterpret_cast<uint64_t>(pc.entry->pw->deviceHandle());
                napi_value obj, cv, iv, dv;
                napi_create_object(env, &obj);
                napi_create_uint32(env, pc.connId, &cv);
                napi_create_bigint_uint64(env, inst, &iv);
                napi_create_bigint_uint64(env, dev, &dv);
                napi_set_named_property(env, obj, "connId", cv);
                napi_set_named_property(env, obj, "instance", iv);
                napi_set_named_property(env, obj, "device", dv);
                invokePluginCb(env, pc.cb, obj);
                done = true;
            }
        }

        if (done) g_pendingConnects.erase(g_pendingConnects.begin() + static_cast<long>(i));
        else ++i;
    }
}

// Resolve in-flight surface-buffer allocations when SurfaceBufAllocated arrives
// (ctrl). cb({surfaceBufId, producerTexture, consumerTexture} | null).
void advancePendingAllocs(napi_env env) {
    for (size_t i = 0; i < g_pendingAllocs.size();) {
        PendingAlloc& pa = g_pendingAllocs[i];
        int st = g_addon.compositor->surfaceBufAllocated(pa.surfaceBufId);
        if (st == 0) { ++i; continue; }  // pending
        bool ok = st == 1;
        PluginWireEntry* e = ok ? findPluginWire(pa.connId) : nullptr;
        napi_value result = nullptr;
        if (ok && e) {
            auto prod = reinterpret_cast<uint64_t>(e->pw->producerTexture(pa.surfaceBufId));
            auto cons = reinterpret_cast<uint64_t>(g_addon.compositor->coreSurfaceTexture(pa.surfaceBufId));
            napi_value obj, sv, pv, cv;
            napi_create_object(env, &obj);
            napi_create_uint32(env, pa.surfaceBufId, &sv);
            napi_create_bigint_uint64(env, prod, &pv);
            napi_create_bigint_uint64(env, cons, &cv);
            napi_set_named_property(env, obj, "surfaceBufId", sv);
            napi_set_named_property(env, obj, "producerTexture", pv);
            napi_set_named_property(env, obj, "consumerTexture", cv);
            result = obj;
        }
        invokePluginCb(env, pa.cb, result);
        g_pendingAllocs.erase(g_pendingAllocs.begin() + static_cast<long>(i));
    }
}

// Worker-brokered: resolve pluginCreateConnection when WireConnAdded arrives.
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

// Resolve in-flight surface Begin ops when *BeginDone arrives (ctrl). cb(true|false).
void advancePendingBegins(napi_env env) {
    for (size_t i = 0; i < g_pendingBegins.size();) {
        PendingSurfaceBegin& pb = g_pendingBegins[i];
        int st = g_addon.compositor->surfaceBeginDone(pb.surfaceBufId);
        if (st == 0) { ++i; continue; }  // pending
        napi_value result; napi_get_boolean(env, st == pb.expected, &result);
        invokePluginCb(env, pb.cb, result);
        g_pendingBegins.erase(g_pendingBegins.begin() + static_cast<long>(i));
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
    // Pump each plugin wire so plugin-device async ops (map/work-done) advance and
    // queued plugin commands drain even when no plugin-wire fd event fired.
    if (!g_pluginWires.empty()) {
        napi_handle_scope scope;
        napi_open_handle_scope(g_addon.env, &scope);
        for (auto& e : g_pluginWires) { if (e->pw) e->pw->pump(); }
        advancePendingConnects(g_addon.env);
        napi_close_handle_scope(g_addon.env, scope);
        for (auto& e : g_pluginWires) armPluginWire(e.get());
    }
}

// start(gpuBinPath, onFrame?, onInput?, headless?) -> { width, height }
// headless (optional): { width, height } -> run with no host window/surface; the
// compositing pass renders into an offscreen texture (readbackFrame). For tests.
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

    // Optional headless { width, height }.
    uint32_t hw = 0, hh = 0;
    if (argc >= 4) {
        napi_valuetype t;
        napi_typeof(env, argv[3], &t);
        if (t == napi_object) {
            hw = getU32(env, argv[3], "width");
            hh = getU32(env, argv[3], "height");
        }
    }
    const bool headless = hw != 0 && hh != 0;

    auto gpu = overdraw::core::spawnGpuProcess(gpuBin, hw, hh);
    if (gpu.pid < 0) return throwError(env, "failed to spawn gpu process");
    g_addon.inputFd = gpu.inputFd;

    g_addon.compositor =
        std::make_unique<Compositor>(gpu.wireFd, gpu.ctrlFd, gpu.pid, headless, hw, hh);
    if (!g_addon.compositor->bringUp()) {
        const char* e = g_addon.compositor->error().c_str();
        // Compositor dtor reaps the GPU process.
        g_addon.compositor.reset();
        if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
        return throwError(env, e);
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

    // Input backend: maps host-forwarded events to normalized events. Output
    // logical size == host window size in phase 1 (scale 1).
    if (g_addon.inputFd >= 0) {
        g_addon.input = std::make_unique<WaylandInputBackend>(
            g_addon.inputFd, g_addon.compositor->windowWidth(),
            g_addon.compositor->windowHeight());
        g_addon.input->start(&g_inputSink);
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

// pluginConnect(): establish a NEW plugin wire connection to the GPU process and
// bring up its own device. Runtime-proves the C-M2 plumbing (C-M4 step 1). On the
// main thread, reusing the core's dawn.node + the global wire proc table. Returns
// { connId, instance, device } (BigInt handles for dawn.node wrapDevice), or null.
// pluginConnect(cb): ASYNC, non-blocking. Kicks off a new plugin wire connection
// + device bring-up; cb({connId,instance,device} | null) fires when done (the JS
// SDK wraps it in a Promise). Advanced by the ctrl poll (WireConnAdded +
// instance-injection) and the plugin-wire poll (adapter/device). No usleep spin.
napi_value PluginConnect(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "pluginConnect(cb) requires a callback");

    auto handle = g_addon.compositor->addWireConnection();
    if (handle.clientFd < 0) return throwError(env, "addWireConnection failed");

    napi_ref cbRef;
    napi_create_reference(env, argv[0], 1, &cbRef);
    g_pendingConnects.push_back({handle.connId, handle.clientFd, cbRef, nullptr,
                                 PendingConnect::kWaitConnAdded});
    // The WireConnAdded reply arrives on the ctrl poll, which advances this.
    return nullptr;
}

// === Worker-brokered plugin GPU flow (C-M4 step 4) ========================
// The plugin Worker owns its wire client (overdraw_plugin_native.node); the core
// only brokers the side channel. These methods are the core's broker surface.

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
    return nullptr;
}

// pluginAllocSurfaceBufferW(connId, w, h, prodTexId, prodTexGen, prodDevId,
// prodDevGen, cb): Worker-brokered surface alloc. The WORKER reserved the producer
// texture on its wire client and passes the handles; the core reserves the
// consumer texture and sends AllocSurfaceBuf. cb({surfaceBufId, consumerTexture} |
// null) -- the Worker already has its producer handle. Async.
napi_value PluginAllocSurfaceBufferW(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 8; napi_value argv[8];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 8) return throwError(env, "pluginAllocSurfaceBufferW(connId,w,h,ptId,ptGen,pdId,pdGen,cb)");
    uint32_t connId = u32(env, argv[0]), w = u32(env, argv[1]), h = u32(env, argv[2]);
    uint32_t ptId = u32(env, argv[3]), ptGen = u32(env, argv[4]);
    uint32_t pdId = u32(env, argv[5]), pdGen = u32(env, argv[6]);
    if (w == 0 || h == 0) return throwError(env, "pluginAllocSurfaceBufferW: bad size");
    auto core = g_addon.compositor->reserveCoreSurfaceTexture(w, h);
    if (core.surfaceBufId == 0) return throwError(env, "core texture reserve failed");
    g_addon.compositor->sendAllocSurfaceBuf(
        core.surfaceBufId, connId, w, h, {pdId, pdGen}, {ptId, ptGen},
        {core.device.id, core.device.generation}, {core.texture.id, core.texture.generation});
    napi_ref cbRef; napi_create_reference(env, argv[7], 1, &cbRef);
    g_pendingAllocs.push_back({core.surfaceBufId, connId, cbRef});
    return nullptr;
}

// pluginAllocSurfaceBuffer(connId, w, h, cb): ASYNC, non-blocking. Reserves the
// producer (plugin) + consumer (core) textures, sends AllocSurfaceBuf, and
// cb({surfaceBufId,producerTexture,consumerTexture} | null) fires when the GPU
// process replies (SurfaceBufAllocated, on the ctrl poll). No usleep spin.
napi_value PluginAllocSurfaceBuffer(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 4) return throwError(env, "pluginAllocSurfaceBuffer(connId,w,h,cb)");
    uint32_t connId = 0, w = 0, h = 0;
    napi_get_value_uint32(env, argv[0], &connId);
    napi_get_value_uint32(env, argv[1], &w);
    napi_get_value_uint32(env, argv[2], &h);

    PluginWireEntry* e = findPluginWire(connId);
    if (!e) return throwError(env, "pluginAllocSurfaceBuffer: unknown connId");
    if (w == 0 || h == 0) return throwError(env, "pluginAllocSurfaceBuffer: bad size");

    auto core = g_addon.compositor->reserveCoreSurfaceTexture(w, h);
    if (core.surfaceBufId == 0) return throwError(env, "core texture reserve failed");
    auto prod = e->pw->reserveProducerTexture(core.surfaceBufId, w, h);
    if (!prod.ok) return throwError(env, "producer texture reserve failed");
    e->pw->flush();
    g_addon.compositor->sendAllocSurfaceBuf(
        core.surfaceBufId, connId, w, h,
        {prod.device.id, prod.device.generation},
        {prod.texture.id, prod.texture.generation},
        {core.device.id, core.device.generation},
        {core.texture.id, core.texture.generation});

    napi_ref cbRef;
    napi_create_reference(env, argv[3], 1, &cbRef);
    g_pendingAllocs.push_back({core.surfaceBufId, connId, cbRef});
    return nullptr;  // resolved on the ctrl poll
}

// Per-frame fence-dance helpers (C-M4 step 3). Begin ops are async (cb(bool) on
// the ctrl poll when the bracket+fence-wait is in); End ops are fire-and-forget.
static uint32_t arg0u32(napi_env env, napi_callback_info info, napi_value* argv, size_t n) {
    size_t argc = n; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t v = 0; napi_get_value_uint32(env, argv[0], &v); return v;
}
napi_value PluginSurfaceProducerBegin(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[2]; uint32_t id = arg0u32(env, info, argv, 2);
    g_addon.compositor->sendProducerBegin(id);
    napi_ref cbRef; napi_create_reference(env, argv[1], 1, &cbRef);
    g_pendingBegins.push_back({id, 1, cbRef});
    return nullptr;
}
// pluginSurfaceProducerEnd(surfaceBufId, connId): flush the plugin wire (the
// render commands) and tag ProducerEnd with the plugin wire serial so the GPU
// process applies the producer EndAccess only AFTER it has consumed those render
// commands (cross-channel happens-before; same mechanism as ImportClientTex).
napi_value PluginSurfaceProducerEnd(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t id = 0, connId = 0;
    napi_get_value_uint32(env, argv[0], &id);
    napi_get_value_uint32(env, argv[1], &connId);
    PluginWireEntry* e = findPluginWire(connId);
    uint64_t serial = 0;
    if (e) { e->pw->flush(); serial = e->pw->wireBytesQueued(); }
    g_addon.compositor->sendProducerEnd(id, serial);
    return nullptr;
}
napi_value PluginSurfaceConsumerBegin(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[2]; uint32_t id = arg0u32(env, info, argv, 2);
    g_addon.compositor->sendConsumerBegin(id);
    napi_ref cbRef; napi_create_reference(env, argv[1], 1, &cbRef);
    g_pendingBegins.push_back({id, 2, cbRef});
    return nullptr;
}
napi_value PluginSurfaceConsumerEnd(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    napi_value argv[1]; uint32_t id = arg0u32(env, info, argv, 1);
    g_addon.compositor->sendConsumerEnd(id);
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
        for (auto& e : g_pluginWires) {
            if (e->pollStarted) {
                uv_poll_stop(&e->poll);
                uv_close(reinterpret_cast<uv_handle_t*>(&e->poll), nullptr);
                e->pollStarted = false;
            }
        }
        g_addon.loopRunning = false;
    }
    // Reject any still-pending plugin requests (their wire clients are torn down).
    for (auto& pc : g_pendingConnects) { ::close(pc.clientFd); napi_delete_reference(env, pc.cb); }
    g_pendingConnects.clear();
    for (auto& pa : g_pendingAllocs) napi_delete_reference(env, pa.cb);
    g_pendingAllocs.clear();
    for (auto& pb : g_pendingBegins) napi_delete_reference(env, pb.cb);
    g_pendingBegins.clear();
    g_pluginWires.clear();  // PluginWireClient dtor disconnects + closes its fd
    if (g_addon.input) {
        g_addon.input->stop();
        g_addon.input.reset();
    }
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

// keymapInfo() -> { fd: WaylandFd, format, size } | null
// The keymap is built lazily on first call. Each call returns a fresh dup of the
// keymap memfd wrapped as a WaylandFd (each client gets its own to mmap).
napi_value KeymapInfo(napi_env env, napi_callback_info) {
    if (!g_addon.keymap) {
        auto km = std::make_unique<Keymap>();
        if (!km->init()) {
            napi_value n; napi_get_null(env, &n); return n;
        }
        g_addon.keymap = std::move(km);
    }
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

// keyUpdate(evdevKey, pressed) -> { modsDepressed, modsLatched, modsLocked, group }
// Feeds the key into the xkb state and returns the resulting modifier masks for
// wl_keyboard.modifiers. Returns zeros if the keymap is not built.
napi_value KeyUpdate(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t key = 0; bool pressed = false;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &key);
    if (argc >= 2) napi_get_value_bool(env, argv[1], &pressed);
    uint32_t dep = 0, lat = 0, lock = 0, grp = 0;
    if (g_addon.keymap) {
        g_addon.keymap->updateKey(key, pressed);
        g_addon.keymap->modifiers(dep, lat, lock, grp);
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
    if (!g_addon.input) { napi_value f; napi_get_boolean(env, false, &f); return f; }

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

    g_addon.input->injectMessage(m);
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
    reg("keymapInfo", KeymapInfo);
    reg("keyUpdate", KeyUpdate);
    reg("dmabufFeedbackInfo", DmabufFeedbackInfo);
    reg("pluginConnect", PluginConnect);
    reg("pluginCreateConnection", PluginCreateConnection);
    reg("pluginInjectInstance", PluginInjectInstance);
    reg("pluginSetTickDevice", PluginSetTickDevice);
    reg("pluginAllocSurfaceBufferW", PluginAllocSurfaceBufferW);
    reg("pluginAllocSurfaceBuffer", PluginAllocSurfaceBuffer);
    reg("pluginSurfaceProducerBegin", PluginSurfaceProducerBegin);
    reg("pluginSurfaceProducerEnd", PluginSurfaceProducerEnd);
    reg("pluginSurfaceConsumerBegin", PluginSurfaceConsumerBegin);
    reg("pluginSurfaceConsumerEnd", PluginSurfaceConsumerEnd);

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
