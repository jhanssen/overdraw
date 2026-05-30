#include "input_wayland.h"

#include "input_channel.h"

namespace overdraw::core {
namespace {

// wl_fixed_t is 24.8 signed fixed-point. Convert to a logical double.
inline double fixedToDouble(int32_t f) { return static_cast<double>(f) / 256.0; }

}  // namespace

void WaylandInputBackend::drain() {
    if (!sink_) return;
    ipc::InputMessage m{};
    while (ipc::recvInputNB(inputFd_, m)) {
        InputEvent ev{};
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
                // Phase 1: output logical size == host surface size (scale 1),
                // so surface-local position maps directly to output space. When
                // scale/resize lands, divide by scale / clamp to [0,width|height)
                // here using width_/height_.
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
                continue;  // unknown tag: skip
        }
        sink_->onInputEvent(ev);
    }
}

}  // namespace overdraw::core
