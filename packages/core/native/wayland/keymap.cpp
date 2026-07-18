#include "keymap.h"

#include <cstdlib>
#include <cstring>

#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <xkbcommon/xkbcommon.h>

#include "log/log.h"

namespace overdraw::wayland {

Keymap::~Keymap() {
    if (state_) xkb_state_unref(state_);
    if (keymap_) xkb_keymap_unref(keymap_);
    if (ctx_) xkb_context_unref(ctx_);
    if (memfd_ >= 0) ::close(memfd_);
}

bool Keymap::init() {
    ctx_ = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!ctx_) return false;

    // Default rules/model/layout/variant/options (RMLVO all-null => system
    // defaults, typically us/pc105). xkbcommon reads the env (XKB_DEFAULT_*).
    xkb_rule_names names{};
    keymap_ = xkb_keymap_new_from_names(ctx_, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap_) { LOG_ERR(Wayland, "[keymap] compile failed"); return false; }

    state_ = xkb_state_new(keymap_);
    if (!state_) return false;

    return serializeToMemfd();
}

bool Keymap::initFromFd(int fd, uint32_t size) {
    if (fd < 0 || size == 0) { if (fd >= 0) ::close(fd); return false; }

    ctx_ = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!ctx_) { ::close(fd); return false; }

    // The client wrote the keymap text (size bytes, including a trailing NUL)
    // to its own fd; map it read-only and compile. MAP_PRIVATE so a
    // non-sealed client fd can't surprise us mid-read.
    void* map = ::mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    ::close(fd);  // ownership taken; the mapping outlives the fd
    if (map == MAP_FAILED) { LOG_ERR(Wayland, "[keymap] client fd mmap failed"); return false; }

    keymap_ = xkb_keymap_new_from_buffer(ctx_, static_cast<const char*>(map), size,
                                         XKB_KEYMAP_FORMAT_TEXT_V1,
                                         XKB_KEYMAP_COMPILE_NO_FLAGS);
    ::munmap(map, size);
    if (!keymap_) { LOG_ERR(Wayland, "[keymap] client keymap compile failed"); return false; }

    state_ = xkb_state_new(keymap_);
    if (!state_) return false;

    return serializeToMemfd();
}

bool Keymap::serializeToMemfd() {
    char* str = xkb_keymap_get_as_string(keymap_, XKB_KEYMAP_FORMAT_TEXT_V1);
    if (!str) return false;
    size_t len = std::strlen(str) + 1;  // wl keymap size includes the NUL

    // Clients mmap it read-only; seal it so they can map shared safely (some
    // clients require F_SEAL_SHRINK).
    int fd = ::memfd_create("overdraw-keymap", MFD_CLOEXEC | MFD_ALLOW_SEALING);
    if (fd < 0) { std::free(str); return false; }
    if (::ftruncate(fd, static_cast<off_t>(len)) != 0) { std::free(str); ::close(fd); return false; }
    void* map = ::mmap(nullptr, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (map == MAP_FAILED) { std::free(str); ::close(fd); return false; }
    std::memcpy(map, str, len);
    ::munmap(map, len);
    std::free(str);
    ::fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK);

    memfd_ = fd;
    size_ = static_cast<uint32_t>(len);
    return true;
}

int Keymap::dupFd() const {
    if (memfd_ < 0) return -1;
    return ::fcntl(memfd_, F_DUPFD_CLOEXEC, 0);
}

void Keymap::updateKey(uint32_t evdevKeycode, bool pressed) {
    if (!state_) return;
    // xkb keycodes are evdev + 8 (the X11/XKB offset).
    xkb_state_update_key(state_, evdevKeycode + 8,
                         pressed ? XKB_KEY_DOWN : XKB_KEY_UP);
}

void Keymap::updateMask(uint32_t depressed, uint32_t latched,
                        uint32_t locked, uint32_t group) {
    if (!state_) return;
    xkb_state_update_mask(state_, depressed, latched, locked, 0, 0, group);
}

void Keymap::modifiers(uint32_t& depressed, uint32_t& latched,
                       uint32_t& locked, uint32_t& group) const {
    depressed = latched = locked = group = 0;
    if (!state_) return;
    depressed = xkb_state_serialize_mods(state_, XKB_STATE_MODS_DEPRESSED);
    latched = xkb_state_serialize_mods(state_, XKB_STATE_MODS_LATCHED);
    locked = xkb_state_serialize_mods(state_, XKB_STATE_MODS_LOCKED);
    group = xkb_state_serialize_layout(state_, XKB_STATE_LAYOUT_EFFECTIVE);
}

uint32_t Keymap::keysym(uint32_t evdevKeycode) const {
    if (!state_) return 0;
    // xkb keycodes are evdev + 8 (the X11/XKB offset).
    return xkb_state_key_get_one_sym(state_, evdevKeycode + 8);
}

uint32_t Keymap::baseKeysym(uint32_t evdevKeycode) const {
    if (!state_ || !keymap_) return 0;
    const xkb_keycode_t kc = evdevKeycode + 8;
    // Look up the keysym at the active layout's level 0 (no Shift / level
    // modifiers applied) so binding matching is invariant to Shift.
    const xkb_layout_index_t layout = xkb_state_key_get_layout(state_, kc);
    const xkb_keysym_t* syms = nullptr;
    const int n = xkb_keymap_key_get_syms_by_level(keymap_, kc, layout, 0, &syms);
    return n >= 1 ? static_cast<uint32_t>(syms[0]) : 0;
}

}  // namespace overdraw::wayland
