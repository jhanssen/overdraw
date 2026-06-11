// XCursor theme resolver: name -> {rgba, hotspot, dims}.
//
// XDG-conventional theme discovery (XCURSOR_THEME, XCURSOR_SIZE, XCURSOR_PATH
// + the default $XDG_DATA_DIRS chain) with theme inheritance via index.theme
// [Icon Theme] Inherits=. Parses Xcursor binary files (file magic "Xcur") and
// returns the size >= requested px (or largest available). Picks subimage 0
// for files with multi-frame animations (animation not supported in v1).
//
// A built-in 16x16 arrow fallback is returned for 'default' (and only
// 'default') when no theme on disk contains it, so tests never depend on
// the host's installed themes.
//
// All filesystem walks are done on the calling thread; a separate LRU cache
// on the JS side avoids repeating them.

#ifndef OVERDRAW_CURSOR_XCURSOR_H_
#define OVERDRAW_CURSOR_XCURSOR_H_

#include <cstdint>
#include <string>
#include <vector>

namespace overdraw::cursor {

struct ResolvedShape {
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t hotspotX = 0;
    uint32_t hotspotY = 0;
    std::vector<uint8_t> rgba;  // tightly packed BGRA8 (matches compositor format)
};

// Returns true on success. On miss for any shape other than "default",
// returns false. For "default", always returns true (built-in fallback).
bool resolveShape(const std::string& name,
                  uint32_t sizePx,
                  uint32_t scale,
                  ResolvedShape& out);

// Drops any in-process caches (file-handle state). Call on theme change.
void reload();

}  // namespace overdraw::cursor

#endif  // OVERDRAW_CURSOR_XCURSOR_H_
