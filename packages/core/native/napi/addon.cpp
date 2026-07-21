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
#include <sys/mman.h>  // munmap (capture-destination writable mappings)
#include <sys/types.h>  // dev_t
#include <sys/sysmacros.h>  // minor()
#include <unistd.h>

#include <xf86drm.h>

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <memory>
#include <unordered_map>
#include <vector>

#include "core/compositor.h"
#include "napi/js_exception.h"
#include "core/gpu_process.h"
#include "core/spawn_child.h"
#include "core/input.h"
#include "core/input_wayland.h"
#include "xwayland/napi_xwayland.h"
#if OVERDRAW_KMS
#include "core/seat.h"
#include "core/input_libinput.h"
#endif
#include "input_channel.h"
#include "core/shm.h"
#include "uv_js_scope.h"
#include "wayland/server.h"
#include "wayland/interface_registry.h"
#include "wayland/trampoline.h"
#include "wayland/wayland_fd.h"
#include "wayland/keymap.h"
#include "cursor/xcursor.h"
#include "log/log.h"
#include "log/crash_handler.h"
#include "log/ipc_source.h"
#include "log/paths.h"

using overdraw::core::Compositor;
using overdraw::core::InputEvent;
using overdraw::core::InputEventType;
using overdraw::core::InputSink;
using overdraw::core::ButtonState;
using overdraw::core::AxisKind;
using overdraw::core::WaylandInputBackend;
using overdraw::core::ShmRegistry;
using overdraw::UvJsScope;
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
    // The active input backend, paired with the output backend:
    //   backend=kms    -> LibinputBackend (reads /dev/input/* via libseat).
    //   backend=nested -> WaylandInputBackend (events forwarded from the GPU
    //                     process's host wl_seat).
    // Exactly one is active per Start(). The wayland pointer is kept separately
    // for the injectHostInput test seam, which only applies to the nested path.
    std::unique_ptr<overdraw::core::InputBackend> input;
    WaylandInputBackend* waylandInput = nullptr;  // non-owning; points into `input` when active
#if OVERDRAW_KMS
    overdraw::core::LibinputBackend* libinputBackend = nullptr;  // non-owning; points into `input` on KMS
    std::unique_ptr<overdraw::core::Seat> seat;
    uv_poll_t seatPoll{};
    bool seatPollActive = false;
    int drmCardFd = -1;        // KMS: our copy of the DRM fd (libseat-owned tracking)
    int drmCardDeviceId = -1;  // KMS: libseat device id for closeDevice on shutdown
#endif
    // The default seat keymap (system layout) plus one per virtual keyboard
    // that supplied its own layout. `activeKeymapId` selects which keymap
    // keyUpdate()/keymapInfo() operate on: 0 = default, else a virtualKeymaps
    // entry. The seat switches it per keystroke to the keyboard that typed, so
    // each keyboard's keys are interpreted (and its modifiers reported) under
    // its own layout. See zwp_virtual_keyboard_v1.
    std::unique_ptr<Keymap> keymap;  // default; xkbcommon keymap + modifier state
    std::unordered_map<uint32_t, std::unique_ptr<Keymap>> virtualKeymaps;
    uint32_t nextKeymapId = 1;
    uint32_t activeKeymapId = 0;
    ShmRegistry shm;  // wl_shm pool mappings (CPU-side, independent of the loop)
    uv_poll_t wirePoll{};
    uv_poll_t ctrlPoll{};
    uv_prepare_t flushPrepare{};  // flushes queued wire/ctrl output each loop turn
    uv_poll_t inputPoll{};
    // Headless frame driver. KMS re-arms the loop from ScanoutFlipComplete and
    // nested from the host wl_surface.frame; headless has neither, so a steady
    // timer drives wake() to keep continuous work (animations, transitions,
    // cursor settle) advancing. Active only in headless mode.
    uv_timer_t headlessFrameTimer{};
    bool headlessFrameTimerActive = false;
    int inputFd = -1;  // core-side input socket; owned here, closed in Stop()
    bool loopRunning = false;

    // Frame-trigger state machine. The frame loop is driven by wake() calls
    // (something changed and wants a frame) plus FrameComplete signals from
    // the GPU process (KMS: ScanoutFlipComplete; nested: host wl_surface.frame
    // callback forwarded as FrameComplete). No uv_timer -- a static scene
    // with no client activity, animations, or input is fully idle.
    //
    //   inFrame      true while the JS onFrame callback is on the stack; a
    //                wake() during this window sets wantNext instead of
    //                re-entering the render path.
    //   wantNext     a wake() arrived while inFrame, or a flip-complete freed a
    //                scanout slot; the next opportunity to render fires this off.
    //                Per-output busy gating lives in the JS compositor, not here.
    bool inFrame = false;
    bool wantNext = false;

    // Optional JS callback for frame events. Stored as a ref; called directly
    // from the frame trigger (same thread as Node, so no threadsafe function
    // is needed). Cross-thread events (e.g. Dawn callbacks on Dawn-internal
    // threads) will need napi_threadsafe_function -- not exercised yet.
    napi_env env = nullptr;
    // Async context for UvJsScope: every uv-driven entry into JS opens a
    // callback scope against this so promise continuations queued by the JS
    // drain when the callback unwinds (see uv_js_scope.h).
    napi_async_context uvJsCtx = nullptr;
    napi_ref onFrame = nullptr;
    napi_ref onInput = nullptr;  // optional JS callback(event) for input events
    napi_ref onOutput = nullptr; // optional JS callback(descriptor) for OutputDescriptor msgs
    napi_ref onOutputAdded = nullptr;   // optional JS callback(descriptor) for hotplug add
    napi_ref onOutputRemoved = nullptr; // optional JS callback({outputId}) for hotplug remove
    napi_ref onOutputModes = nullptr;   // optional JS callback({outputId, modes}) for full mode list
    napi_ref onFlipComplete = nullptr;  // optional JS callback(outputId) for KMS flip-completes
    napi_ref onCursorPlaneStatus = nullptr;  // optional JS callback({outputId, ok, maxWidth,
                                             // maxHeight}) for hw-cursor availability
    napi_ref onScanoutClientFlip = nullptr;   // optional JS callback({outputId,
                                              // latchedBufferId, retiredBufferId})
    napi_ref onScanoutClientReject = nullptr; // optional JS callback({outputId, bufferId})
    napi_ref onSeatEnabled = nullptr;  // optional JS callback() on libseat enable_seat
    uint64_t lastNotified = 0;

    // Host-side reader for the GPU process's log socket. Started after
    // spawnGpuProcess returns; stops on Stop().
    std::unique_ptr<overdraw::log::IpcSource> logSource;

    // DRM fd used for explicit-sync (wp_linux_drm_syncobj_v1) ioctls:
    // drmSyncobjFDToHandle, drmSyncobjExportSyncFile, drmSyncobjTimelineSignal,
    // drmSyncobjDestroy. Resolved on first use by syncobjFd():
    //   - KMS mode: aliases drmCardFd (libseat-owned; not closed here).
    //   - Nested mode: a /dev/dri/renderD* we open ourselves (derived from the
    //     GPU process's dmabuf-feedback main_device) and close in Stop().
    // syncobjFdOwned distinguishes the two so Stop() only closes the fd we
    // opened. Syncobj handles are per-fd-context, so every ioctl against a
    // handle must use this same fd.
    int syncobjFdValue = -1;
    bool syncobjFdOwned = false;
};
Addon g_addon;

// Record env and build the shared async context on first use. Called by
// every JS-facing entry point that arms uv handles (Start, StartServer),
// whichever runs first.
void ensureUvJsCtx(napi_env env) {
    if (!g_addon.env) g_addon.env = env;
    if (!g_addon.uvJsCtx) {
        g_addon.uvJsCtx = overdraw::makeUvJsAsyncContext(env, "overdraw");
    }
}

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

// Every JS callback the addon invokes runs outside a JS frame, so a throw has
// nowhere to propagate: it stays pending and silently no-ops every later napi
// call in the same native pass. Call this right after each napi_call_function
// to clear + log the exception, so one throwing callback can neither vanish
// without a trace nor swallow the messages dispatched after it.
void logJsException(napi_env env, const char* where) {
    std::string desc;
    if (!overdraw::napi::takePendingJsException(env, &desc)) return;
    LOG_ERR(Core, "uncaught JS exception in {}: {}", where, desc);
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
    logJsException(env, "onFrame");
    napi_close_handle_scope(env, scope);
}

// Call the JS onFlipComplete(outputId, tvSec, tvNsec, seq) callback if
// registered. Fired once per drained ScanoutFlipComplete (one outputId at a
// time). JS uses this to dispatch wl_callback.done for surfaces resident on
// that output AND to deliver wp_presentation feedback. tvSec / tvNsec are
// CLOCK_MONOTONIC at the page-flip / host-frame moment (0/0 when unknown);
// seq is the kernel-supplied vsync sequence on KMS (0 elsewhere).
// Same-thread.
void notifyFlipComplete(uint32_t outputId, uint64_t tvSec, uint32_t tvNsec, uint32_t seq) {
    if (!g_addon.onFlipComplete) return;
    napi_env env = g_addon.env;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onFlipComplete, &cb);
    napi_get_undefined(env, &undefined);
    napi_value args[4];
    napi_create_uint32(env, outputId, &args[0]);
    // u64 -> bigint for tvSec to survive Number's 2^53 ceiling on long-lived
    // monotonic clocks (CLOCK_MONOTONIC counts seconds since boot; ~292 years
    // of headroom at u64, decades at i53). JS can convert to ms via
    // Number(BigInt) when needed.
    napi_create_bigint_uint64(env, tvSec, &args[1]);
    napi_create_uint32(env, tvNsec, &args[2]);
    napi_create_uint32(env, seq, &args[3]);
    napi_call_function(env, undefined, cb, 4, args, nullptr);
    logJsException(env, "onFlipComplete");
    napi_close_handle_scope(env, scope);
}

// Call the JS onSeatEnabled() callback if registered. Fired on libseat
// enable_seat (VT switch back). JS marks every output fully damaged so the
// wake() that follows repaints and re-presents (the post-resume present runs
// the ALLOW_MODESET commit that reclaims the display). Same-thread.
void notifySeatEnabled() {
    if (!g_addon.onSeatEnabled) return;
    napi_env env = g_addon.env;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onSeatEnabled, &cb);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, cb, 0, nullptr, nullptr);
    logJsException(env, "onSeatEnabled");
    napi_close_handle_scope(env, scope);
}

// Declared here; defined below.
void armWirePoll();

// Frame trigger. Two entry points:
//   wake()             called from event-loop callbacks (wayland-server poll,
//                      input poll, ctrl poll, bringUp bootstrap, JS via the
//                      `wake` export) to say "something changed; render
//                      soon."
//   onFrameComplete()  called from the ctrl poll when ScanoutFlipComplete (KMS)
//                      or FrameComplete (nested) arrives.
//
// Both funnel into runFrameIfReady() which checks inFrame before invoking
// notifyFrame(). There is NO global flip gate: per-output pacing lives in the
// JS compositor, which renders only the outputs that are both dirty and have a
// free scanout slot. A busy output (its ring full mid-flip) is simply skipped
// by renderFrame and picked up on its OWN flip-complete -- it does not stall
// the other outputs. After notifyFrame returns, we loop only while renderFrame
// actually presented at least one output this pass (and wantNext is still set):
// a pass that presents nothing (all dirty outputs busy, or all clean) means the
// remaining work waits for the next wake / flip-complete rather than spinning.
void runFrameIfReady();

void wake() {
    if (!g_addon.compositor || !g_addon.loopRunning) return;
    g_addon.wantNext = true;
    runFrameIfReady();
}

void runFrameIfReady() {
    if (!g_addon.compositor || !g_addon.loopRunning) return;
    if (!g_addon.wantNext) return;
    if (g_addon.inFrame) return;                       // re-entrant; post-render loop picks it up

    // vblank-gate. Don't run a frame pass while every output already has a
    // page-flip in flight -- the flip-complete (onFrameComplete) is the only
    // thing that drives the next render. wantNext stays set, so the deferred
    // work runs as soon as a flip frees a slot. Without this, a client that
    // commits faster than vblank drives unbounded synchronous renders that
    // monopolize the thread and starve the very poll loop delivering the
    // flip-completes (and input). Headless has no flips and is paced by its
    // frame timer, so canPresentAnyOutput is always true there.
    if (g_addon.compositor && !g_addon.compositor->canPresentAnyOutput()) {
        return;
    }

    do {
        g_addon.wantNext = false;
        g_addon.inFrame = true;
        const uint64_t presentedBefore =
            g_addon.compositor ? g_addon.compositor->presented() : 0;
        notifyFrame();           // → JS dispatchFrameCallbacks + JS renderFrame + JS presentOutput
        uint64_t presentedAfter = presentedBefore;
        if (g_addon.compositor) {
            g_addon.lastNotified = g_addon.compositor->presented();
            g_addon.compositor->renderFrame();
            presentedAfter = g_addon.compositor->presented();
        }
        g_addon.inFrame = false;
        armWirePoll();
        // Re-loop only while progress is being made: renderFrame presented at
        // least one output this pass AND something still wants a frame. A pass
        // that presents nothing (every output's ring busy) stops here -- the
        // pending work is serviced on the next wake or flip-complete, not by
        // spinning. Headless presents nothing (presentOutput is a no-op with no
        // swapchain/scanout), so its progress can't be measured by the present
        // count; it loops on wantNext alone, paced by the ~60Hz headless frame
        // timer.
        const bool headless = g_addon.compositor && g_addon.compositor->headless();
        if (!headless && presentedAfter <= presentedBefore) break;
    } while (g_addon.wantNext);
}

// Headless frame pacing: KMS/nested re-arm runFrameIfReady from a flip /
// host-frame signal, but headless has no such signal. This timer is that
// signal -- a steady ~60Hz wake so animations/transitions/cursor settle keep
// rendering. It renders unconditionally each tick (the headless analogue of
// the pre-flip-driven 60Hz frame timer); headless is a test-only mode where
// continuous frames are the expectation.
void onHeadlessFrameTimer(uv_timer_t*) {
    UvJsScope jsScope(g_addon.env, g_addon.uvJsCtx);
    // Headless has no flip-complete events; synthesize one for the primary
    // output so dispatchFrameCallbacksForOutput still fires per tick. Tests
    // (which are the headless use case) depend on wl_callback.done arriving
    // on the steady ~60Hz cadence.
    if (g_addon.onFlipComplete) {
        // Headless has no real page-flip; sample CLOCK_MONOTONIC now so JS
        // sees a plausible "presented" timestamp.
        struct timespec ts{};
        clock_gettime(CLOCK_MONOTONIC, &ts);
        notifyFlipComplete(0, static_cast<uint64_t>(ts.tv_sec),
                              static_cast<uint32_t>(ts.tv_nsec), 0);
    }
    wake();
}

// Drain the queued KMS flip-completes and fire JS onFlipComplete(outputId,
// tvSec, tvNsec, seq) for each. Frame-callback dispatch happens in JS per
// outputId, so a surface resident only on output 0 (60Hz) wakes at ~60Hz even
// when output 1 (240Hz) is also flipping. Nested pushes its FrameComplete as
// outputId=0; headless synthesizes one in the frame-timer trampoline.
void drainFlipCompletes() {
    if (!g_addon.compositor) return;
    auto entries = g_addon.compositor->takeFlipCompletes();
    for (auto& e : entries) notifyFlipComplete(e.outputId, e.tvSec, e.tvNsec, e.seq);
}

void onFrameComplete() {
    if (!g_addon.compositor || !g_addon.loopRunning) return;
    // Drain pending wayland-server events first: a client commit may have
    // arrived between the last server-pump and now. Without this, the
    // upcoming dispatchFrameCallbacks would miss the new wl_callback
    // installed by that commit, deferring the client's `done` to the next
    // render -- a full vsync of extra latency, halving the client's
    // observable frame rate (one commit per two compositor renders instead
    // of one per one).
    if (g_addon.server) {
        g_addon.server->drainEvents();
    }
    // Per-output flip-complete dispatch (KMS). Each output's queued flip
    // wakes its resident surfaces' frame-callbacks at that output's vblank,
    // independent of other outputs' refresh rates.
    drainFlipCompletes();
    // Steady-state frame pacing: each flip-complete is a vsync edge AND means
    // some output's scanout ring just freed a slot. An output that was skipped
    // earlier because its ring was busy can now be rendered, so force wantNext
    // before re-evaluating. Per-output composite-scissor damage keeps the
    // per-pixel cost cheap when the output's content hasn't changed.
    g_addon.wantNext = true;
    runFrameIfReady();
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
        case InputEventType::PointerAxisSource: return "pointerAxisSource";
        case InputEventType::PointerAxisStop:   return "pointerAxisStop";
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
void setI32(napi_env env, napi_value obj, const char* key, int32_t v) {
    napi_value n; napi_create_int32(env, v, &n);
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
    setU32(env, obj, "keymapId", ev.keymapId);

    switch (ev.type) {
        case InputEventType::PointerEnter:
            setF64(env, obj, "x", ev.x);
            setF64(env, obj, "y", ev.y);
            break;
        case InputEventType::PointerMotion:
            setF64(env, obj, "x", ev.x);
            setF64(env, obj, "y", ev.y);
            setF64(env, obj, "dx", ev.dx);
            setF64(env, obj, "dy", ev.dy);
            setF64(env, obj, "dxUnaccel", ev.dxUnaccel);
            setF64(env, obj, "dyUnaccel", ev.dyUnaccel);
            break;
        case InputEventType::PointerButton:
            setU32(env, obj, "button", ev.button);
            setBool(env, obj, "pressed", ev.buttonState == ButtonState::Pressed);
            break;
        case InputEventType::PointerAxis:
            setBool(env, obj, "horizontal", ev.axis == AxisKind::HorizontalScroll);
            setF64(env, obj, "value", ev.axisValue);
            setU32(env, obj, "discrete", static_cast<uint32_t>(ev.axisDiscrete));
            setI32(env, obj, "value120", ev.axisValue120);
            break;
        case InputEventType::PointerAxisSource:
            setU32(env, obj, "axisSource", ev.axisSource);
            break;
        case InputEventType::PointerAxisStop:
            setBool(env, obj, "horizontal", ev.axis == AxisKind::HorizontalScroll);
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
    logJsException(env, "onInput");
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
void fireOutputsAdded(napi_env env);
void fireOutputsRemoved(napi_env env);
void fireOutputModes(napi_env env);
void fireCursorPlaneStatuses(napi_env env);
void fireScanoutClientEvents(napi_env env);

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
    UvJsScope jsScope(g_addon.env, g_addon.uvJsCtx);
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
        // Order: Removed before Descriptor/Added. The GPU process emits all
        // removeds for a rescan pass before any addeds (CRTC pool clean before
        // assignment); the JS workspace migration policy depends on that
        // ordering. OutputDescriptor (re-emit on identity change) doesn't
        // interact with the hotplug pair and runs alongside.
        fireOutputsRemoved(g_addon.env);
        fireOutputDescriptors(g_addon.env);
        fireOutputsAdded(g_addon.env);
        // OutputModes after Added: the mode list applies to an
        // already-created state.outputs entry.
        fireOutputModes(g_addon.env);
        fireCursorPlaneStatuses(g_addon.env);
        fireScanoutClientEvents(g_addon.env);
        // drainCtrl above may have consumed plugin-broker replies (alloc/begin/...);
        // advance them here too, else they are stranded (see advanceAllPending).
        advanceAllPending(g_addon.env);
        // drainCtrl may have observed a ScanoutFlipComplete / FrameComplete;
        // route it to the wake state machine.
        if (g_addon.compositor->takeFrameComplete()) onFrameComplete();
        // An shm upload completed: its ack carries deferred output damage that
        // JS applies on drain (dispatchFrameCallbacks -> takeShmUploadAcks).
        // Wake so an idle compositor renders it now instead of stranding it
        // until the next unrelated wake (input / another output's flip).
        if (g_addon.compositor->hasShmUploadAcks()) wake();
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
    UvJsScope jsScope(g_addon.env, g_addon.uvJsCtx);
    if (events & UV_WRITABLE) g_addon.compositor->ctrlPumpOut();
    if (events & UV_READABLE) {
        g_addon.compositor->drainCtrl();
        fireJsImports(g_addon.env);  // resolve JS dmabuf imports (opens its own scope)
        // Removed before Descriptor/Added (see onWireReadable for rationale).
        fireOutputsRemoved(g_addon.env);
        fireOutputDescriptors(g_addon.env);
        fireOutputsAdded(g_addon.env);
        fireOutputModes(g_addon.env);
        fireCursorPlaneStatuses(g_addon.env);
        fireScanoutClientEvents(g_addon.env);
        advanceAllPending(g_addon.env);
        if (g_addon.compositor->takeFrameComplete()) onFrameComplete();
        if (g_addon.compositor->hasShmUploadAcks()) wake();  // see onWireReadable
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

// libuv prepare hook: arm the WRITABLE poll for any queued wire/ctrl output
// before the loop blocks. The steady-state frame loop is event-driven (no
// periodic timer), so a device-async op issued OUTSIDE a frame -- e.g. a
// headless buffer mapAsync for readback() with no client commit or flip to
// drive a render -- would otherwise sit in the serializer un-flushed and
// never reach the GPU process, hanging the awaited map. This decouples
// flushing from the frame clock; it only re-arms when output is actually
// pending, so an idle loop still blocks normally.
void onFlushPrepare(uv_prepare_t*) {
    if (!g_addon.compositor) return;
    g_addon.compositor->flushWire();  // commit staged wire commands (no-op if none)
    if (g_addon.compositor->wireHasPendingOut()) armWirePoll();
    if (g_addon.compositor->ctrlHasPendingOut()) armCtrlPoll();
}

void onInputReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.input) return;
    UvJsScope jsScope(g_addon.env, g_addon.uvJsCtx);
    g_addon.input->drain();
    // Pointer motion changes the cursor, key presses may change focus +
    // alter what should be rendered; clients react via wl events and want
    // their frame callbacks dispatched. Wake the frame loop.
    wake();
}

#if OVERDRAW_KMS
void onSeatReadable(uv_poll_t*, int status, int) {
    if (status < 0 || !g_addon.seat) return;
    UvJsScope jsScope(g_addon.env, g_addon.uvJsCtx);
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
    logJsException(env, "plugin-broker callback");
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

// start(gpuBinPath, onFrame?, onInput?, opts?) -> { width, height }
// opts (object, optional): one of
//   { width, height }                    -> headless mode (legacy shape)
//   { backend: "kms" | "nested", card?: "/dev/dri/cardN" }
//                                         -> select output backend.
//                                         -> default if absent: KMS.
//                                         -> headless takes precedence if width+height set.
// `card` is an optional override used only when backend == "kms". When absent,
// the seat probes /dev/dri/card* and opens the first with a connected
// connector (the card driving a display).
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
    ensureUvJsCtx(env);
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
    std::string drmCardPath;      // empty -> probe for first connected card
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

    // Start the GPU-process log reader thread on the host side of the log
    // socket. Records are dispatched into host spdlog loggers; if logInit()
    // has not been called yet a pre-init fallback logger handles them.
    if (gpu.logFd >= 0) {
        g_addon.logSource = std::make_unique<overdraw::log::IpcSource>();
        g_addon.logSource->start(gpu.logFd);
    }

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
        bool opened;
        std::string chosenCard = drmCardPath;
        if (drmCardPath.empty()) {
            opened = g_addon.seat->openFirstConnectedCard(chosenCard, drmFd, drmDeviceId);
        } else {
            opened = g_addon.seat->openDevice(drmCardPath.c_str(), drmFd, drmDeviceId);
        }
        if (!opened) {
            const std::string what = drmCardPath.empty()
                ? std::string("DRM card auto-detect")
                : ("libseat openDevice(" + drmCardPath + ")");
            const std::string err = what + " failed: " + g_addon.seat->error();
            g_addon.seat.reset();
            if (g_addon.inputFd >= 0) { ::close(g_addon.inputFd); g_addon.inputFd = -1; }
            return throwError(env, err.c_str());
        }
        LOG_INFO(Core, "KMS card: {}", chosenCard);
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

    // Flush queued wire/ctrl output each loop iteration (see onFlushPrepare):
    // device-async ops outside the event-driven frame loop must still reach
    // the GPU process.
    uv_prepare_init(loop, &g_addon.flushPrepare);
    uv_prepare_start(&g_addon.flushPrepare, onFlushPrepare);
    // The loop + its per-turn flush hook are now live, so batch wire writes:
    // appendFrame/Flush stage until onFlushPrepare drains them once per turn,
    // collapsing the many small control frames per render into one write.
    g_addon.compositor->setWireDeferPump(true);

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
        g_addon.libinputBackend = libiBackend.get();
        g_addon.input = std::move(libiBackend);
        uv_poll_init(loop, &g_addon.inputPoll, liFd);
        uv_poll_start(&g_addon.inputPoll, UV_READABLE, onInputReadable);

        const int seatFd = g_addon.seat->pollFd();
        if (seatFd >= 0) {
            uv_poll_init(loop, &g_addon.seatPoll, seatFd);
            uv_poll_start(&g_addon.seatPoll, UV_READABLE, onSeatReadable);
            g_addon.seatPollActive = true;
        }

        // VT-switch lifecycle (drm-design.md "Seat / VT lifecycle"). Now that
        // compositor + libinput are up, attach the seat enable/disable
        // callbacks. open() was called earlier with nullptr callbacks because
        // those subsystems didn't exist yet.
        //
        // disable_seat (VT switch away): tell the GPU process to pause
        // (OutputPause; KmsOutputBackend drops any pending flip + clears
        // didInitialCommit_), suspend libinput (releases device fds via the
        // libseat close_restricted trampoline), stop the input poll, then ack
        // the disable back to libseat so the seat provider knows we're done.
        //
        // enable_seat (VT switch back): resume libinput (libseat hands us
        // fresh fds via open_restricted), restart the input poll, and tell
        // the GPU process to resume. Nothing else repaints on its own: the
        // frame loop is event-driven and the last flip-complete was dropped
        // on pause, and the JS per-output dirty gate would skip every output
        // (no damage accumulated while away). So notify JS to mark all
        // outputs fully damaged, then wake() -- the resulting present runs
        // the ALLOW_MODESET commit that takes the display back.
        g_addon.seat->setCallbacks(
            /*onEnable=*/ []() {
                if (!g_addon.compositor) return;
                LOG_INFO(Seat, "enable_seat (VT switched back)");
                if (g_addon.libinputBackend) g_addon.libinputBackend->resume();
                if (g_addon.loopRunning && g_addon.libinputBackend) {
                    // The input poll was stopped on disable; restart it on the
                    // same fd (libinput keeps its single context fd across
                    // suspend/resume).
                    uv_poll_start(&g_addon.inputPoll, UV_READABLE, onInputReadable);
                }
                g_addon.compositor->resumeOutput();
                notifySeatEnabled();
                wake();
            },
            /*onDisable=*/ []() {
                if (!g_addon.compositor) return;
                LOG_INFO(Seat, "disable_seat (VT switched away)");
                g_addon.compositor->pauseOutput();
                if (g_addon.loopRunning && g_addon.libinputBackend) {
                    uv_poll_stop(&g_addon.inputPoll);
                }
                if (g_addon.libinputBackend) g_addon.libinputBackend->suspend();
                g_addon.seat->ackDisable();
            });

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
        // events. Output logical size == host window size (scale 1).
        auto wlBackend = std::make_unique<WaylandInputBackend>(
            g_addon.inputFd, g_addon.compositor->windowWidth(),
            g_addon.compositor->windowHeight());
        g_addon.waylandInput = wlBackend.get();
        wlBackend->start(&g_inputSink);
        g_addon.input = std::move(wlBackend);
        uv_poll_init(loop, &g_addon.inputPoll, g_addon.inputFd);
        uv_poll_start(&g_addon.inputPoll, UV_READABLE, onInputReadable);
    }

    g_addon.loopRunning = true;
    // The bootstrap wake is JS-driven (main.ts calls addon.wake() once
    // compositor + plugin setup is complete). Firing wake() here would
    // render against an un-wired JS side (state.dispatchFrameCallbacks
    // not yet attached).

    // Headless has no flip / host-frame to re-arm the wake-driven loop, so
    // drive frames from a steady ~60Hz timer. The first ticks may land before
    // the JS side is wired; notifyFrame's onFrame callback no-ops until then
    // (dispatchFrameCallbacks is optional-chained). KMS/nested skip this --
    // they pace off real present completion.
    if (headless) {
        uv_timer_init(loop, &g_addon.headlessFrameTimer);
        uv_timer_start(&g_addon.headlessFrameTimer, onHeadlessFrameTimer, 16, 16);
        g_addon.headlessFrameTimerActive = true;
    }

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

// logInit({ levelSpec?: string, logFile?: string, noLogFile?: boolean })
// Configures the global spdlog registry: builds stdout/stderr/file sinks and
// the per-area level table from the spec. The file sink is on by default
// (rotating, in the state dir); logFile overrides its path, noLogFile
// suppresses it. Idempotent. Call before start() so the GPU-process log
// reader dispatches into a configured registry.
napi_value LogInit(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    overdraw::log::Config cfg{};
    if (argc >= 1) {
        napi_valuetype t;
        napi_typeof(env, argv[0], &t);
        if (t == napi_object) {
            char buf[1024] = {};
            size_t n = 0;
            napi_value v;
            if (napi_get_named_property(env, argv[0], "levelSpec", &v) == napi_ok) {
                napi_valuetype vt; napi_typeof(env, v, &vt);
                if (vt == napi_string) {
                    napi_get_value_string_utf8(env, v, buf, sizeof(buf), &n);
                    std::string err;
                    if (!overdraw::log::parseLevelSpec(std::string_view(buf, n), &cfg, &err)) {
                        const std::string msg = "logInit: bad levelSpec: " + err;
                        napi_throw_error(env, nullptr, msg.c_str());
                        napi_value u; napi_get_undefined(env, &u); return u;
                    }
                }
            }
            char fbuf[4096] = {};
            if (napi_get_named_property(env, argv[0], "logFile", &v) == napi_ok) {
                napi_valuetype vt; napi_typeof(env, v, &vt);
                if (vt == napi_string) {
                    napi_get_value_string_utf8(env, v, fbuf, sizeof(fbuf), &n);
                    cfg.filePath = std::string(fbuf, n);
                }
            }
            if (napi_get_named_property(env, argv[0], "noLogFile", &v) == napi_ok) {
                napi_valuetype vt; napi_typeof(env, v, &vt);
                if (vt == napi_boolean) {
                    bool b = false;
                    napi_get_value_bool(env, v, &b);
                    cfg.disableFile = b;
                }
            }
        }
    }
    overdraw::log::logInit(cfg);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// nativeLog(level: number, area: string, message: string)
// Routes a log record from JS into the host's spdlog registry. The level
// matches spdlog::level::level_enum (trace=0..critical=5). Unknown areas
// fall back to "js". Format-string interpolation is done by the caller
// (the log module / console shim); this is the plain-text entry point.
napi_value NativeLog(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) {
        napi_value u; napi_get_undefined(env, &u); return u;
    }
    uint32_t level = 0;
    napi_get_value_uint32(env, argv[0], &level);
    if (level > 6) level = 2;  // clamp to spdlog::level::off

    char areaBuf[32] = {};
    size_t areaLen = 0;
    napi_get_value_string_utf8(env, argv[1], areaBuf, sizeof(areaBuf), &areaLen);
    auto area = overdraw::log::areaFromName(std::string_view(areaBuf, areaLen));
    if (area == overdraw::log::Area::Count_) area = overdraw::log::Area::Js;

    // Message: variable length. Two-step to handle long messages.
    size_t msgLen = 0;
    napi_get_value_string_utf8(env, argv[2], nullptr, 0, &msgLen);
    std::string msg(msgLen, '\0');
    size_t actual = 0;
    if (msgLen > 0) {
        napi_get_value_string_utf8(env, argv[2], msg.data(), msgLen + 1, &actual);
    }
    overdraw::log::logger(area).log(
        static_cast<spdlog::level::level_enum>(level), msg);

    napi_value u; napi_get_undefined(env, &u); return u;
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
// pluginSerial, cb): the reverse-direction alloc. The core is the
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
// consumer Begin/End on the core wire. Synchronous frame writes -- no
// pendingBegins callback; FIFO wire ordering supplies the begin-done ordering.
// The caller still gates End on afterCurrentFrame (GPU-read completion).
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
// core wire. The core IS the producer for compose buffers, so
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
        logJsException(env, "dmabuf-import callback");
        napi_delete_reference(env, it->second);
        g_jsImportCbs.erase(it);
    }
    napi_close_handle_scope(env, scope);
    // `done` destructs here: each JsImportDone.tex releases the core's ref, having
    // handed ownership to JS (wrapTexture AddRef'd inside the callback).

    // A completed import makes its surface drawable. The dmabuf import is async,
    // so the render that committed the buffer may have already finished (drawing
    // the surface blank because its texture wasn't ready) and left the frame loop
    // idle. Wake it so the now-ready surface is rendered; without this the
    // surface stays blank until some other event happens to wake the loop.
    wake();
}

// Build the JS descriptor object for an OutputDescriptorMsg. Shared by
// fireOutputDescriptors and fireOutputsAdded (the OutputAdded payload reuses
// the descriptor shape).
static napi_value buildDescriptorObject(napi_env env,
                                        const Compositor::OutputDescriptorMsg& d) {
    napi_value obj, v, sname, smake, smodel;
    napi_create_object(env, &obj);
    napi_create_uint32(env, d.outputId,         &v); napi_set_named_property(env, obj, "outputId", v);
    napi_create_uint32(env, d.width,            &v); napi_set_named_property(env, obj, "width", v);
    napi_create_uint32(env, d.height,           &v); napi_set_named_property(env, obj, "height", v);
    napi_create_uint32(env, d.refreshMhz,       &v); napi_set_named_property(env, obj, "refreshMhz", v);
    napi_create_uint32(env, d.scale,            &v); napi_set_named_property(env, obj, "scale", v);
    napi_create_uint32(env, d.transform,        &v); napi_set_named_property(env, obj, "transform", v);
    napi_create_uint32(env, d.physicalWidthMm,  &v); napi_set_named_property(env, obj, "physicalWidthMm", v);
    napi_create_uint32(env, d.physicalHeightMm, &v); napi_set_named_property(env, obj, "physicalHeightMm", v);
    napi_create_string_utf8(env, d.name.c_str(),   d.name.size(),   &sname);
    napi_create_string_utf8(env, d.make.c_str(),   d.make.size(),   &smake);
    napi_create_string_utf8(env, d.model.c_str(),  d.model.size(),  &smodel);
    napi_set_named_property(env, obj, "name",  sname);
    napi_set_named_property(env, obj, "make",  smake);
    napi_set_named_property(env, obj, "model", smodel);
    napi_value sedid;
    napi_create_string_utf8(env, d.edidId.c_str(), d.edidId.size(), &sedid);
    napi_set_named_property(env, obj, "edidId", sedid);
    return obj;
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
        napi_value obj = buildDescriptorObject(env, d);
        napi_call_function(env, undefined, cb, 1, &obj, nullptr);
        logJsException(env, "onOutput");
    }
    napi_close_handle_scope(env, scope);
}

// Drain queued OutputAdded messages and invoke the JS onOutputAdded callback
// per message. Same Node thread; same pattern as fireOutputDescriptors.
//
// Ordering: callers MUST run fireOutputsRemoved BEFORE this. The GPU process
// emits all OutputRemoveds for a rescan pass before any OutputAddeds (so the
// CRTC pool is maximally free when adds run); preserving that ordering on the
// JS side gives the workspace migration policy a clean "removed -> added"
// sequence to operate on.
void fireOutputsAdded(napi_env env) {
    if (!g_addon.compositor || !g_addon.onOutputAdded) return;
    std::vector<Compositor::OutputDescriptorMsg> descs;
    g_addon.compositor->takePendingOutputsAdded(descs);
    if (descs.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onOutputAdded, &cb);
    napi_get_undefined(env, &undefined);
    for (const auto& d : descs) {
        napi_value obj = buildDescriptorObject(env, d);
        napi_call_function(env, undefined, cb, 1, &obj, nullptr);
        logJsException(env, "onOutputAdded");
    }
    napi_close_handle_scope(env, scope);
}

// Drain queued OutputRemoved messages and invoke the JS onOutputRemoved
// callback per message. The payload is { outputId } only.
void fireOutputsRemoved(napi_env env) {
    if (!g_addon.compositor || !g_addon.onOutputRemoved) return;
    std::vector<uint32_t> ids;
    g_addon.compositor->takePendingOutputsRemoved(ids);
    if (ids.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onOutputRemoved, &cb);
    napi_get_undefined(env, &undefined);
    for (uint32_t id : ids) {
        napi_value obj, v;
        napi_create_object(env, &obj);
        napi_create_uint32(env, id, &v);
        napi_set_named_property(env, obj, "outputId", v);
        napi_call_function(env, undefined, cb, 1, &obj, nullptr);
        logJsException(env, "onOutputRemoved");
    }
    napi_close_handle_scope(env, scope);
}

// Drain queued CursorPlaneStatus messages and invoke the JS
// onCursorPlaneStatus callback per message. Each call carries
// { outputId, ok, maxWidth, maxHeight }.
void fireCursorPlaneStatuses(napi_env env) {
    if (!g_addon.compositor || !g_addon.onCursorPlaneStatus) return;
    auto msgs = g_addon.compositor->takeCursorPlaneStatuses();
    if (msgs.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onCursorPlaneStatus, &cb);
    napi_get_undefined(env, &undefined);
    for (const auto& m : msgs) {
        napi_value obj, v;
        napi_create_object(env, &obj);
        napi_create_uint32(env, m.outputId, &v);
        napi_set_named_property(env, obj, "outputId", v);
        napi_get_boolean(env, m.ok, &v);
        napi_set_named_property(env, obj, "ok", v);
        napi_create_uint32(env, m.maxWidth, &v);
        napi_set_named_property(env, obj, "maxWidth", v);
        napi_create_uint32(env, m.maxHeight, &v);
        napi_set_named_property(env, obj, "maxHeight", v);
        napi_call_function(env, undefined, cb, 1, &obj, nullptr);
        logJsException(env, "onCursorPlaneStatus");
    }
    napi_close_handle_scope(env, scope);
}

// Drain queued client-scanout events (flips with latch/retire pairs and
// rejections) into their JS callbacks.
void fireScanoutClientEvents(napi_env env) {
    if (!g_addon.compositor) return;
    if (!g_addon.compositor->hasScanoutClientEvents()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    if (g_addon.onScanoutClientFlip) {
        auto flips = g_addon.compositor->takeScanoutClientFlips();
        if (!flips.empty()) {
            napi_value cb;
            napi_get_reference_value(env, g_addon.onScanoutClientFlip, &cb);
            for (const auto& f : flips) {
                napi_value obj, v;
                napi_create_object(env, &obj);
                napi_create_uint32(env, f.outputId, &v);
                napi_set_named_property(env, obj, "outputId", v);
                napi_create_uint32(env, f.latchedBufferId, &v);
                napi_set_named_property(env, obj, "latchedBufferId", v);
                napi_create_uint32(env, f.retiredBufferId, &v);
                napi_set_named_property(env, obj, "retiredBufferId", v);
                napi_call_function(env, undefined, cb, 1, &obj, nullptr);
                logJsException(env, "onScanoutClientFlip");
            }
        }
    }
    if (g_addon.onScanoutClientReject) {
        auto rejects = g_addon.compositor->takeScanoutClientRejects();
        if (!rejects.empty()) {
            napi_value cb;
            napi_get_reference_value(env, g_addon.onScanoutClientReject, &cb);
            for (const auto& r : rejects) {
                napi_value obj, v;
                napi_create_object(env, &obj);
                napi_create_uint32(env, r.outputId, &v);
                napi_set_named_property(env, obj, "outputId", v);
                napi_create_uint32(env, r.bufferId, &v);
                napi_set_named_property(env, obj, "bufferId", v);
                napi_call_function(env, undefined, cb, 1, &obj, nullptr);
                logJsException(env, "onScanoutClientReject");
            }
        }
    }
    napi_close_handle_scope(env, scope);
}

// Drain queued OutputModes messages and invoke the JS onOutputModes
// callback per output. Each call carries { outputId, modes: [{ width,
// height, refreshMhz, preferred }] }. Same Node thread; same pattern
// as fireOutputDescriptors.
void fireOutputModes(napi_env env) {
    if (!g_addon.compositor || !g_addon.onOutputModes) return;
    std::vector<Compositor::OutputModesMsg> msgs;
    g_addon.compositor->takePendingOutputModes(msgs);
    if (msgs.empty()) return;
    napi_handle_scope scope;
    napi_open_handle_scope(env, &scope);
    napi_value cb, undefined;
    napi_get_reference_value(env, g_addon.onOutputModes, &cb);
    napi_get_undefined(env, &undefined);
    for (const auto& msg : msgs) {
        napi_value obj, v, arr;
        napi_create_object(env, &obj);
        napi_create_uint32(env, msg.outputId, &v);
        napi_set_named_property(env, obj, "outputId", v);
        napi_create_array_with_length(env, msg.modes.size(), &arr);
        for (size_t i = 0; i < msg.modes.size(); ++i) {
            const auto& m = msg.modes[i];
            napi_value entry, ev;
            napi_create_object(env, &entry);
            napi_create_uint32(env, m.width,      &ev); napi_set_named_property(env, entry, "width", ev);
            napi_create_uint32(env, m.height,     &ev); napi_set_named_property(env, entry, "height", ev);
            napi_create_uint32(env, m.refreshMhz, &ev); napi_set_named_property(env, entry, "refreshMhz", ev);
            napi_get_boolean(env, m.preferred, &ev);
            napi_set_named_property(env, entry, "preferred", ev);
            napi_set_element(env, arr, static_cast<uint32_t>(i), entry);
        }
        napi_set_named_property(env, obj, "modes", arr);
        napi_call_function(env, undefined, cb, 1, &obj, nullptr);
        logJsException(env, "onOutputModes");
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
        // No logJsException: this runs inside a JS-initiated binding call,
        // so a throw from cb propagates to the JS caller.
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
// acquireOutputTexture(outputId) -> bigint | null. The render target for the given
// output (KMS: that output's next free scanout slot; nested: the host swapchain),
// for the JS compositor to wrap + render into this frame. outputId defaults to 0.
napi_value AcquireOutputTexture(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t outputId = 0;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &outputId);
    WGPUTexture t = g_addon.compositor->acquireOutputTextureHandle(outputId);
    if (!t) return nullptr;
    napi_value out;
    napi_create_bigint_uint64(env, reinterpret_cast<uint64_t>(t), &out);
    return out;
}

// presentOutput(outputId) -> undefined. Present the acquired target for the given
// output. outputId defaults to 0.
napi_value PresentOutput(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t outputId = 0;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &outputId);
    g_addon.compositor->presentOutput(outputId);
    return nullptr;
}

// sendCursorImage(outputId, pixels: Uint8Array, srcW, srcH, dstW, dstH) ->
// undefined. Install a hardware-cursor image for one output; pixels are
// tightly-packed premultiplied BGRA.
napi_value SendCursorImage(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 6; napi_value argv[6];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 6) return nullptr;
    uint32_t outputId = 0, srcW = 0, srcH = 0, dstW = 0, dstH = 0;
    napi_get_value_uint32(env, argv[0], &outputId);
    napi_get_value_uint32(env, argv[2], &srcW);
    napi_get_value_uint32(env, argv[3], &srcH);
    napi_get_value_uint32(env, argv[4], &dstW);
    napi_get_value_uint32(env, argv[5], &dstH);
    napi_typedarray_type type;
    size_t length = 0;
    void* data = nullptr;
    if (napi_get_typedarray_info(env, argv[1], &type, &length, &data,
                                 nullptr, nullptr) != napi_ok
        || type != napi_uint8_array || !data) {
        return nullptr;
    }
    if (length < static_cast<size_t>(srcW) * srcH * 4u) return nullptr;
    g_addon.compositor->sendCursorImage(outputId,
                                        static_cast<const uint8_t*>(data),
                                        srcW, srcH, dstW, dstH);
    return nullptr;
}

// sendCursorImageShm(outputId, poolId, offset, stride, srcW, srcH, dstW,
// dstH) -> undefined. Install a hardware-cursor image whose pixels live in
// a registered wl_shm pool the GPU process has mapped.
napi_value SendCursorImageShm(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 8; napi_value argv[8];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 8) return nullptr;
    uint32_t v[8] = {};
    for (int i = 0; i < 8; ++i) napi_get_value_uint32(env, argv[i], &v[i]);
    g_addon.compositor->sendCursorImageShm(v[0], v[1], v[2], v[3],
                                           v[4], v[5], v[6], v[7]);
    return nullptr;
}

// sendCursorState(outputId, x, y, visible, commitNow) -> undefined. Cursor
// plane position (device px, hotspot-adjusted, may be negative) +
// visibility; commitNow=true when no frame render is coming so the GPU
// process issues the cursor-only commit itself.
napi_value SendCursorState(napi_env env, napi_callback_info info) {
    if (!g_addon.compositor) return nullptr;
    size_t argc = 5; napi_value argv[5];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 5) return nullptr;
    uint32_t outputId = 0;
    int32_t x = 0, y = 0;
    bool visible = false, commitNow = false;
    napi_get_value_uint32(env, argv[0], &outputId);
    napi_get_value_int32(env, argv[1], &x);
    napi_get_value_int32(env, argv[2], &y);
    napi_get_value_bool(env, argv[3], &visible);
    napi_get_value_bool(env, argv[4], &commitNow);
    g_addon.compositor->sendCursorState(outputId, x, y, visible, commitNow);
    return nullptr;
}

// sendScanoutClientPresent(outputId, importId, bufferId, fence?: WaylandFd|null,
// tearing?: boolean) -> boolean. Put the imported client dmabuf on the
// output's primary plane (direct scanout). The optional fence is the
// explicit-sync acquire sync_file (consumed); tearing requests an immediate
// (async) page flip, best-effort. false = the frame was not queued (unknown
// import); the caller composites instead.
napi_value SendScanoutClientPresent(napi_env env, napi_callback_info info) {
    size_t argc = 5; napi_value argv[5];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    napi_value fals;
    napi_get_boolean(env, false, &fals);
    if (!g_addon.compositor || argc < 3) return fals;
    uint32_t outputId = 0, importId = 0, bufferId = 0;
    napi_get_value_uint32(env, argv[0], &outputId);
    napi_get_value_uint32(env, argv[1], &importId);
    napi_get_value_uint32(env, argv[2], &bufferId);
    int fenceFd = -1;
    if (argc >= 4) {
        napi_valuetype t;
        napi_typeof(env, argv[3], &t);
        if (t != napi_null && t != napi_undefined) {
            fenceFd = overdraw::wayland::takeWaylandFd(env, argv[3]);
        }
    }
    bool tearing = false;
    if (argc >= 5) napi_get_value_bool(env, argv[4], &tearing);
    const bool ok = g_addon.compositor->sendScanoutClientPresent(
        outputId, importId, bufferId, fenceFd, tearing);
    napi_value out;
    napi_get_boolean(env, ok, &out);
    return out;
}

// scanoutFormatIndices(outputId) -> number[]. The dmabuf-feedback format-
// table indices the output's primary plane can scan out (the scanout
// tranche). Empty array when unknown / nested.
napi_value ScanoutFormatIndices(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    napi_value arr;
    napi_create_array(env, &arr);
    if (!g_addon.compositor || argc < 1) return arr;
    uint32_t outputId = 0;
    napi_get_value_uint32(env, argv[0], &outputId);
    const auto idx = g_addon.compositor->scanoutFormatIndicesFor(outputId);
    for (size_t i = 0; i < idx.size(); ++i) {
        napi_value v;
        napi_create_uint32(env, idx[i], &v);
        napi_set_element(env, arr, static_cast<uint32_t>(i), v);
    }
    return arr;
}

// gpuRenderNode() -> string. The /dev/dri/renderD* node the GPU process opened
// for GBM allocation, derived from the dmabuf-feedback main_device dev_t. Tests
// use it to allocate client dmabufs on the SAME GPU as the compositor (else a
// multi-GPU box imports a buffer from the wrong card). Falls back to renderD128.
napi_value GpuRenderNode(napi_env env, napi_callback_info) {
    std::string node = "/dev/dri/renderD128";
    if (g_addon.compositor) {
        uint64_t dev = g_addon.compositor->dmabufFeedback().mainDevice;
        if (dev != 0)
            node = "/dev/dri/renderD" + std::to_string(minor(static_cast<dev_t>(dev)));
    }
    napi_value out;
    napi_create_string_utf8(env, node.c_str(), node.size(), &out);
    return out;
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

// reserveShmTexture(surfaceId, width, height) -> bigint | null
// Allocate a sampleable BGRA8 wire texture (handed to JS as a raw pointer
// for dawn.wrapTexture). Internally: ReserveTexture + AllocShmTex wire frame
// so the GPU process injects the matching native VkImage. Returns null on
// failure (compositor not running, dims zero, wire link down).
napi_value ReserveShmTexture(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) return throwError(env,
        "reserveShmTexture(surfaceId, width, height)");
    if (!g_addon.compositor) {
        napi_value n; napi_get_null(env, &n); return n;
    }
    uint32_t surfaceId = 0, w = 0, h = 0;
    napi_get_value_uint32(env, argv[0], &surfaceId);
    napi_get_value_uint32(env, argv[1], &w);
    napi_get_value_uint32(env, argv[2], &h);
    WGPUTexture tex = g_addon.compositor->reserveShmTexture(surfaceId, w, h);
    if (!tex) { napi_value n; napi_get_null(env, &n); return n; }
    napi_value out;
    napi_create_bigint_uint64(env,
        static_cast<uint64_t>(reinterpret_cast<uintptr_t>(tex)), &out);
    return out;
}

// commitShmUpload(surfaceId, poolId, offset, width, height, stride, damage) -> uint
// damage: optional array of {x, y, width, height}; empty / undefined = full
// buffer. Returns uploadSeq (0 on failure). The matching wl_buffer.release
// is deferred until takeShmUploadAcks() reports this seq.
napi_value CommitShmUpload(napi_env env, napi_callback_info info) {
    size_t argc = 7; napi_value argv[7];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 6) return throwError(env,
        "commitShmUpload(surfaceId, poolId, offset, width, height, stride[, damage])");
    if (!g_addon.compositor) {
        napi_value zero; napi_create_uint32(env, 0, &zero); return zero;
    }
    uint32_t surfaceId = 0, poolId = 0, w = 0, h = 0, stride = 0;
    int64_t offset64 = 0;
    napi_get_value_uint32(env, argv[0], &surfaceId);
    napi_get_value_uint32(env, argv[1], &poolId);
    napi_get_value_int64(env, argv[2], &offset64);
    napi_get_value_uint32(env, argv[3], &w);
    napi_get_value_uint32(env, argv[4], &h);
    napi_get_value_uint32(env, argv[5], &stride);

    std::vector<overdraw::core::Compositor::DamageRect> damage;
    if (argc >= 7) {
        bool isArr = false;
        napi_is_array(env, argv[6], &isArr);
        if (isArr) {
            uint32_t n = 0;
            napi_get_array_length(env, argv[6], &n);
            damage.reserve(n);
            for (uint32_t i = 0; i < n; ++i) {
                napi_value el;
                napi_get_element(env, argv[6], i, &el);
                overdraw::core::Compositor::DamageRect r{};
                r.x = static_cast<int32_t>(getU32(env, el, "x"));
                r.y = static_cast<int32_t>(getU32(env, el, "y"));
                r.w = getU32(env, el, "width");
                r.h = getU32(env, el, "height");
                damage.push_back(r);
            }
        }
    }
    const uint32_t seq = g_addon.compositor->commitShmUpload(
        surfaceId, poolId, static_cast<uint64_t>(offset64), w, h, stride,
        damage.data(), damage.size());
    napi_value out; napi_create_uint32(env, seq, &out);
    return out;
}

// takeShmUploadAcks() -> uint32_t[]
// Drain pending ShmUploaded reply seqs. The JS layer uses each one to
// release the matching deferred wl_buffer.
napi_value TakeShmUploadAcks(napi_env env, napi_callback_info /*info*/) {
    if (!g_addon.compositor) {
        napi_value arr; napi_create_array_with_length(env, 0, &arr); return arr;
    }
    auto acks = g_addon.compositor->takeShmUploadAcks();
    napi_value arr;
    napi_create_array_with_length(env, acks.size(), &arr);
    for (size_t i = 0; i < acks.size(); ++i) {
        napi_value v; napi_create_uint32(env, acks[i], &v);
        napi_set_element(env, arr, i, v);
    }
    return arr;
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

// writeBeginAccessWithFence(importId, acquireFenceFd: WaylandFd) -> bool.
// In-band per-frame BeginAccess that ATTACHES the given sync_file fd via
// SCM_RIGHTS. The GPU process uses it as the Dawn acquire fence instead of
// running EXPORT_SYNC_FILE on the dmabuf (the implicit-sync path). Driven by
// wp_linux_drm_syncobj_v1: the JS layer exports a sync_file from the client's
// acquire timeline point and hands it here. Consumes the WaylandFd (the wire
// serializer dups; we close the original).
napi_value WriteBeginAccessWithFence(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (!g_addon.compositor) { napi_value f; napi_get_boolean(env, false, &f); return f; }
    uint32_t importId = 0;
    napi_get_value_uint32(env, argv[0], &importId);
    int fenceFd = overdraw::wayland::takeWaylandFd(env, argv[1]);
    if (importId == 0 || fenceFd < 0) {
        if (fenceFd >= 0) ::close(fenceFd);
        napi_value f; napi_get_boolean(env, false, &f); return f;
    }
    const bool ok = g_addon.compositor->writeClientTexBeginAccessWithFence(importId, fenceFd);
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

// shmMapWritable(poolId, offset, length) -> ArrayBuffer | null
// An INDEPENDENT writable mapping over the pool's fd, covering the requested
// region. The default shmView mapping is MAP_PRIVATE / PROT_READ; capture-
// destination buffers need MAP_SHARED / PROT_READ|PROT_WRITE so writes the
// compositor performs into the buffer are visible to the client when it
// re-reads the shm contents. The returned ArrayBuffer owns its own mmap;
// finalization runs munmap. Returns null on out-of-range / mmap failure.
struct WritableMmapHandle {
    void* base;
    size_t size;
};
void WritableMmapFinalize(napi_env /*env*/, void* /*data*/, void* hint) {
    auto* h = static_cast<WritableMmapHandle*>(hint);
    if (h) {
        if (h->base && h->size) ::munmap(h->base, h->size);
        delete h;
    }
}
napi_value ShmMapWritable(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t poolId = 0, offset = 0, length = 0;
    napi_get_value_uint32(env, argv[0], &poolId);
    napi_get_value_uint32(env, argv[1], &offset);
    napi_get_value_uint32(env, argv[2], &length);
    void* mmapBase = nullptr;
    size_t mmapSize = 0;
    uint8_t* p = g_addon.shm.mapWritable(poolId, offset, length, &mmapBase, &mmapSize);
    if (!p) return nullptr;
    auto* hint = new WritableMmapHandle{mmapBase, mmapSize};
    napi_value ab;
    if (napi_create_external_arraybuffer(env, p, length, WritableMmapFinalize,
                                         hint, &ab) != napi_ok) {
        if (mmapBase) ::munmap(mmapBase, mmapSize);
        delete hint;
        return nullptr;
    }
    return ab;
}

napi_value Stop(napi_env env, napi_callback_info) {
    if (g_addon.loopRunning) {
        // Stop the headless frame driver first so no render fires while the
        // polls + wire are torn down below.
        if (g_addon.headlessFrameTimerActive) {
            uv_timer_stop(&g_addon.headlessFrameTimer);
            uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.headlessFrameTimer), nullptr);
            g_addon.headlessFrameTimerActive = false;
        }
        uv_poll_stop(&g_addon.wirePoll);
        uv_poll_stop(&g_addon.ctrlPoll);
        uv_prepare_stop(&g_addon.flushPrepare);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.wirePoll), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.ctrlPoll), nullptr);
        uv_close(reinterpret_cast<uv_handle_t*>(&g_addon.flushPrepare), nullptr);
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
    // Stop the log reader thread (drains its socket; closes the host-side fd).
    if (g_addon.logSource) {
        g_addon.logSource->stop();
        g_addon.logSource.reset();
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
#if OVERDRAW_KMS
        g_addon.libinputBackend = nullptr;
#endif
    }
    // Close the syncobj DRM fd. In KMS mode this aliased drmCardFd and is
    // closed below with the card; in nested mode we opened it and must close
    // it here.
    if (g_addon.syncobjFdValue >= 0 && g_addon.syncobjFdOwned) {
        ::close(g_addon.syncobjFdValue);
    }
    g_addon.syncobjFdValue = -1;
    g_addon.syncobjFdOwned = false;
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
    if (g_addon.onOutputAdded) {
        napi_delete_reference(env, g_addon.onOutputAdded);
        g_addon.onOutputAdded = nullptr;
    }
    if (g_addon.onOutputRemoved) {
        napi_delete_reference(env, g_addon.onOutputRemoved);
        g_addon.onOutputRemoved = nullptr;
    }
    if (g_addon.onOutputModes) {
        napi_delete_reference(env, g_addon.onOutputModes);
        g_addon.onOutputModes = nullptr;
    }
    if (g_addon.onFlipComplete) {
        napi_delete_reference(env, g_addon.onFlipComplete);
        g_addon.onFlipComplete = nullptr;
    }
    if (g_addon.onCursorPlaneStatus) {
        napi_delete_reference(env, g_addon.onCursorPlaneStatus);
        g_addon.onCursorPlaneStatus = nullptr;
    }
    if (g_addon.onScanoutClientFlip) {
        napi_delete_reference(env, g_addon.onScanoutClientFlip);
        g_addon.onScanoutClientFlip = nullptr;
    }
    if (g_addon.onScanoutClientReject) {
        napi_delete_reference(env, g_addon.onScanoutClientReject);
        g_addon.onScanoutClientReject = nullptr;
    }
    if (g_addon.onSeatEnabled) {
        napi_delete_reference(env, g_addon.onSeatEnabled);
        g_addon.onSeatEnabled = nullptr;
    }
    // Release the keymaps. The default is built on demand by ensureKeymap()
    // from either keymapInfo (client wl_keyboard bind) or keyUpdate (host
    // key-down); a subsequent start()/stop() cycle must see fresh state.
    g_addon.keymap.reset();
    g_addon.virtualKeymaps.clear();
    g_addon.nextKeymapId = 1;
    g_addon.activeKeymapId = 0;
    g_addon.lastNotified = 0;
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// startServer() -> string (socket name) : stand up the Wayland server on the
// libuv loop. Independent of the present loop for now.
napi_value StartServer(napi_env env, napi_callback_info) {
    ensureUvJsCtx(env);
    if (!g_addon.server) g_addon.server = std::make_unique<Server>();
    uv_loop_t* loop = nullptr;
    napi_get_uv_event_loop(env, &loop);
    if (!g_addon.server->start(loop)) {
        g_addon.server.reset();
        return throwError(env, "failed to start wayland server");
    }
    // Wake the frame loop after every Wayland-server pump tick: a client
    // commit/attach/etc arrived and the frame callbacks + render need to run.
    g_addon.server->setOnPump([]() { wake(); });
    // Client request dispatch trampolines into JS protocol handlers; run it
    // inside a microtask-draining scope (see uv_js_scope.h).
    g_addon.server->setDispatchScope([](const std::function<void()>& body) {
        UvJsScope jsScope(g_addon.env, g_addon.uvJsCtx);
        body();
    });
    napi_value name;
    napi_create_string_utf8(env, g_addon.server->socketName().c_str(), NAPI_AUTO_LENGTH, &name);
    return name;
}

napi_value StopServer(napi_env env, napi_callback_info) {
    // Order matters: live wl_resources hold raw pointers into the trampoline
    // (dispatcher InterfaceState, per-resource destroy listeners), and the
    // display is what invokes them. Destroy the server (and with it the
    // display) first so nothing can dispatch into -- or fire a destroy
    // listener on -- a freed trampoline; only then drop the trampoline and
    // the registry its dispatch path reads.
    if (g_addon.server) { g_addon.server->stop(); g_addon.server.reset(); }
    if (g_addon.trampoline) g_addon.trampoline.reset();
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

// createGlobalForOutput(interfaceName: string, outputId: number,
//                       handler: object) -> undefined
//
// Advertise another global for `interfaceName` tagged with `outputId`. Each
// global has its own JS bind handler, so multiple outputs can each advertise
// their own wl_output (etc.). The interface must already be registered.
napi_value CreateGlobalForOutput(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) return throwError(env,
        "createGlobalForOutput(name, outputId, handler) requires three args");
    if (!g_addon.server || !g_addon.registry)
        return throwError(env, "server + protocols must be registered first");

    if (!g_addon.trampoline)
        g_addon.trampoline = std::make_unique<Trampoline>(
            env, g_addon.server->display(), g_addon.registry.get());

    char name[256]; size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len);
    uint32_t outputId = 0;
    napi_get_value_uint32(env, argv[1], &outputId);
    if (!g_addon.trampoline->createGlobalForOutput(name, outputId, argv[2]))
        return throwError(env, "createGlobalForOutput: unknown interface");

    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// destroyGlobalForOutput(interfaceName: string, outputId: number) -> undefined
//
// Tear down a previously-advertised per-output global (the inverse of
// createGlobalForOutput). Clients see wl_registry.global_remove and any
// existing resources become destroyable. Used by the hotplug handler on
// output removal AFTER protocol-level "leave" events have fired.
napi_value DestroyGlobalForOutput(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env,
        "destroyGlobalForOutput(name, outputId) requires two args");
    if (!g_addon.trampoline) return throwError(env, "trampoline not initialized");

    char name[256]; size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len);
    uint32_t outputId = 0;
    napi_get_value_uint32(env, argv[1], &outputId);
    g_addon.trampoline->destroyGlobalForOutput(name, outputId);

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

// postError(resourceHandle, code, message) -> undefined
// Post a fatal protocol error on a client resource; the client is disconnected
// after the current dispatch.
napi_value PostError(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) return throwError(env, "postError(resource, code, message) requires three args");
    if (!g_addon.trampoline) return throwError(env, "no trampoline");
    uint32_t code = 0; napi_get_value_uint32(env, argv[1], &code);
    size_t len = 0; napi_get_value_string_utf8(env, argv[2], nullptr, 0, &len);
    std::string msg(len, '\0');
    napi_get_value_string_utf8(env, argv[2], msg.data(), len + 1, &len);
    if (!g_addon.trampoline->postError(argv[0], code, msg))
        return throwError(env, "postError failed");
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

// clientPid(resource) -> number : the peer PROCESS id of the client owning the
// resource's connection (SO_PEERCRED). 0 on error. Used to recognize the
// Xwayland connection (the compositor spawned it and knows its pid).
napi_value ClientPid(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1 || !g_addon.trampoline) { napi_value z; napi_create_double(env, 0, &z); return z; }
    int32_t pid = g_addon.trampoline->clientPidOf(argv[0]);
    napi_value out; napi_create_double(env, static_cast<double>(pid), &out);
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

// The keymap keyUpdate()/keymapInfo() currently operate on, per activeKeymapId.
// Falls back to the default if the active virtual keymap was unregistered out
// from under us. Returns nullptr only if the default failed to compile.
Keymap* activeKeymapPtr() {
    if (!ensureKeymap()) return nullptr;
    if (g_addon.activeKeymapId != 0) {
        auto it = g_addon.virtualKeymaps.find(g_addon.activeKeymapId);
        if (it != g_addon.virtualKeymaps.end()) return it->second.get();
        g_addon.activeKeymapId = 0;  // stale id; revert to default
    }
    return g_addon.keymap.get();
}

// updateOutputLayout(rects) -> undefined
// Update the input backend's view of the multi-output layout (used for
// pointer-space mapping and cursor clamping). `rects` is an Array<{x, y, w, h}>
// in global logical pixels. Called whenever state.outputs changes
// (add/remove/resize). Silent no-op if no input backend is active.
napi_value UpdateOutputLayout(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "updateOutputLayout(rects) requires 1 arg");

    bool isArr = false;
    napi_is_array(env, argv[0], &isArr);
    if (!isArr) return throwError(env, "updateOutputLayout: rects must be an Array");

    uint32_t n = 0;
    napi_get_array_length(env, argv[0], &n);
    std::vector<overdraw::core::OutputRect> outs;
    outs.reserve(n);
    for (uint32_t i = 0; i < n; ++i) {
        napi_value item;
        napi_get_element(env, argv[0], i, &item);
        napi_valuetype t;
        napi_typeof(env, item, &t);
        if (t != napi_object) {
            return throwError(env, "updateOutputLayout: each rect must be an object");
        }
        overdraw::core::OutputRect r{};
        napi_value v;
        if (napi_get_named_property(env, item, "x", &v) == napi_ok) {
            int32_t x = 0; napi_get_value_int32(env, v, &x); r.x = x;
        }
        if (napi_get_named_property(env, item, "y", &v) == napi_ok) {
            int32_t y = 0; napi_get_value_int32(env, v, &y); r.y = y;
        }
        if (napi_get_named_property(env, item, "w", &v) == napi_ok) {
            uint32_t w = 0; napi_get_value_uint32(env, v, &w); r.w = w;
        }
        if (napi_get_named_property(env, item, "h", &v) == napi_ok) {
            uint32_t h = 0; napi_get_value_uint32(env, v, &h); r.h = h;
        }
        outs.push_back(r);
    }
    if (g_addon.input) g_addon.input->setOutputLayout(outs);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// Swap a stored JS-callback reference for a setOnX(cb) binding: drop the old
// reference, then hold the new one iff the first argument is a function
// (null / omitted clears).
void replaceCallbackRef(napi_env env, napi_callback_info info, napi_ref& ref) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (ref) {
        napi_delete_reference(env, ref);
        ref = nullptr;
    }
    if (argc >= 1) {
        napi_valuetype t; napi_typeof(env, argv[0], &t);
        if (t == napi_function) napi_create_reference(env, argv[0], 1, &ref);
    }
}

// setOnFlipComplete(cb) -> undefined
// Register a JS callback fired once per drained KMS flip-complete. The callback
// receives one outputId per call. JS dispatches wl_callback.done for surfaces
// resident on that output here -- so a surface on a 60Hz output sees `done` at
// 60Hz even when a 240Hz output is also flipping. Pass null/omit to clear.
napi_value SetOnFlipComplete(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onFlipComplete);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnSeatEnabled(cb) -> undefined
// Register a JS callback fired when libseat re-enables the seat (VT switch
// back). No payload. The handler marks every output fully damaged so the
// native wake() that follows the callback repaints and re-presents. Never
// fires in nested/headless mode (no seat). Pass null/omit to clear.
napi_value SetOnSeatEnabled(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onSeatEnabled);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnOutputDescriptor(cb) -> undefined
// Register a JS callback fired for each OutputDescriptor message arriving from
// the GPU process. The callback receives one object per descriptor with
// {width, height, refreshMhz, scale, transform, physicalWidthMm,
//  physicalHeightMm, name, make, model}. Called on the Node thread from the
// ctrl/wire poll. Passing null (or omitting the arg) clears the callback.
napi_value SetOnOutputDescriptor(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onOutput);
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

// setOnOutputAdded(cb) -> undefined
// Register a JS callback fired for each OutputAdded message arriving from
// the GPU process (hotplug). Same payload shape as OutputDescriptor
// (outputId + width/height/refreshMhz/scale/transform/physical/name/make/
// model). The handler creates state.outputs[outputId], calls
// reserveScanoutForOutput to complete the runtime ring handshake, and emits
// output.added on the plugin bus. Pass null/omit to clear.
napi_value SetOnOutputAdded(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onOutputAdded);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnOutputRemoved(cb) -> undefined
// Register a JS callback fired for each OutputRemoved message arriving from
// the GPU process (hotplug). Payload is { outputId }. The handler fires
// output.pre-remove (workspace migration + wl_surface.leave), tears down
// state.outputs[outputId], destroys that output's wl_output global, and
// fires output.removed. Pass null/omit to clear.
napi_value SetOnOutputRemoved(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onOutputRemoved);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnOutputModes(cb) -> undefined
// Register a JS callback fired for each OutputModes message arriving
// from the GPU process. The GPU emits these right after OutputAdded
// (or the startup OutputDescriptor) so the JS handler can update
// state.outputs[outputId].availableModes for already-existing outputs.
// Callback receives { outputId: number, modes: [{ width, height,
// refreshMhz, preferred }] }. Pass null/omit to clear.
napi_value SetOnOutputModes(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onOutputModes);
    // Same bring-up consideration as setOnOutputDescriptor: drain ctrl
    // / wire and fire any already-queued modes so the freshly-registered
    // callback sees them.
    if (g_addon.compositor) g_addon.compositor->drainCtrl();
    fireOutputModes(env);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnCursorPlaneStatus(cb) -> undefined
// Register a JS callback fired for each CursorPlaneStatus message arriving
// from the GPU process: { outputId, ok, maxWidth, maxHeight }. ok=true
// means the output scans the cursor out of a hardware plane sized
// maxWidth x maxHeight; ok=false means the JS compositor must software-
// composite the cursor for that output (either it has no plane, or a
// runtime commit rejection demoted it). Pass null/omit to clear.
napi_value SetOnCursorPlaneStatus(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onCursorPlaneStatus);
    // Statuses for the startup outputs may already be queued (they ride
    // the wire right after each ScanoutReady); fire them into the
    // freshly-registered callback.
    fireCursorPlaneStatuses(env);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnScanoutClientFlip(cb) -> undefined
// Register a JS callback fired per direct-scanout page flip:
// { outputId, latchedBufferId, retiredBufferId }. The retired buffer is
// no longer read by the display engine -- the JS buffer lifecycle
// releases it. Pacing (frame callbacks / wp_presentation) rides the
// ordinary onFlipComplete callback. Pass null/omit to clear.
napi_value SetOnScanoutClientFlip(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onScanoutClientFlip);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setOnScanoutClientReject(cb) -> undefined
// Register a JS callback fired when the GPU process refuses to scan out a
// buffer ({ outputId, bufferId }): the core repaints through the composite
// path and vetoes the pair. Pass null/omit to clear.
napi_value SetOnScanoutClientReject(napi_env env, napi_callback_info info) {
    replaceCallbackRef(env, info, g_addon.onScanoutClientReject);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// reserveScanoutForOutput(outputId, width, height) -> undefined
// Send ScanoutReserve for a runtime-added output. Called by the
// output.added JS handler after OutputAdded arrives so the GPU process can
// complete its bring-up handshake (it InjectTextures at the reserved handles
// and replies ScanoutReady, consumed by drainCtrl). KMS only; nested/headless
// are silent no-ops.
napi_value ReserveScanoutForOutput(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 3) return throwError(env,
        "reserveScanoutForOutput(outputId, width, height) requires three args");
    if (!g_addon.compositor) return throwError(env, "compositor not running");
    uint32_t outputId = 0, w = 0, h = 0;
    napi_get_value_uint32(env, argv[0], &outputId);
    napi_get_value_uint32(env, argv[1], &w);
    napi_get_value_uint32(env, argv[2], &h);
    g_addon.compositor->reserveScanoutForOutput(outputId, w, h);
    armCtrlPoll();  // CtrlSender may have queued bytes; drain when writable.
    napi_value u; napi_get_undefined(env, &u); return u;
}

// switchOutputMode(outputId, width, height, refreshMhz) -> undefined
// Request a KMS mode swap on `outputId`. Width/height/refreshMhz must match
// a mode the connector advertises (no custom modes in v1). Sends a
// SwitchMode wire frame to the GPU process; the GPU process tears down and
// rebuilds the ring, then sends ScanoutRebuild on the wire, which
// re-runs the ScanoutReserve handshake at the new dims. The
// matching OutputDescriptor follows on ctrl so JS state.outputs[].deviceSize
// updates and the existing output.changed re-emit chain runs.
// Asynchronous: returns once the SwitchMode frame is appended to the
// outbound wire queue.
napi_value SwitchOutputMode(napi_env env, napi_callback_info info) {
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 4) return throwError(env,
        "switchOutputMode(outputId, width, height, refreshMhz) requires four args");
    if (!g_addon.compositor) return throwError(env, "compositor not running");
    uint32_t outputId = 0, w = 0, h = 0, refreshMhz = 0;
    napi_get_value_uint32(env, argv[0], &outputId);
    napi_get_value_uint32(env, argv[1], &w);
    napi_get_value_uint32(env, argv[2], &h);
    napi_get_value_uint32(env, argv[3], &refreshMhz);
    g_addon.compositor->switchOutputMode(outputId, w, h, refreshMhz);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// releaseScanoutForOutput(outputId) -> undefined
// Drop the core-side per-output scanout state on output removal. The GPU
// process has already torn down its ring; this clears the core's slot
// bookkeeping so a future OutputAdded at the same outputId can build a fresh
// ring. KMS only; nested/headless are silent no-ops.
napi_value ReleaseScanoutForOutput(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env,
        "releaseScanoutForOutput(outputId) requires outputId");
    if (!g_addon.compositor) return throwError(env, "compositor not running");
    uint32_t outputId = 0;
    napi_get_value_uint32(env, argv[0], &outputId);
    g_addon.compositor->releaseScanoutForOutput(outputId);
    napi_value u; napi_get_undefined(env, &u); return u;
}

// keymapInfo() -> { fd: WaylandFd, format, size } | null
// Each call returns a fresh dup of the keymap memfd wrapped as a WaylandFd
// (each client gets its own to mmap).
napi_value KeymapInfo(napi_env env, napi_callback_info) {
    Keymap* km = activeKeymapPtr();
    if (!km) { napi_value n; napi_get_null(env, &n); return n; }
    int fd = km->dupFd();
    if (fd < 0) { napi_value n; napi_get_null(env, &n); return n; }
    napi_value obj; napi_create_object(env, &obj);
    napi_set_named_property(env, obj, "fd", overdraw::wayland::makeWaylandFd(env, fd));
    napi_value fmt; napi_create_uint32(env, km->format(), &fmt);
    napi_set_named_property(env, obj, "format", fmt);
    napi_value sz; napi_create_uint32(env, km->size(), &sz);
    napi_set_named_property(env, obj, "size", sz);
    return obj;
}

// keyUpdate(evdevKey, pressed)
//   -> { modsDepressed, modsLatched, modsLocked, group, keysym, baseKeysym }
// Feeds the key into the xkb state and returns the resulting modifier masks for
// wl_keyboard.modifiers, the Shift-translated keysym (post-update; VT-switch
// detection), and the shift-level-0 base keysym (binding-chain matching).
// Returns zeros if the keymap cannot be built.
napi_value KeyUpdate(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t key = 0; bool pressed = false;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &key);
    if (argc >= 2) napi_get_value_bool(env, argv[1], &pressed);
    uint32_t dep = 0, lat = 0, lock = 0, grp = 0, sym = 0, base = 0;
    Keymap* km = activeKeymapPtr();
    if (km) {
        km->updateKey(key, pressed);
        km->modifiers(dep, lat, lock, grp);
        sym = km->keysym(key);
        base = km->baseKeysym(key);
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
    setU("baseKeysym", base);
    return obj;
}

// registerKeymap(fd, size) -> number
// Compile a client-supplied keymap (a WaylandFd holding XKB_KEYMAP_FORMAT_TEXT_V1
// text, `size` bytes incl. NUL) into a new Keymap and return its id (>= 1), or 0
// on a bad fd / compile failure. Takes ownership of the WaylandFd. The id is
// later passed as keyboardKey.keymapId / to setActiveKeymap / unregisterKeymap.
napi_value RegisterKeymap(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    napi_value zero; napi_create_uint32(env, 0, &zero);
    if (argc < 2) return zero;
    int fd = overdraw::wayland::takeWaylandFd(env, argv[0]);
    if (fd < 0) return zero;
    uint32_t size = 0; napi_get_value_uint32(env, argv[1], &size);
    auto km = std::make_unique<Keymap>();
    if (!km->initFromFd(fd, size)) return zero;  // initFromFd closed the fd
    uint32_t id = g_addon.nextKeymapId++;
    g_addon.virtualKeymaps[id] = std::move(km);
    napi_value out; napi_create_uint32(env, id, &out); return out;
}

// unregisterKeymap(id) -> undefined
// Drop a virtual keymap (its xkb state + memfd). If it was active, revert to the
// default. No-op for id 0 or an unknown id.
napi_value UnregisterKeymap(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t id = 0; if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);
    if (id != 0) {
        g_addon.virtualKeymaps.erase(id);
        if (g_addon.activeKeymapId == id) g_addon.activeKeymapId = 0;
    }
    napi_value u; napi_get_undefined(env, &u); return u;
}

// setActiveKeymap(id) -> boolean
// Select which keymap keyUpdate()/keymapInfo() operate on (0 = default, else a
// registered virtual keymap). Returns true if the active keymap actually
// changed (the seat then re-sends the keymap to bound wl_keyboards). An unknown
// id falls back to the default.
napi_value SetActiveKeymap(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t id = 0; if (argc >= 1) napi_get_value_uint32(env, argv[0], &id);
    if (id != 0 && g_addon.virtualKeymaps.find(id) == g_addon.virtualKeymaps.end())
        id = 0;  // unknown id -> default
    bool changed = (id != g_addon.activeKeymapId);
    g_addon.activeKeymapId = id;
    napi_value out; napi_get_boolean(env, changed, &out); return out;
}

// setModifiers(depressed, latched, locked, group)
//   -> { modsDepressed, modsLatched, modsLocked, group }
// Set the active keymap's xkb modifier/layout state directly from serialized
// masks (a virtual keyboard's explicit modifiers request) and read back the
// canonical masks to forward to clients. Returns zeros if no keymap is built.
napi_value SetModifiers(napi_env env, napi_callback_info info) {
    size_t argc = 4; napi_value argv[4];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t dep = 0, lat = 0, lock = 0, grp = 0;
    if (argc >= 1) napi_get_value_uint32(env, argv[0], &dep);
    if (argc >= 2) napi_get_value_uint32(env, argv[1], &lat);
    if (argc >= 3) napi_get_value_uint32(env, argv[2], &lock);
    if (argc >= 4) napi_get_value_uint32(env, argv[3], &grp);
    uint32_t odep = 0, olat = 0, olock = 0, ogrp = 0;
    Keymap* km = activeKeymapPtr();
    if (km) {
        km->updateMask(dep, lat, lock, grp);
        km->modifiers(odep, olat, olock, ogrp);
    }
    napi_value obj; napi_create_object(env, &obj);
    auto setU = [&](const char* k, uint32_t val) {
        napi_value n; napi_create_uint32(env, val, &n);
        napi_set_named_property(env, obj, k, n);
    };
    setU("modsDepressed", odep);
    setU("modsLatched", olat);
    setU("modsLocked", olock);
    setU("group", ogrp);
    return obj;
}

// switchVT(n) -> boolean
// Request a kernel VT switch to session `n` (1..12). Routes through libseat,
// which fires disable_seat → kernel performs the switch → on switch back the
// kernel fires enable_seat. Both transitions are handled by the addon's seat
// callbacks (compositor pause/resume + libinput suspend/resume). Returns
// false in nested mode (no seat) or if libseat rejects.
napi_value SwitchVT(napi_env env, napi_callback_info info) {
    napi_value out;
    napi_get_boolean(env, false, &out);
#if OVERDRAW_KMS
    if (!g_addon.seat) return out;
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return out;
    uint32_t n = 0;
    if (napi_get_value_uint32(env, argv[0], &n) != napi_ok) return out;
    if (n < 1 || n > 12) return out;
    bool ok = g_addon.seat->switchSession(static_cast<int>(n));
    napi_get_boolean(env, ok, &out);
#endif
    return out;
}

// wake() -> undefined
// Schedule a frame. If the frame loop is idle (no render in flight, no flip
// pending on KMS), the render fires synchronously on the same call; otherwise
// it is queued and runs on the next opportunity. Idempotent and cheap when
// the loop is already busy; coalesces multiple wake() in a row into one frame.
//
// JS calls this when a JS-side change requests a render that no native event
// covers (an animation/transition tick that wants to continue, an IPC action
// that mutated state, etc.). Native poll callbacks (wayland-server pump,
// input poll, ctrl poll with FrameComplete) wake automatically.
napi_value Wake(napi_env env, napi_callback_info) {
    wake();
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
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
// `fd` is a WaylandFd; we take the raw fd out of it (transferring ownership)
// and mmap it. Also dup's a copy to the GPU process via FrameKind::RegisterShmPool
// so the GPU process can stage upload bytes directly from the mmap (the shm-upload
// fast path that replaces queue.writeTexture for shm content).
napi_value ShmCreatePool(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "shmCreatePool(fd, size) requires two args");
    // 64-bit: the whole downstream chain (shm registry, wire payload, GPU
    // mapping) carries u64; a u32 read here would silently truncate a
    // >4GiB size.
    int64_t size64 = 0; napi_get_value_int64(env, argv[1], &size64);
    uint64_t size = size64 > 0 ? static_cast<uint64_t>(size64) : 0;
    int fd = overdraw::wayland::takeWaylandFd(env, argv[0]);
    // Dup BEFORE handing fd to the shm registry; the registry takes ownership
    // (closes on destroy / failure), and the GPU process needs its own
    // independent fd to mmap. Failure to dup is non-fatal -- the upload path
    // falls back to writeTexture for this pool. ::fcntl(F_DUPFD_CLOEXEC, 0)
    // matches the semantics dawn-wire's appendFrameWithFds uses elsewhere.
    int gpuFd = fd >= 0 ? ::fcntl(fd, F_DUPFD_CLOEXEC, 0) : -1;
    uint32_t poolId = g_addon.shm.createPool(fd, size);  // closes fd on failure
    if (poolId != 0 && gpuFd >= 0 && g_addon.compositor) {
        // Transfers ownership of gpuFd into registerShmPool, which appends a
        // wire frame carrying the fd as SCM_RIGHTS and then closes it.
        g_addon.compositor->registerShmPool(poolId, gpuFd, size);
    } else if (gpuFd >= 0) {
        ::close(gpuFd);
    }
    napi_value out; napi_create_uint32(env, poolId, &out);
    return out;
}

// shmResizePool(poolId, newSize) -> boolean
napi_value ShmResizePool(napi_env env, napi_callback_info info) {
    size_t argc = 2; napi_value argv[2];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 2) return throwError(env, "shmResizePool(poolId, newSize) requires two args");
    uint32_t poolId = 0; napi_get_value_uint32(env, argv[0], &poolId);
    int64_t newSize64 = 0; napi_get_value_int64(env, argv[1], &newSize64);
    uint64_t newSize = newSize64 > 0 ? static_cast<uint64_t>(newSize64) : 0;
    const bool ok = g_addon.shm.resizePool(poolId, newSize);
    // Mirror the grow to the GPU process's mapping; without this, ShmUpload
    // regions past the pool's creation size fail its bounds check (the
    // grown-cursor-theme-pool case) and the content silently never lands.
    if (ok && g_addon.compositor) {
        g_addon.compositor->resizeShmPool(poolId, newSize);
    }
    napi_value out; napi_get_boolean(env, ok, &out);
    return out;
}

// shmDestroyPool(poolId) -> undefined
napi_value ShmDestroyPool(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    if (argc < 1) return throwError(env, "shmDestroyPool(poolId) requires a poolId");
    uint32_t poolId = 0; napi_get_value_uint32(env, argv[0], &poolId);
    const bool freed = g_addon.shm.destroyPool(poolId);
    // Mirror the unmap to the GPU process iff the local registry actually
    // freed (no outstanding wl_buffer refs); otherwise the unregister waits
    // for the matching shmBufferUnref below.
    if (freed && g_addon.compositor) {
        g_addon.compositor->unregisterShmPool(poolId);
    }
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
    const bool freed = g_addon.shm.releaseBufferRef(poolId);
    if (freed && g_addon.compositor) {
        g_addon.compositor->unregisterShmPool(poolId);
    }
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
    else if (type == "pointerAxisSource")  ev.type = InputEventType::PointerAxisSource;
    else if (type == "pointerAxisStop")    ev.type = InputEventType::PointerAxisStop;
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
            // Optional relative deltas (zwp_relative_pointer_v1 tests). A
            // real libinput backend always carries them; synthetic events
            // default to 0.
            ev.dx = getF64(env, argv[0], "dx");
            ev.dy = getF64(env, argv[0], "dy");
            ev.dxUnaccel = getF64(env, argv[0], "dxUnaccel");
            ev.dyUnaccel = getF64(env, argv[0], "dyUnaccel");
            break;
        case InputEventType::PointerAxisSource:
            ev.axisSource = getU32(env, argv[0], "axisSource");
            break;
        case InputEventType::PointerAxisStop:
            ev.axis = getBoolProp(env, argv[0], "horizontal")
                          ? AxisKind::HorizontalScroll : AxisKind::VerticalScroll;
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
            ev.axisValue120 = static_cast<int32_t>(getU32(env, argv[0], "value120"));
            break;
        case InputEventType::KeyboardKey:
            ev.key = getU32(env, argv[0], "key");
            ev.keymapId = getU32(env, argv[0], "keymapId");
            ev.buttonState = getBoolProp(env, argv[0], "pressed")
                                 ? ButtonState::Pressed : ButtonState::Released;
            break;
        case InputEventType::KeyboardModifiers:
            ev.modsDepressed = getU32(env, argv[0], "modsDepressed");
            ev.modsLatched = getU32(env, argv[0], "modsLatched");
            ev.modsLocked = getU32(env, argv[0], "modsLocked");
            ev.group = getU32(env, argv[0], "group");
            ev.keymapId = getU32(env, argv[0], "keymapId");
            break;
        default:
            break;
    }

    g_inputSink.onInputEvent(ev);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// setPointerLocked(locked: boolean) -> undefined
// Freeze/unfreeze the input backend's cursor accumulator for an active
// zwp_locked_pointer_v1. While locked the cursor stays put but relative deltas
// keep flowing (for zwp_relative_pointer_v1).
napi_value SetPointerLocked(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    bool locked = false;
    if (argc >= 1) napi_get_value_bool(env, argv[0], &locked);
    if (g_addon.input) g_addon.input->setPointerLocked(locked);
    napi_value undef; napi_get_undefined(env, &undef);
    return undef;
}

// setPointerConfine(rects: {x,y,w,h}[]) -> undefined
// Constrain the cursor to the union of `rects` (global logical coords) for an
// active zwp_confined_pointer_v1. Empty array clears confinement.
napi_value SetPointerConfine(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    std::vector<overdraw::core::OutputRect> rects;
    if (argc >= 1) {
        uint32_t n = 0; napi_get_array_length(env, argv[0], &n);
        rects.reserve(n);
        for (uint32_t i = 0; i < n; i++) {
            napi_value r; napi_get_element(env, argv[0], i, &r);
            overdraw::core::OutputRect rect{};
            rect.x = static_cast<int32_t>(getF64(env, r, "x"));
            rect.y = static_cast<int32_t>(getF64(env, r, "y"));
            rect.w = static_cast<uint32_t>(getF64(env, r, "w"));
            rect.h = static_cast<uint32_t>(getF64(env, r, "h"));
            rects.push_back(rect);
        }
    }
    if (g_addon.input) g_addon.input->setPointerConfine(rects);
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
// Resolve (and on first nested-mode call, open) the DRM fd used for syncobj
// ioctls. In KMS mode this aliases the libseat-owned card fd; in nested mode
// it lazily opens the /dev/dri/renderD* the GPU process picked. Returns -1
// only when no DRM device can be located (no compositor + KMS not active).
int syncobjFd() {
    if (g_addon.syncobjFdValue >= 0) return g_addon.syncobjFdValue;
#if OVERDRAW_KMS
    if (g_addon.drmCardFd >= 0) {
        // Borrow libseat's card fd. syncobj ioctls don't need exclusive
        // ownership and don't disturb KMS state.
        g_addon.syncobjFdValue = g_addon.drmCardFd;
        g_addon.syncobjFdOwned = false;
        return g_addon.syncobjFdValue;
    }
#endif
    // Nested (or KMS bring-up failed before card open): open the same
    // render node the GPU process picked. Falls back to renderD128 when
    // dmabuf-feedback main_device isn't available yet.
    std::string node = "/dev/dri/renderD128";
    if (g_addon.compositor) {
        uint64_t dev = g_addon.compositor->dmabufFeedback().mainDevice;
        if (dev != 0) {
            node = "/dev/dri/renderD" + std::to_string(minor(static_cast<dev_t>(dev)));
        }
    }
    int fd = ::open(node.c_str(), O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        LOG_ERR(Core, "syncobjFd: open {} failed errno={}", node, errno);
        return -1;
    }
    g_addon.syncobjFdValue = fd;
    g_addon.syncobjFdOwned = true;
    return fd;
}

// syncobjImportTimeline(timelineFd: WaylandFd) -> handle: number | 0 on failure.
// Calls drmSyncobjFDToHandle; the returned handle is per-syncobjFd() context.
// Consumes the WaylandFd (takes its raw fd); the wrapper is left closed.
napi_value SyncobjImportTimeline(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int fd = overdraw::wayland::takeWaylandFd(env, argv[0]);
    if (fd < 0) { napi_value z; napi_create_uint32(env, 0, &z); return z; }
    int drmFd = syncobjFd();
    if (drmFd < 0) { ::close(fd); napi_value z; napi_create_uint32(env, 0, &z); return z; }
    uint32_t handle = 0;
    int r = drmSyncobjFDToHandle(drmFd, fd, &handle);
    ::close(fd);  // the kernel duped the underlying syncobj reference
    if (r != 0) {
        LOG_ERR(Core, "drmSyncobjFDToHandle failed errno={}", errno);
        napi_value z; napi_create_uint32(env, 0, &z); return z;
    }
    napi_value out; napi_create_uint32(env, handle, &out); return out;
}

// syncobjDestroy(handle) -> undefined. Releases a handle imported via
// syncobjImportTimeline. Caller (the timeline's destroy handler) ensures this
// is the matching destroy.
napi_value SyncobjDestroy(napi_env env, napi_callback_info info) {
    size_t argc = 1; napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t handle = 0;
    napi_get_value_uint32(env, argv[0], &handle);
    int drmFd = g_addon.syncobjFdValue;
    if (drmFd >= 0 && handle != 0) {
        drmSyncobjDestroy(drmFd, handle);
    }
    return nullptr;
}

// syncobjExportSyncFile(handle, pointHi, pointLo) -> WaylandFd | null.
// Materializes the fence at (handle, point) into a sync_file fd suitable for
// passing to the GPU process (Dawn's SharedFenceSyncFD). The DRM uAPI has no
// direct export-from-timeline ioctl, so the sequence is: create a fresh
// binary syncobj, drmSyncobjTransfer (handle, point) -> (binary, 0),
// drmSyncobjExportSyncFile on the binary, destroy the binary.
napi_value SyncobjExportSyncFile(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t handle = 0, hi = 0, lo = 0;
    napi_get_value_uint32(env, argv[0], &handle);
    napi_get_value_uint32(env, argv[1], &hi);
    napi_get_value_uint32(env, argv[2], &lo);
    int drmFd = syncobjFd();
    if (drmFd < 0 || handle == 0) { napi_value n; napi_get_null(env, &n); return n; }
    uint64_t point = (static_cast<uint64_t>(hi) << 32) | lo;

    uint32_t bin = 0;
    if (drmSyncobjCreate(drmFd, 0, &bin) != 0) {
        LOG_ERR(Core, "drmSyncobjCreate failed errno={}", errno);
        napi_value n; napi_get_null(env, &n); return n;
    }
    int syncFileFd = -1;
    if (drmSyncobjTransfer(drmFd, bin, 0, handle, point, 0) != 0) {
        LOG_ERR(Core, "drmSyncobjTransfer (export) failed errno={}", errno);
        drmSyncobjDestroy(drmFd, bin);
        napi_value n; napi_get_null(env, &n); return n;
    }
    if (drmSyncobjExportSyncFile(drmFd, bin, &syncFileFd) != 0) {
        LOG_ERR(Core, "drmSyncobjExportSyncFile failed errno={}", errno);
        drmSyncobjDestroy(drmFd, bin);
        napi_value n; napi_get_null(env, &n); return n;
    }
    drmSyncobjDestroy(drmFd, bin);
    return overdraw::wayland::makeWaylandFd(env, syncFileFd);
}

// syncobjTimelineSignal(handle, pointHi, pointLo) -> boolean.
// Signal the (handle, point) timeline point. Called from JS when the
// compositor's GPU sample submit completes (queue.onSubmittedWorkDone),
// so the client's release_point fires and the buffer can be re-used.
napi_value SyncobjTimelineSignal(napi_env env, napi_callback_info info) {
    size_t argc = 3; napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    uint32_t handle = 0, hi = 0, lo = 0;
    napi_get_value_uint32(env, argv[0], &handle);
    napi_get_value_uint32(env, argv[1], &hi);
    napi_get_value_uint32(env, argv[2], &lo);
    int drmFd = syncobjFd();
    if (drmFd < 0 || handle == 0) {
        napi_value f; napi_get_boolean(env, false, &f); return f;
    }
    uint64_t point = (static_cast<uint64_t>(hi) << 32) | lo;
    const bool ok = drmSyncobjTimelineSignal(drmFd, &handle, &point, 1) == 0;
    if (!ok) {
        LOG_ERR(Core, "drmSyncobjTimelineSignal failed errno={}", errno);
    }
    napi_value out; napi_get_boolean(env, ok, &out); return out;
}

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
    overdraw::log::installCrashHandler(overdraw::log::crashesDir(), "core");
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
    napi_value fnShmMapWritable;
    napi_create_function(env, "shmMapWritable", NAPI_AUTO_LENGTH,
                         ShmMapWritable, nullptr, &fnShmMapWritable);
    napi_set_named_property(env, exports, "shmMapWritable", fnShmMapWritable);
    napi_value fnCreateTexDmabuf;
    napi_create_function(env, "createTextureFromDmabuf", NAPI_AUTO_LENGTH,
                         CreateTextureFromDmabuf, nullptr, &fnCreateTexDmabuf);
    napi_set_named_property(env, exports, "createTextureFromDmabuf", fnCreateTexDmabuf);
    napi_value fnReleaseDmabuf;
    napi_create_function(env, "releaseDmabufImport", NAPI_AUTO_LENGTH,
                         ReleaseDmabufImport, nullptr, &fnReleaseDmabuf);
    napi_set_named_property(env, exports, "releaseDmabufImport", fnReleaseDmabuf);
    napi_value fnReserveShmTex;
    napi_create_function(env, "reserveShmTexture", NAPI_AUTO_LENGTH,
                         ReserveShmTexture, nullptr, &fnReserveShmTex);
    napi_set_named_property(env, exports, "reserveShmTexture", fnReserveShmTex);
    napi_value fnCommitShmUpload;
    napi_create_function(env, "commitShmUpload", NAPI_AUTO_LENGTH,
                         CommitShmUpload, nullptr, &fnCommitShmUpload);
    napi_set_named_property(env, exports, "commitShmUpload", fnCommitShmUpload);
    napi_value fnTakeShmAcks;
    napi_create_function(env, "takeShmUploadAcks", NAPI_AUTO_LENGTH,
                         TakeShmUploadAcks, nullptr, &fnTakeShmAcks);
    napi_set_named_property(env, exports, "takeShmUploadAcks", fnTakeShmAcks);
    napi_value fnWriteBeginAccess;
    napi_create_function(env, "writeBeginAccess", NAPI_AUTO_LENGTH,
                         WriteBeginAccess, nullptr, &fnWriteBeginAccess);
    napi_set_named_property(env, exports, "writeBeginAccess", fnWriteBeginAccess);
    napi_value fnWriteBeginAccessFence;
    napi_create_function(env, "writeBeginAccessWithFence", NAPI_AUTO_LENGTH,
                         WriteBeginAccessWithFence, nullptr, &fnWriteBeginAccessFence);
    napi_set_named_property(env, exports, "writeBeginAccessWithFence",
                            fnWriteBeginAccessFence);
    napi_value fnWriteEndAccess;
    napi_create_function(env, "writeEndAccess", NAPI_AUTO_LENGTH,
                         WriteEndAccess, nullptr, &fnWriteEndAccess);
    napi_set_named_property(env, exports, "writeEndAccess", fnWriteEndAccess);
    for (auto& [name, fn] : std::initializer_list<std::pair<const char*, napi_callback>>{
             {"acquireOutputTexture", AcquireOutputTexture},
             {"presentOutput", PresentOutput},
             {"gpuRenderNode", GpuRenderNode},
             {"outputFormat", OutputFormat}}) {
        napi_value f; napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f);
        napi_set_named_property(env, exports, name, f);
    }
    napi_create_function(env, "startServer", NAPI_AUTO_LENGTH, StartServer, nullptr, &fnStartServer);
    napi_create_function(env, "stopServer", NAPI_AUTO_LENGTH, StopServer, nullptr, &fnStopServer);
    napi_value fnRegister, fnCreateGlobal, fnCreateGlobalForOutput, fnPostEvent, fnRegisterIface;
    napi_create_function(env, "registerProtocols", NAPI_AUTO_LENGTH, RegisterProtocols, nullptr, &fnRegister);
    napi_create_function(env, "registerInterface", NAPI_AUTO_LENGTH, RegisterInterface, nullptr, &fnRegisterIface);
    napi_create_function(env, "createGlobal", NAPI_AUTO_LENGTH, CreateGlobal, nullptr, &fnCreateGlobal);
    napi_create_function(env, "createGlobalForOutput", NAPI_AUTO_LENGTH, CreateGlobalForOutput, nullptr, &fnCreateGlobalForOutput);
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
    reg("setPointerLocked", SetPointerLocked);
    reg("setPointerConfine", SetPointerConfine);
    reg("injectHostInput", InjectHostInput);
    reg("clientId", ClientId);
    reg("clientPid", ClientPid);
    reg("destroyResource", DestroyResource);
    reg("postError", PostError);
    reg("keymapInfo", KeymapInfo);
    reg("keyUpdate", KeyUpdate);
    reg("registerKeymap", RegisterKeymap);
    reg("unregisterKeymap", UnregisterKeymap);
    reg("setActiveKeymap", SetActiveKeymap);
    reg("setModifiers", SetModifiers);
    reg("switchVT", SwitchVT);
    reg("wake", Wake);
    reg("resolveCursorShape", ResolveCursorShape);
    reg("dmabufFeedbackInfo", DmabufFeedbackInfo);
    reg("syncobjImportTimeline", SyncobjImportTimeline);
    reg("syncobjDestroy", SyncobjDestroy);
    reg("syncobjExportSyncFile", SyncobjExportSyncFile);
    reg("syncobjTimelineSignal", SyncobjTimelineSignal);
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
    reg("setOnSeatEnabled", SetOnSeatEnabled);
    reg("setOnOutputDescriptor", SetOnOutputDescriptor);
    reg("setOnOutputAdded", SetOnOutputAdded);
    reg("setOnOutputRemoved", SetOnOutputRemoved);
    reg("setOnOutputModes", SetOnOutputModes);
    reg("setOnFlipComplete", SetOnFlipComplete);
    reg("setOnCursorPlaneStatus", SetOnCursorPlaneStatus);
    reg("sendCursorImage", SendCursorImage);
    reg("sendCursorImageShm", SendCursorImageShm);
    reg("sendCursorState", SendCursorState);
    reg("setOnScanoutClientFlip", SetOnScanoutClientFlip);
    reg("setOnScanoutClientReject", SetOnScanoutClientReject);
    reg("sendScanoutClientPresent", SendScanoutClientPresent);
    reg("scanoutFormatIndices", ScanoutFormatIndices);
    reg("reserveScanoutForOutput", ReserveScanoutForOutput);
    reg("releaseScanoutForOutput", ReleaseScanoutForOutput);
    reg("switchOutputMode", SwitchOutputMode);
    reg("destroyGlobalForOutput", DestroyGlobalForOutput);
    reg("updateOutputLayout", UpdateOutputLayout);
    reg("logInit", LogInit);
    reg("nativeLog", NativeLog);

    napi_set_named_property(env, exports, "start", fnStart);
    napi_set_named_property(env, exports, "stop", fnStop);
    napi_set_named_property(env, exports, "presentedCount", fnPresented);
    napi_set_named_property(env, exports, "startServer", fnStartServer);
    napi_set_named_property(env, exports, "stopServer", fnStopServer);
    napi_set_named_property(env, exports, "registerProtocols", fnRegister);
    napi_set_named_property(env, exports, "registerInterface", fnRegisterIface);
    napi_set_named_property(env, exports, "createGlobal", fnCreateGlobal);
    napi_set_named_property(env, exports, "createGlobalForOutput", fnCreateGlobalForOutput);
    napi_set_named_property(env, exports, "postEvent", fnPostEvent);

    overdraw::xwayland::RegisterXwayland(env, exports);
    overdraw::core::RegisterSpawn(env, exports);
    return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
