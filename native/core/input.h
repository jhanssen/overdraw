// Core input abstraction (backend-agnostic).
//
// The compositor consumes a single stream of normalized input events regardless
// of where they originate. The thing that varies between phases is the *source*:
//
//   - Phase 1 (nested): host pointer/keyboard events arrive on the GPU process's
//     host Wayland connection and are forwarded to the core over the dedicated
//     input socket (ipc::InputMessage). The WaylandInputBackend reads that
//     socket, maps host-surface coordinates into output space, and emits
//     InputEvents.
//   - Phase 2 (bare metal): a LibinputBackend reads /dev/input/* (device fds via
//     libseat) and emits the SAME InputEvents.
//
// Everything above this seam -- cursor accumulation, surface hit-testing, focus
// policy, wl_seat emission to clients -- is written once against InputEvent and
// does not know which backend produced it.
//
// Normalization contract (what a backend guarantees before emitting):
//   - Pointer positions are in OUTPUT space (logical pixels, origin top-left),
//     already mapped from whatever the source used.
//   - Keyboard keycodes are RAW evdev codes (no XKB +8 offset applied; the seat
//     layer owns xkbcommon). Modifier masks are forwarded as-is for the seat
//     layer to interpret.
//   - Timestamps are milliseconds.

#ifndef OVERDRAW_CORE_INPUT_H_
#define OVERDRAW_CORE_INPUT_H_

#include <cstdint>

namespace overdraw::core {

enum class InputEventType : uint8_t {
    PointerEnter,
    PointerLeave,
    PointerMotion,
    PointerButton,
    PointerAxis,
    PointerFrame,
    KeyboardEnter,
    KeyboardLeave,
    KeyboardKey,
    KeyboardModifiers,
};

enum class ButtonState : uint8_t {
    Released = 0,
    Pressed  = 1,
};

enum class AxisKind : uint8_t {
    VerticalScroll   = 0,
    HorizontalScroll = 1,
};

// A normalized input event. POD; cheap to copy and to hand across the
// addon -> JS boundary. Fields not relevant to `type` are left zero/default.
struct InputEvent {
    InputEventType type;

    uint32_t serial = 0;  // source event serial (enter/button/key)
    uint32_t time   = 0;  // milliseconds

    // Pointer position in OUTPUT space (logical pixels), valid for
    // PointerEnter / PointerMotion. Doubles so sub-pixel motion survives the
    // fixed-point -> logical mapping.
    double x = 0.0;
    double y = 0.0;

    // PointerButton: Linux input-event-codes button (BTN_LEFT=0x110, ...).
    uint32_t    button = 0;
    ButtonState buttonState = ButtonState::Released;

    // PointerAxis (scroll).
    AxisKind axis         = AxisKind::VerticalScroll;
    double   axisValue    = 0.0;  // continuous scroll amount, logical units
    int32_t  axisDiscrete = 0;    // discrete step count (wheel clicks), 0 if none

    // KeyboardKey: RAW evdev keycode; state in buttonState.
    uint32_t key = 0;

    // KeyboardModifiers: masks forwarded for the seat/xkb layer to interpret.
    uint32_t modsDepressed = 0;
    uint32_t modsLatched   = 0;
    uint32_t modsLocked    = 0;
    uint32_t group         = 0;
};

// Consumer of normalized events. Implemented by the core's routing/seat layer
// (and by the addon bridge that forwards events to JS).
class InputSink {
  public:
    virtual ~InputSink() = default;
    virtual void onInputEvent(const InputEvent& ev) = 0;
};

// A source of normalized input events. One implementation per phase. The
// backend does not own the sink; the sink must outlive start()..stop().
//
// Lifecycle: construct -> start(sink) -> (events flow via sink) -> stop().
// Backends that read an fd integrate with the addon's libuv loop by exposing
// the fd (pollFd) and a drain entry point the poll handle calls when readable.
class InputBackend {
  public:
    virtual ~InputBackend() = default;

    // Begin emitting events to `sink`. Non-blocking.
    virtual void start(InputSink* sink) = 0;

    // Stop emitting; release source resources. Idempotent.
    virtual void stop() = 0;

    // The fd to register with libuv for readability, or -1 if the backend does
    // not poll an fd (e.g. a backend driven by an internal thread). The addon
    // adds a uv_poll on this fd and calls drain() when it signals readable.
    virtual int pollFd() const = 0;

    // Read all currently-available source input and emit normalized events to
    // the sink. Non-blocking. Called from the addon's poll handle on the Node
    // main thread (no cross-thread marshaling needed at this layer).
    virtual void drain() = 0;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_INPUT_H_
