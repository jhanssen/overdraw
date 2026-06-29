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
#include <vector>

namespace overdraw::core {

// One output's rectangle in the global logical coordinate space. Used by
// the libinput backend to clamp accumulated pointer motion against a
// multi-output layout (non-rectangular unions slide along edges; see
// src/output/pointer-clamp.ts for the algorithm, mirrored byte-for-byte
// in input_libinput.cpp).
struct OutputRect {
    int32_t x;
    int32_t y;
    uint32_t w;
    uint32_t h;
};

enum class InputEventType : uint8_t {
    PointerEnter,
    PointerLeave,
    PointerMotion,
    PointerButton,
    PointerAxis,
    PointerAxisSource,
    PointerAxisStop,
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

    // Relative pointer motion for PointerMotion, in logical (output-space)
    // pixels. dx/dy are the accelerated delta the cursor actually moved by;
    // dxUnaccel/dyUnaccel are libinput's unaccelerated deltas. Both are 0 for a
    // backend with no relative source (the nested/host backend). Consumed by
    // zwp_relative_pointer_v1.
    double dx = 0.0;
    double dy = 0.0;
    double dxUnaccel = 0.0;
    double dyUnaccel = 0.0;

    // PointerButton: Linux input-event-codes button (BTN_LEFT=0x110, ...).
    uint32_t    button = 0;
    ButtonState buttonState = ButtonState::Released;

    // PointerAxis (scroll) / PointerAxisStop (which axis stopped uses `axis`).
    AxisKind axis         = AxisKind::VerticalScroll;
    double   axisValue    = 0.0;  // continuous scroll amount, logical units
    int32_t  axisDiscrete = 0;    // discrete step count (wheel clicks), 0 if none
    // PointerAxisSource: wl_pointer.axis_source enum (wheel/finger/continuous/
    // wheel_tilt).
    uint32_t axisSource   = 0;

    // KeyboardKey: RAW evdev keycode; state in buttonState.
    uint32_t key = 0;

    // KeyboardModifiers: masks forwarded for the seat/xkb layer to interpret.
    uint32_t modsDepressed = 0;
    uint32_t modsLatched   = 0;
    uint32_t modsLocked    = 0;
    uint32_t group         = 0;

    // KeyboardKey: which keymap to interpret this key under. 0 = the default
    // seat keymap (all real input); a non-zero id selects a virtual keyboard's
    // own keymap (zwp_virtual_keyboard_v1 with a client-supplied layout). The
    // seat makes this keymap active before feeding the key, so each keyboard's
    // keys resolve under its own layout and a real keystroke (id 0) restores
    // the default.
    uint32_t keymapId = 0;
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

    // Update the multi-output layout the backend uses for pointer-space
    // mapping or clamping. The libinput backend clamps the accumulated
    // pointer position to the union of these rects (with edge-sliding for
    // gaps in non-rectangular unions). The wayland backend currently
    // ignores layout (host forwards already-mapped coords); the override
    // is kept to satisfy the interface. Called whenever state.outputs
    // changes (add/remove/resize).
    virtual void setOutputLayout(const std::vector<OutputRect>& outputs) = 0;

    // Freeze/unfreeze the cursor accumulator for an active pointer lock
    // (zwp_locked_pointer_v1). While locked, the backend stops moving the
    // cursor but still reports relative deltas (so zwp_relative_pointer_v1
    // keeps firing). Default no-op (a backend with no cursor accumulator).
    virtual void setPointerLocked(bool /*locked*/) {}

    // Constrain the cursor to the union of these rects (global logical coords)
    // for an active zwp_confined_pointer_v1. Empty = no confinement (clamp to
    // the output union as usual). Default no-op.
    virtual void setPointerConfine(const std::vector<OutputRect>& /*rects*/) {}
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_INPUT_H_
