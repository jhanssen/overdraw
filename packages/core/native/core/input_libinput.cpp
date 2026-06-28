#include "input_libinput.h"

#include <libinput.h>
#include <libudev.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <unistd.h>

#include "seat.h"

namespace overdraw::core {

namespace {

// Pointer clamp against a multi-output layout. Mirrors the algorithm in
// packages/core/src/output/pointer-clamp.ts (which is the canonical
// version + has unit tests). Keep them in sync.
//
// Outputs may form a non-rectangular union. The target (oldX+dx, oldY+dy)
// is projected to the closest point in the union by minimum squared
// distance across each rect's individual projection. The result lies
// strictly inside the half-open range of whichever rect won (by
// EDGE_EPSILON) so consecutive outward motion at a wall produces no
// event-to-event jitter -- the cursor sits just inside the boundary and
// stays there.

constexpr double EDGE_EPSILON = 1.0 / 256.0;

inline bool insideAny(const std::vector<OutputRect>& outs, double x, double y) {
    for (const auto& r : outs) {
        const double rxh = static_cast<double>(r.x) + static_cast<double>(r.w);
        const double ryh = static_cast<double>(r.y) + static_cast<double>(r.h);
        if (x >= r.x && x < rxh && y >= r.y && y < ryh) return true;
    }
    return false;
}

// Project (x, y) into the union of `outs` by closest squared distance.
// Each rect contributes its own clamped projection (each axis clamped to
// [r.x, r.x + r.w - EDGE_EPSILON] / [r.y, r.y + r.h - EDGE_EPSILON]); the
// rect with the smallest distance from (x, y) to its projection wins.
struct ClampPoint { double x; double y; };

ClampPoint closestPointInUnion(const std::vector<OutputRect>& outs,
                               double x, double y) {
    ClampPoint best{x, y};
    double bestDist = std::numeric_limits<double>::infinity();
    for (const auto& r : outs) {
        const double rx = static_cast<double>(r.x);
        const double ry = static_cast<double>(r.y);
        const double rxMax = rx + static_cast<double>(r.w) - EDGE_EPSILON;
        const double ryMax = ry + static_cast<double>(r.h) - EDGE_EPSILON;
        const double cx = x < rx ? rx : (x > rxMax ? rxMax : x);
        const double cy = y < ry ? ry : (y > ryMax ? ryMax : y);
        const double dx = x - cx;
        const double dy = y - cy;
        const double d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = {cx, cy}; }
    }
    return best;
}

}  // namespace


LibinputBackend::LibinputBackend(Seat& seat, std::string seatName,
                                 uint32_t width, uint32_t height)
    : seat_(seat), seatName_(std::move(seatName)) {
    // Initial layout: one rect at (0,0). The JS side replaces this with
    // the real per-output layout via setOutputLayout once state.outputs
    // has been built from descriptors.
    outputs_.push_back({0, 0, width, height});
    // Start cursor at the center of that rect. Arbitrary but visible.
    cursorX_ = width * 0.5;
    cursorY_ = height * 0.5;
}

LibinputBackend::~LibinputBackend() {
    if (li_) {
        libinput_unref(li_);
        li_ = nullptr;
    }
    if (udev_) {
        udev_unref(udev_);
        udev_ = nullptr;
    }
    // Close any fds libinput didn't close for us (libinput_unref triggers
    // close_restricted on each owned device, so devices_ should be empty at
    // this point; defensive cleanup for partial-init paths).
    for (auto& d : devices_) {
        ::close(d.fd);
        seat_.closeDevice(d.deviceId);
    }
    devices_.clear();
}

int LibinputBackend::openRestricted_(const char* path, int flags, void* userdata) {
    auto* self = static_cast<LibinputBackend*>(userdata);
    int fd = -1;
    int deviceId = -1;
    if (!self->seat_.openDevice(path, fd, deviceId)) {
        return -EACCES;
    }
    // libinput passes flags (O_RDWR | O_NONBLOCK); libseat already returns an
    // open RDWR fd. Apply O_NONBLOCK if requested.
    if (flags & O_NONBLOCK) {
        int cur = ::fcntl(fd, F_GETFL, 0);
        if (cur >= 0) ::fcntl(fd, F_SETFL, cur | O_NONBLOCK);
    }
    self->devices_.push_back({fd, deviceId});
    return fd;
}

void LibinputBackend::closeRestricted_(int fd, void* userdata) {
    auto* self = static_cast<LibinputBackend*>(userdata);
    auto it = std::find_if(self->devices_.begin(), self->devices_.end(),
                           [fd](const DevEntry& e) { return e.fd == fd; });
    if (it != self->devices_.end()) {
        self->seat_.closeDevice(it->deviceId);
        self->devices_.erase(it);
    }
    ::close(fd);
}

bool LibinputBackend::init() {
    static const struct libinput_interface kInterface = {
        .open_restricted  = &LibinputBackend::openRestricted_,
        .close_restricted = &LibinputBackend::closeRestricted_,
    };

    udev_ = udev_new();
    if (!udev_) {
        error_ = "udev_new failed";
        return false;
    }
    li_ = libinput_udev_create_context(&kInterface, this, udev_);
    if (!li_) {
        error_ = "libinput_udev_create_context failed";
        return false;
    }
    if (libinput_udev_assign_seat(li_, seatName_.c_str()) != 0) {
        error_ = std::string("libinput_udev_assign_seat(") + seatName_ + ") failed: " +
                 std::strerror(errno);
        return false;
    }
    return true;
}

int LibinputBackend::pollFd() const {
    return li_ ? libinput_get_fd(li_) : -1;
}

void LibinputBackend::drain() {
    if (!li_ || !sink_) return;
    if (libinput_dispatch(li_) != 0) {
        error_ = std::string("libinput_dispatch failed: ") + std::strerror(errno);
        return;
    }
    while (libinput_event* ev = libinput_get_event(li_)) {
        dispatchEvent(ev);
        libinput_event_destroy(ev);
    }
}

void LibinputBackend::suspend() {
    if (!li_) return;
    // libinput_suspend triggers close_restricted on every owned device. Our
    // trampoline calls Seat::closeDevice + ::close(fd) per device, draining
    // devices_ to empty. After this, no events flow until resume().
    libinput_suspend(li_);
}

void LibinputBackend::resume() {
    if (!li_) return;
    // Mirror of suspend. libinput walks its internal device list and calls
    // open_restricted on each via the seat -- libseat issues fresh fds.
    // Returns 0 on success, non-zero if at least one device failed to open;
    // we log but keep going (some devices may simply be unavailable now).
    if (libinput_resume(li_) != 0) {
        error_ = std::string("libinput_resume reported errors: ") +
                 std::strerror(errno);
    }
}

namespace {
inline ButtonState toButtonState(libinput_button_state s) {
    return s == LIBINPUT_BUTTON_STATE_PRESSED ? ButtonState::Pressed : ButtonState::Released;
}
inline ButtonState toKeyState(libinput_key_state s) {
    return s == LIBINPUT_KEY_STATE_PRESSED ? ButtonState::Pressed : ButtonState::Released;
}
}  // namespace

void LibinputBackend::dispatchEvent(libinput_event* ev) {
    const libinput_event_type type = libinput_event_get_type(ev);
    switch (type) {
        case LIBINPUT_EVENT_DEVICE_ADDED:
        case LIBINPUT_EVENT_DEVICE_REMOVED:
            // libinput hotplug; not surfaced upward in v1.
            break;
        case LIBINPUT_EVENT_POINTER_MOTION: {
            auto* pe = libinput_event_get_pointer_event(ev);
            const double dx = libinput_event_pointer_get_dx(pe);
            const double dy = libinput_event_pointer_get_dy(pe);
            const double dxu = libinput_event_pointer_get_dx_unaccelerated(pe);
            const double dyu = libinput_event_pointer_get_dy_unaccelerated(pe);
            // Clamp against the multi-output union by closest-point
            // projection. An empty layout leaves the cursor pinned (no
            // valid landing exists); this normally only happens transiently
            // during layout changes. While the pointer is locked the
            // accumulator is frozen (the cursor stays put); the deltas below
            // still flow so zwp_relative_pointer_v1 reports the motion.
            if (!pointerLocked_) {
                // Confined pointers clamp to the confine rects; otherwise to the
                // output union. Both via closest-point projection.
                const std::vector<OutputRect>& bounds =
                    confineRects_.empty() ? outputs_ : confineRects_;
                if (!bounds.empty()) {
                    const ClampPoint p = closestPointInUnion(bounds, cursorX_ + dx, cursorY_ + dy);
                    cursorX_ = p.x;
                    cursorY_ = p.y;
                }
            }

            InputEvent e{};
            e.type = InputEventType::PointerMotion;
            e.time = libinput_event_pointer_get_time(pe);
            e.x = cursorX_;
            e.y = cursorY_;
            e.dx = dx;
            e.dy = dy;
            e.dxUnaccel = dxu;
            e.dyUnaccel = dyu;
            sink_->onInputEvent(e);
            break;
        }
        case LIBINPUT_EVENT_POINTER_BUTTON: {
            auto* pe = libinput_event_get_pointer_event(ev);
            InputEvent e{};
            e.type = InputEventType::PointerButton;
            e.time = libinput_event_pointer_get_time(pe);
            e.button = libinput_event_pointer_get_button(pe);
            e.buttonState = toButtonState(libinput_event_pointer_get_button_state(pe));
            sink_->onInputEvent(e);

            // Frame event after each discrete pointer event so the seat layer
            // can group; wl_pointer.frame semantics expect it.
            InputEvent frame{};
            frame.type = InputEventType::PointerFrame;
            frame.time = e.time;
            sink_->onInputEvent(frame);
            break;
        }
        case LIBINPUT_EVENT_POINTER_AXIS: {
            // Legacy axis event. v1 uses the continuous value (logical units)
            // for both wheel and touchpad scroll; the v120 wheel-discrete API
            // is not used yet.
            auto* pe = libinput_event_get_pointer_event(ev);
            for (int axis = 0; axis < 2; ++axis) {
                const libinput_pointer_axis a =
                    axis == 0 ? LIBINPUT_POINTER_AXIS_SCROLL_VERTICAL
                              : LIBINPUT_POINTER_AXIS_SCROLL_HORIZONTAL;
                if (!libinput_event_pointer_has_axis(pe, a)) continue;
                const double v = libinput_event_pointer_get_axis_value(pe, a);
                InputEvent e{};
                e.type = InputEventType::PointerAxis;
                e.time = libinput_event_pointer_get_time(pe);
                e.axis = a == LIBINPUT_POINTER_AXIS_SCROLL_HORIZONTAL
                             ? AxisKind::HorizontalScroll
                             : AxisKind::VerticalScroll;
                e.axisValue = v;
                e.axisDiscrete = 0;  // v120 path not used in v1
                sink_->onInputEvent(e);
            }
            InputEvent frame{};
            frame.type = InputEventType::PointerFrame;
            frame.time = libinput_event_pointer_get_time(pe);
            sink_->onInputEvent(frame);
            break;
        }
        case LIBINPUT_EVENT_KEYBOARD_KEY: {
            auto* ke = libinput_event_get_keyboard_event(ev);
            InputEvent e{};
            e.type = InputEventType::KeyboardKey;
            e.time = libinput_event_keyboard_get_time(ke);
            e.key = libinput_event_keyboard_get_key(ke);
            e.buttonState = toKeyState(libinput_event_keyboard_get_key_state(ke));
            sink_->onInputEvent(e);
            // Modifier tracking is the seat/xkb layer's job; libinput does not
            // synthesize modifier events.
            break;
        }
        default:
            // Touch, gestures, switches, tablet — out of scope for v1.
            break;
    }
}

void LibinputBackend::setOutputLayout(const std::vector<OutputRect>& outputs) {
    outputs_ = outputs;
    // Maintain the cursor invariant: (cursorX_, cursorY_) inside some rect.
    // If the new layout stranded the cursor, reseat it into the first rect's
    // center. Empty layout leaves the cursor wherever it was (no valid
    // landing exists; the next motion will be a no-op until layout returns).
    if (outputs_.empty()) return;
    if (!insideAny(outputs_, cursorX_, cursorY_)) {
        const auto& r = outputs_.front();
        cursorX_ = static_cast<double>(r.x) + r.w / 2.0;
        cursorY_ = static_cast<double>(r.y) + r.h / 2.0;
    }
}

}  // namespace overdraw::core
