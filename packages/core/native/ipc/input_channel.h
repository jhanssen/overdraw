// Input side-channel protocol: GPU process -> core, one-way.
//
// Nested mode: host pointer/keyboard events arrive on the GPU process's host
// Wayland connection (the output wl_surface lives there) and are forwarded to
// the core over a dedicated SEQPACKET socket, separate from the control side
// channel so unsolicited input never collides with control request/reply
// traffic.
//
// v1 encoding: 1-byte tag + fixed-size POD payload (union-by-convention; each
// tag uses the subset of fields it needs), matching the side_channel.h style.
//
// This header is shared by both processes. It must not pull in Dawn or Wayland.
// Values forwarded here are RAW and minimally processed: pointer positions are
// host-surface-local fixed-point; keyboard codes are raw evdev keycodes as
// libwayland delivers them. Mapping to output space and keysym/modifier
// resolution (xkbcommon) happen core-side, above the backend.

#ifndef OVERDRAW_IPC_INPUT_CHANNEL_H_
#define OVERDRAW_IPC_INPUT_CHANNEL_H_

#include <cstdint>

#include <sys/socket.h>

namespace overdraw::ipc {

enum class InputTag : uint8_t {
    PointerEnter   = 'n',  // pointer entered the output surface
    PointerLeave   = 'l',  // pointer left the output surface
    PointerMotion  = 'm',  // motion within the surface (surface-local fixed)
    PointerButton  = 'b',  // button press/release
    PointerAxis    = 'a',  // scroll
    PointerFrame   = 'f',  // wl_pointer.frame: end of a coalesced event group
    KeyboardEnter  = 'N',  // keyboard focus entered (carries no keys here v1)
    KeyboardLeave  = 'L',  // keyboard focus left
    KeyboardKey    = 'k',  // key press/release (raw evdev keycode)
    KeyboardMods   = 'd',  // modifier/group latch state from the host
};

// Button/key state, matching Wayland's wl_pointer/wl_keyboard state enums
// (0 = released, 1 = pressed) so the host value forwards unchanged.
enum class KeyState : uint32_t {
    Released = 0,
    Pressed  = 1,
};

// Pointer axis identifier, matching wl_pointer.axis (0 = vertical scroll,
// 1 = horizontal scroll).
enum class PointerAxisKind : uint32_t {
    VerticalScroll   = 0,
    HorizontalScroll = 1,
};

// One forwarded host input event. Coordinates and codes are RAW (see header
// note). The receiving backend normalizes; nothing here is output-space yet.
struct InputMessage {
    InputTag tag;
    uint8_t _pad[3] = {0, 0, 0};

    uint32_t serial = 0;  // host event serial (enter/button/key)
    uint32_t time   = 0;  // host event timestamp, milliseconds (wl convention)

    // Pointer motion / enter: surface-local position as wl_fixed_t (24.8). Kept
    // as the raw fixed-point int so the core can map precisely; the core knows
    // the host surface size (HelloReply / resize) to convert to output space.
    int32_t surfaceX = 0;  // PointerEnter, PointerMotion: wl_fixed_t
    int32_t surfaceY = 0;  // PointerEnter, PointerMotion: wl_fixed_t

    // Pointer button: Linux input-event-codes button (BTN_LEFT=0x110, ...).
    uint32_t button = 0;   // PointerButton
    uint32_t state  = 0;   // PointerButton/KeyboardKey: KeyState

    // Pointer axis (scroll).
    uint32_t axis        = 0;  // PointerAxis: PointerAxisKind
    int32_t  axisValue   = 0;  // PointerAxis: wl_fixed_t continuous scroll amount
    int32_t  axisDiscrete = 0; // PointerAxis: discrete step count (wheel clicks)

    // Keyboard key: RAW evdev keycode as delivered by wl_keyboard.key. The XKB
    // wire offset (+8) is a keymap-layer concern handled in the core, not here.
    uint32_t key = 0;  // KeyboardKey

    // Keyboard modifiers: latched/locked/depressed modifier masks + effective
    // group, forwarded verbatim from wl_keyboard.modifiers. The core feeds these
    // to xkbcommon (or re-derives) when emitting wl_keyboard.modifiers to its
    // own clients.
    uint32_t modsDepressed = 0;  // KeyboardMods
    uint32_t modsLatched   = 0;  // KeyboardMods
    uint32_t modsLocked    = 0;  // KeyboardMods
    uint32_t group         = 0;  // KeyboardMods
};

constexpr uint32_t kInputProtocolVersion = 1;

// Send one input event over the SEQPACKET input socket. NON-BLOCKING: input is
// lossy by nature, and the sender (GPU process main loop) must never block on a
// full socket buffer -- doing so stops it pumping the host display, which stops
// it ponging xdg_wm_base pings, and the host marks the window unresponsive. If
// the buffer is full we drop the event. Returns false on drop / error.
inline bool sendInput(int fd, const InputMessage& msg) {
    return ::send(fd, &msg, sizeof(msg), MSG_DONTWAIT) == static_cast<ssize_t>(sizeof(msg));
}

// Non-blocking receive of one input event. Returns true if one was read. The
// core is the only receiver; it drains in a loop until this returns false.
inline bool recvInputNB(int fd, InputMessage& msg) {
    return ::recv(fd, &msg, sizeof(msg), MSG_DONTWAIT) == static_cast<ssize_t>(sizeof(msg));
}

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_INPUT_CHANNEL_H_
