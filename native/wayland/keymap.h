// xkbcommon keymap -> memfd, for wl_keyboard.keymap.
//
// Builds a default keymap once (system XKB rules/model/layout) and serializes it
// to a sealed, read-only memfd the compositor sends to clients. Clients mmap it
// to interpret the raw evdev keycodes carried by wl_keyboard.key.
//
// Also resolves xkb modifier state from depressed evdev keycodes, so the
// compositor can emit correct wl_keyboard.modifiers.

#ifndef OVERDRAW_WAYLAND_KEYMAP_H_
#define OVERDRAW_WAYLAND_KEYMAP_H_

#include <cstdint>

// xkbcommon C types, forward-declared at global scope (they are not in any
// namespace; declaring them inside overdraw::wayland would create distinct,
// incomplete namespaced types).
struct xkb_context;
struct xkb_keymap;
struct xkb_state;

namespace overdraw::wayland {

class Keymap {
  public:
    Keymap() = default;
    ~Keymap();

    Keymap(const Keymap&) = delete;
    Keymap& operator=(const Keymap&) = delete;

    // Build the default keymap + xkb state. Returns false on failure.
    bool init();

    // wl_keyboard.keymap format (XKB_V1 = 1).
    uint32_t format() const { return 1; }
    uint32_t size() const { return size_; }

    // A fresh read-only dup of the keymap memfd (caller owns it). -1 on error.
    // Each client gets its own dup (clients mmap independently).
    int dupFd() const;

    // Feed a key state change (raw evdev keycode, pressed) to the xkb state, and
    // read back the current modifier masks for wl_keyboard.modifiers.
    void updateKey(uint32_t evdevKeycode, bool pressed);
    void modifiers(uint32_t& depressed, uint32_t& latched,
                   uint32_t& locked, uint32_t& group) const;

  private:
    ::xkb_context* ctx_ = nullptr;
    ::xkb_keymap* keymap_ = nullptr;
    ::xkb_state* state_ = nullptr;
    int memfd_ = -1;
    uint32_t size_ = 0;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_KEYMAP_H_
