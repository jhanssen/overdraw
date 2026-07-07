#include "input_wayland.h"

#include "input_channel.h"

namespace overdraw::core {
namespace {

// wl_fixed_t is 24.8 signed fixed-point. Convert to a logical double.
inline double fixedToDouble(int32_t f) { return static_cast<double>(f) / 256.0; }

}  // namespace

// Convert a forwarded ipc::InputMessage to a normalized core InputEvent. Returns
// false for an unknown tag (caller skips). Shared by drain() (real socket path)
// and injectMessage() (test seam) so both go through the identical mapping --
// fixed-point -> logical, evdev codes, state/axis enums.
bool WaylandInputBackend::convert(const ipc::InputMessage& m, InputEvent& ev) const {
    ev = InputEvent{};
    ev.serial = m.serial;
    ev.time = m.time;
    switch (m.tag) {
        case ipc::InputTag::PointerEnter:
            ev.type = InputEventType::PointerEnter;
            ev.x = fixedToDouble(m.surfaceX);
            ev.y = fixedToDouble(m.surfaceY);
            break;
        case ipc::InputTag::PointerLeave:
            ev.type = InputEventType::PointerLeave;
            break;
        case ipc::InputTag::PointerMotion:
            ev.type = InputEventType::PointerMotion;
            // Output logical size == host surface size (scale 1), so
            // surface-local position maps directly to output space.
            ev.x = fixedToDouble(m.surfaceX);
            ev.y = fixedToDouble(m.surfaceY);
            break;
        case ipc::InputTag::PointerButton:
            ev.type = InputEventType::PointerButton;
            ev.button = m.button;
            ev.buttonState = m.state == static_cast<uint32_t>(ipc::KeyState::Pressed)
                                 ? ButtonState::Pressed
                                 : ButtonState::Released;
            break;
        case ipc::InputTag::PointerAxis:
            ev.type = InputEventType::PointerAxis;
            ev.axis = m.axis == static_cast<uint32_t>(ipc::PointerAxisKind::HorizontalScroll)
                          ? AxisKind::HorizontalScroll
                          : AxisKind::VerticalScroll;
            ev.axisValue = fixedToDouble(m.axisValue);
            ev.axisDiscrete = m.axisDiscrete;
            break;
        case ipc::InputTag::PointerFrame:
            ev.type = InputEventType::PointerFrame;
            break;
        case ipc::InputTag::KeyboardEnter:
            ev.type = InputEventType::KeyboardEnter;
            break;
        case ipc::InputTag::KeyboardLeave:
            ev.type = InputEventType::KeyboardLeave;
            break;
        case ipc::InputTag::KeyboardKey:
            ev.type = InputEventType::KeyboardKey;
            ev.key = m.key;
            ev.buttonState = m.state == static_cast<uint32_t>(ipc::KeyState::Pressed)
                                 ? ButtonState::Pressed
                                 : ButtonState::Released;
            break;
        case ipc::InputTag::KeyboardMods:
            ev.type = InputEventType::KeyboardModifiers;
            ev.modsDepressed = m.modsDepressed;
            ev.modsLatched = m.modsLatched;
            ev.modsLocked = m.modsLocked;
            ev.group = m.group;
            break;
        default:
            return false;  // unknown tag
    }
    return true;
}

void WaylandInputBackend::drain() {
    if (!sink_) return;
    ipc::InputMessage m{};
    while (ipc::recvInputNB(inputFd_, m)) {
        InputEvent ev{};
        if (convert(m, ev)) sink_->onInputEvent(ev);
    }
}

void WaylandInputBackend::injectMessage(const ipc::InputMessage& m) {
    if (!sink_) return;
    InputEvent ev{};
    if (convert(m, ev)) sink_->onInputEvent(ev);
}

}  // namespace overdraw::core
