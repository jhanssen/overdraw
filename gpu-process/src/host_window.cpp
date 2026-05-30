#include "host_window.h"

#include <cstring>

#include <poll.h>
#include <unistd.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#include "input_channel.h"
#include "transport.h"

namespace overdraw::gpu {
namespace {

void wmPing(void*, xdg_wm_base* b, uint32_t serial) { xdg_wm_base_pong(b, serial); }
const xdg_wm_base_listener kWmListener = {wmPing};

// ---- Pointer listener ----------------------------------------------------

void ptrEnter(void* data, wl_pointer*, uint32_t serial, wl_surface* s,
              wl_fixed_t sx, wl_fixed_t sy) {
    static_cast<HostWindow*>(data)->sendPointerEnter(serial, s, sx, sy);
}
void ptrLeave(void* data, wl_pointer*, uint32_t serial, wl_surface* s) {
    static_cast<HostWindow*>(data)->sendPointerLeave(serial, s);
}
void ptrMotion(void* data, wl_pointer*, uint32_t time, wl_fixed_t sx, wl_fixed_t sy) {
    static_cast<HostWindow*>(data)->sendPointerMotion(time, sx, sy);
}
void ptrButton(void* data, wl_pointer*, uint32_t serial, uint32_t time,
               uint32_t button, uint32_t state) {
    static_cast<HostWindow*>(data)->sendPointerButton(serial, time, button, state);
}
void ptrAxis(void* data, wl_pointer*, uint32_t time, uint32_t axis, wl_fixed_t value) {
    static_cast<HostWindow*>(data)->sendPointerAxis(time, axis, value, 0);
}
void ptrFrame(void* data, wl_pointer*) {
    static_cast<HostWindow*>(data)->sendPointerFrame();
}
void ptrAxisSource(void*, wl_pointer*, uint32_t) {}
void ptrAxisStop(void*, wl_pointer*, uint32_t, uint32_t) {}
void ptrAxisDiscrete(void* data, wl_pointer*, uint32_t axis, int32_t discrete) {
    // Discrete steps arrive separately from the continuous value in v5; forward
    // as a discrete-only axis event. The continuous ptrAxis already fired.
    static_cast<HostWindow*>(data)->sendPointerAxis(0, axis, 0, discrete);
}
const wl_pointer_listener kPtrListener = {
    ptrEnter, ptrLeave, ptrMotion, ptrButton, ptrAxis,
    ptrFrame, ptrAxisSource, ptrAxisStop, ptrAxisDiscrete,
    // v8 axis_value120 / axis_relative_direction left null.
    nullptr, nullptr,
};

// ---- Keyboard listener ---------------------------------------------------

void kbKeymap(void*, wl_keyboard*, uint32_t, int32_t fd, uint32_t) {
    // The host keymap is the host's; the core builds its own keymap for its
    // clients. Close the fd to avoid leaking it.
    if (fd >= 0) ::close(fd);
}
void kbEnter(void* data, wl_keyboard*, uint32_t serial, wl_surface* s, wl_array*) {
    static_cast<HostWindow*>(data)->sendKeyboardEnter(serial, s);
}
void kbLeave(void* data, wl_keyboard*, uint32_t serial, wl_surface* s) {
    static_cast<HostWindow*>(data)->sendKeyboardLeave(serial, s);
}
void kbKey(void* data, wl_keyboard*, uint32_t serial, uint32_t time,
           uint32_t key, uint32_t state) {
    static_cast<HostWindow*>(data)->sendKeyboardKey(serial, time, key, state);
}
void kbMods(void* data, wl_keyboard*, uint32_t serial, uint32_t depressed,
            uint32_t latched, uint32_t locked, uint32_t group) {
    static_cast<HostWindow*>(data)->sendKeyboardMods(serial, depressed, latched, locked, group);
}
void kbRepeat(void*, wl_keyboard*, int32_t, int32_t) {}
const wl_keyboard_listener kKbListener = {
    kbKeymap, kbEnter, kbLeave, kbKey, kbMods, kbRepeat,
};

// ---- Seat listener -------------------------------------------------------

void seatCaps(void* data, wl_seat*, uint32_t caps) {
    static_cast<HostWindow*>(data)->onSeatCapabilities(caps);
}
void seatName(void*, wl_seat*, const char*) {}
const wl_seat_listener kSeatListener = {seatCaps, seatName};

void regGlobal(void* data, wl_registry* reg, uint32_t name,
               const char* iface, uint32_t version) {
    auto* w = static_cast<HostWindow*>(data);
    if (!std::strcmp(iface, wl_compositor_interface.name)) {
        w->bindCompositor(static_cast<wl_compositor*>(
            wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4)));
    } else if (!std::strcmp(iface, xdg_wm_base_interface.name)) {
        auto* b = static_cast<xdg_wm_base*>(
            wl_registry_bind(reg, name, &xdg_wm_base_interface, 1));
        xdg_wm_base_add_listener(b, &kWmListener, nullptr);
        w->bindWmBase(b);
    } else if (!std::strcmp(iface, wl_seat_interface.name)) {
        // Bind up to v5 (frame/axis-discrete events). Capabilities arrive async.
        w->bindSeat(static_cast<wl_seat*>(
            wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5)));
    }
}
void regRemove(void*, wl_registry*, uint32_t) {}
const wl_registry_listener kRegListener = {regGlobal, regRemove};

void xdgSurfConfigure(void* data, xdg_surface* xs, uint32_t serial) {
    xdg_surface_ack_configure(xs, serial);
    static_cast<HostWindow*>(data)->onConfigured();
}
const xdg_surface_listener kXdgSurfListener = {xdgSurfConfigure};

void tlConfigure(void* data, xdg_toplevel*, int32_t w, int32_t h, wl_array*) {
    static_cast<HostWindow*>(data)->onSize(static_cast<uint32_t>(w), static_cast<uint32_t>(h));
}
void tlClose(void* data, xdg_toplevel*) { static_cast<HostWindow*>(data)->onClose(); }
const xdg_toplevel_listener kTlListener = {tlConfigure, tlClose, nullptr, nullptr};

}  // namespace

HostWindow::~HostWindow() {
    if (toplevel_) xdg_toplevel_destroy(toplevel_);
    if (xdgSurface_) xdg_surface_destroy(xdgSurface_);
    if (surface_) wl_surface_destroy(surface_);
    if (display_) wl_display_disconnect(display_);
}

bool HostWindow::open(const char* title) {
    display_ = wl_display_connect(nullptr);
    if (!display_) return false;

    wl_registry* reg = wl_display_get_registry(display_);
    wl_registry_add_listener(reg, &kRegListener, this);
    wl_display_roundtrip(display_);
    if (!compositor_ || !wmBase_) return false;

    surface_ = wl_compositor_create_surface(compositor_);
    xdgSurface_ = xdg_wm_base_get_xdg_surface(wmBase_, surface_);
    xdg_surface_add_listener(xdgSurface_, &kXdgSurfListener, this);
    toplevel_ = xdg_surface_get_toplevel(xdgSurface_);
    xdg_toplevel_add_listener(toplevel_, &kTlListener, this);
    xdg_toplevel_set_title(toplevel_, title);
    xdg_toplevel_set_app_id(toplevel_, "overdraw");
    wl_surface_commit(surface_);

    while (!configured_ && wl_display_dispatch(display_) != -1) {}
    // A second roundtrip so the wl_seat.capabilities event (bound during the
    // first roundtrip) is processed and pointer/keyboard are created before
    // steady state. Without this, capabilities can arrive only later and the
    // seat objects may never be set up.
    wl_display_roundtrip(display_);
    return configured_;
}

void HostWindow::pump() {
    // The prior implementation used only wl_display_dispatch_pending, which
    // drains the in-memory queue but never READS the socket -- so input events
    // (and the seat capabilities event) sat unread on the fd and were never
    // delivered. We must read the socket, but without blocking the GPU loop:
    // use prepare_read + a non-blocking poll on the wl fd + read_events.
    while (wl_display_prepare_read(display_) != 0)
        wl_display_dispatch_pending(display_);  // drain queued events first
    wl_display_flush(display_);

    // Only read if the fd has bytes; read_events() otherwise blocks until data.
    pollfd pfd{wl_display_get_fd(display_), POLLIN, 0};
    if (::poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLIN)) {
        wl_display_read_events(display_);
        wl_display_dispatch_pending(display_);
    } else {
        wl_display_cancel_read(display_);
    }
}

void HostWindow::bindSeat(wl_seat* s) {
    seat_ = s;
    wl_seat_add_listener(seat_, &kSeatListener, this);
}

void HostWindow::onSeatCapabilities(uint32_t caps) {
    const bool hasPointer = caps & WL_SEAT_CAPABILITY_POINTER;
    const bool hasKeyboard = caps & WL_SEAT_CAPABILITY_KEYBOARD;

    if (hasPointer && !pointer_) {
        pointer_ = wl_seat_get_pointer(seat_);
        wl_pointer_add_listener(pointer_, &kPtrListener, this);
    } else if (!hasPointer && pointer_) {
        wl_pointer_release(pointer_);
        pointer_ = nullptr;
    }

    if (hasKeyboard && !keyboard_) {
        keyboard_ = wl_seat_get_keyboard(seat_);
        wl_keyboard_add_listener(keyboard_, &kKbListener, this);
    } else if (!hasKeyboard && keyboard_) {
        wl_keyboard_release(keyboard_);
        keyboard_ = nullptr;
    }
}

// ---- Input forwarding helpers --------------------------------------------
//
// Each builds an ipc::InputMessage and writes it to inputFd_ (SEQPACKET). The
// core's WaylandInputBackend maps surface-local fixed-point to output space and
// resolves keysyms; here we only forward raw values. Events targeting a surface
// other than our output surface are dropped (a nested compositor has exactly
// one host surface, so this is normally always our surface).

void HostWindow::sendPointerEnter(uint32_t serial, wl_surface* s, int32_t sx, int32_t sy) {
    if (inputFd_ < 0 || s != surface_) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::PointerEnter;
    m.serial = serial;
    m.surfaceX = sx;
    m.surfaceY = sy;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendPointerLeave(uint32_t serial, wl_surface* s) {
    if (inputFd_ < 0 || s != surface_) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::PointerLeave;
    m.serial = serial;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendPointerMotion(uint32_t time, int32_t sx, int32_t sy) {
    if (inputFd_ < 0) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::PointerMotion;
    m.time = time;
    m.surfaceX = sx;
    m.surfaceY = sy;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendPointerButton(uint32_t serial, uint32_t time, uint32_t button,
                                   uint32_t state) {
    if (inputFd_ < 0) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::PointerButton;
    m.serial = serial;
    m.time = time;
    m.button = button;
    m.state = state;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendPointerAxis(uint32_t time, uint32_t axis, int32_t value,
                                 int32_t discrete) {
    if (inputFd_ < 0) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::PointerAxis;
    m.time = time;
    m.axis = axis;
    m.axisValue = value;
    m.axisDiscrete = discrete;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendPointerFrame() {
    if (inputFd_ < 0) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::PointerFrame;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendKeyboardEnter(uint32_t serial, wl_surface* s) {
    if (inputFd_ < 0 || s != surface_) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::KeyboardEnter;
    m.serial = serial;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendKeyboardLeave(uint32_t serial, wl_surface* s) {
    if (inputFd_ < 0 || s != surface_) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::KeyboardLeave;
    m.serial = serial;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendKeyboardKey(uint32_t serial, uint32_t time, uint32_t key,
                                 uint32_t state) {
    if (inputFd_ < 0) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::KeyboardKey;
    m.serial = serial;
    m.time = time;
    m.key = key;
    m.state = state;
    ipc::sendInput(inputFd_, m);
}

void HostWindow::sendKeyboardMods(uint32_t serial, uint32_t depressed, uint32_t latched,
                                  uint32_t locked, uint32_t group) {
    if (inputFd_ < 0) return;
    ipc::InputMessage m{};
    m.tag = ipc::InputTag::KeyboardMods;
    m.serial = serial;
    m.modsDepressed = depressed;
    m.modsLatched = latched;
    m.modsLocked = locked;
    m.group = group;
    ipc::sendInput(inputFd_, m);
}

}  // namespace overdraw::gpu
