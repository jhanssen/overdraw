// xkbcommon keymap -> memfd, for wl_keyboard.keymap.
//
// One Keymap is one keyboard's layout + live modifier state. The seat owns a
// default one (system XKB rules/model/layout, via init()) and one per virtual
// keyboard that supplies its own layout (via initFromFd()). Each serializes its
// compiled keymap to a sealed, read-only memfd the compositor sends to clients,
// which mmap it to interpret the raw evdev keycodes carried by wl_keyboard.key.
//
// Each Keymap also keeps its own xkb_state, so modifier state is per-keyboard:
// the seat reads modifiers from whichever keymap is currently active.

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

    // Build from a client-supplied keymap (XKB_KEYMAP_FORMAT_TEXT_V1 in `fd`,
    // `size` bytes including the trailing NUL, as delivered by
    // zwp_virtual_keyboard_v1.keymap). Takes ownership of `fd` (closes it).
    // Compiles it, re-serializes to this object's own sealed memfd, and starts
    // a fresh xkb state. Returns false on a bad fd / compile failure.
    bool initFromFd(int fd, uint32_t size);

    // wl_keyboard.keymap format (XKB_V1 = 1).
    uint32_t format() const { return 1; }
    uint32_t size() const { return size_; }

    // A fresh read-only dup of the keymap memfd (caller owns it). -1 on error.
    // Each client gets its own dup (clients mmap independently).
    int dupFd() const;

    // Feed a key state change (raw evdev keycode, pressed) to the xkb state, and
    // read back the current modifier masks for wl_keyboard.modifiers.
    void updateKey(uint32_t evdevKeycode, bool pressed);
    // Set the modifier + layout state directly from serialized masks (the form
    // wl_keyboard.modifiers / zwp_virtual_keyboard_v1.modifiers carry), rather
    // than deriving it from key presses. Used to honor a virtual keyboard's
    // explicit modifiers request so a subsequent key resolves under it.
    void updateMask(uint32_t depressed, uint32_t latched,
                    uint32_t locked, uint32_t group);
    void modifiers(uint32_t& depressed, uint32_t& latched,
                   uint32_t& locked, uint32_t& group) const;
    // Resolve a raw evdev keycode to its keysym under the CURRENT xkb state
    // (modifier + layout). Returns 0 (XKB_KEY_NoSymbol) if the keymap isn't
    // built or the key has no symbol bound. Shift-translated ('j' with Shift
    // held resolves to 'J'). Used for VT-switch detection, which keys off the
    // modifier-translated symbol.
    uint32_t keysym(uint32_t evdevKeycode) const;
    // The keycode's keysym at shift-level 0 in the effective layout, i.e.
    // independent of Shift / level modifiers ('j' stays 'j' with Shift held).
    // Binding matching uses this so a held Shift counts only as a modifier
    // bit, not as a different symbol. Returns 0 if unbuilt / no symbol.
    uint32_t baseKeysym(uint32_t evdevKeycode) const;

  private:
    // Serialize keymap_ to a sealed read-only memfd (sets memfd_ + size_).
    // Both init() and initFromFd() call this once the keymap is compiled.
    bool serializeToMemfd();

    ::xkb_context* ctx_ = nullptr;
    ::xkb_keymap* keymap_ = nullptr;
    ::xkb_state* state_ = nullptr;
    int memfd_ = -1;
    uint32_t size_ = 0;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_KEYMAP_H_
