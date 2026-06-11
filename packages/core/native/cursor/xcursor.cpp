#include "xcursor.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

namespace overdraw::cursor {
namespace {

constexpr uint32_t XCURSOR_MAGIC = 0x72756358u;  // "Xcur" little-endian
constexpr uint32_t XCURSOR_IMAGE_TYPE = 0xfffd0002u;

// Read a little-endian uint32 from a stream. ifstream::read uses host endianness
// for the byte sequence; the file format is little-endian, so we read 4 bytes
// and assemble. (Works portably even on big-endian machines.)
bool readU32(std::ifstream& s, uint32_t& out) {
    uint8_t b[4];
    if (!s.read(reinterpret_cast<char*>(b), 4)) return false;
    out = uint32_t(b[0]) | (uint32_t(b[1]) << 8)
        | (uint32_t(b[2]) << 16) | (uint32_t(b[3]) << 24);
    return true;
}

// Split a colon-delimited path env var. Empty entries are dropped.
std::vector<std::string> splitColon(const char* s) {
    std::vector<std::string> out;
    if (!s || !*s) return out;
    std::string cur;
    for (const char* p = s; *p; ++p) {
        if (*p == ':') {
            if (!cur.empty()) out.push_back(cur);
            cur.clear();
        } else cur += *p;
    }
    if (!cur.empty()) out.push_back(cur);
    return out;
}

std::string expandHome(const std::string& p) {
    if (p.size() >= 2 && p[0] == '~' && p[1] == '/') {
        if (const char* home = std::getenv("HOME"); home && *home) {
            return std::string(home) + p.substr(1);
        }
    }
    return p;
}

bool fileExists(const std::string& path) {
    struct stat st;
    return ::stat(path.c_str(), &st) == 0 && S_ISREG(st.st_mode);
}

// XCURSOR_PATH if set; else XDG_DATA_HOME/icons : XDG_DATA_DIRS/icons :
// ~/.icons : /usr/share/icons : /usr/share/pixmaps. Per the XDG icon theme
// spec (cursor themes are a subset of icon themes).
std::vector<std::string> iconSearchPath() {
    if (const char* xp = std::getenv("XCURSOR_PATH"); xp && *xp) {
        return splitColon(xp);
    }
    std::vector<std::string> out;
    auto addIcons = [&](const std::string& base) {
        if (!base.empty()) out.push_back(base + "/icons");
    };
    if (const char* xdh = std::getenv("XDG_DATA_HOME"); xdh && *xdh) addIcons(xdh);
    else if (const char* home = std::getenv("HOME"); home && *home) {
        out.push_back(std::string(home) + "/.local/share/icons");
    }
    if (const char* xdd = std::getenv("XDG_DATA_DIRS"); xdd && *xdd) {
        for (auto& d : splitColon(xdd)) addIcons(d);
    } else {
        out.push_back("/usr/local/share/icons");
        out.push_back("/usr/share/icons");
    }
    if (const char* home = std::getenv("HOME"); home && *home) {
        out.push_back(std::string(home) + "/.icons");
    }
    out.push_back("/usr/share/pixmaps");
    return out;
}

// Read the theme's index.theme for an Inherits= line. Multiple themes may be
// listed comma-separated. Returns inherited names in order. The line may be
// under [Icon Theme] (the only section we care about).
std::vector<std::string> readInherits(const std::string& themeDir) {
    std::vector<std::string> out;
    std::ifstream f(themeDir + "/index.theme");
    if (!f) return out;
    std::string line;
    bool inIconTheme = false;
    while (std::getline(f, line)) {
        // Strip CR (DOS line endings) + leading whitespace.
        while (!line.empty() && (line.back() == '\r' || line.back() == ' '
                                 || line.back() == '\t')) line.pop_back();
        size_t a = 0;
        while (a < line.size() && (line[a] == ' ' || line[a] == '\t')) ++a;
        line.erase(0, a);
        if (line.empty() || line[0] == '#') continue;
        if (line[0] == '[') {
            inIconTheme = (line == "[Icon Theme]");
            continue;
        }
        if (!inIconTheme) continue;
        if (line.rfind("Inherits=", 0) == 0) {
            std::string v = line.substr(9);
            std::string cur;
            for (char c : v) {
                if (c == ',' || c == ';') {
                    if (!cur.empty()) out.push_back(cur);
                    cur.clear();
                } else if (c != ' ' && c != '\t') cur += c;
            }
            if (!cur.empty()) out.push_back(cur);
            break;
        }
    }
    return out;
}

// For theme `theme` look up `<path>/<theme>/cursors/<shape>` in any of the
// search paths. Returns the first file that exists; empty string on miss.
std::string findShapeFile(const std::vector<std::string>& paths,
                          const std::string& theme,
                          const std::string& shape) {
    for (const auto& p : paths) {
        std::string candidate = p + "/" + theme + "/cursors/" + shape;
        if (fileExists(candidate)) return candidate;
    }
    return "";
}

// Walk the theme inheritance graph. For each theme encountered (BFS, the
// primary first), checks for the shape file. cycle-guarded with a visited
// set; depth-capped at 16.
std::string resolveShapeFileWithInheritance(
    const std::vector<std::string>& paths,
    const std::string& primaryTheme,
    const std::string& shape)
{
    std::vector<std::string> queue{primaryTheme};
    std::vector<std::string> visited;
    int depth = 0;
    while (!queue.empty() && depth < 16) {
        std::string theme = queue.front();
        queue.erase(queue.begin());
        if (std::find(visited.begin(), visited.end(), theme) != visited.end()) continue;
        visited.push_back(theme);
        ++depth;

        std::string file = findShapeFile(paths, theme, shape);
        if (!file.empty()) return file;

        // Look up inherited themes from any path where this theme lives.
        for (const auto& p : paths) {
            std::string themeDir = p + "/" + theme;
            struct stat st;
            if (::stat(themeDir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) continue;
            for (auto& inh : readInherits(themeDir)) {
                if (std::find(visited.begin(), visited.end(), inh) == visited.end()) {
                    queue.push_back(inh);
                }
            }
        }
    }
    return "";
}

// Pick the image entry from a parsed image list whose nominal_size >= sizePx,
// or the largest available if all are smaller. nominal_size is the file's
// declared "designed at this size" hint (the TOC subtype).
struct ImageEntry {
    uint32_t nominalSize = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t hotspotX = 0;
    uint32_t hotspotY = 0;
    uint32_t delayMs = 0;
    uint32_t pixelsOffset = 0;
    uint32_t subimage = 0;  // 0 = first frame
};

bool parseXcursorFile(const std::string& path,
                      uint32_t sizePx,
                      ResolvedShape& out)
{
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;

    uint32_t magic, headerLen, version, ntoc;
    if (!readU32(f, magic) || magic != XCURSOR_MAGIC) return false;
    if (!readU32(f, headerLen)) return false;
    if (!readU32(f, version)) return false;
    if (!readU32(f, ntoc)) return false;
    // Skip remaining bytes of the file header (headerLen is total bytes incl.
    // the 4 fields just read, each 4 bytes = 16). Compute and seek if anything
    // extra exists.
    if (headerLen > 16) f.seekg(headerLen - 16, std::ios::cur);

    // Read TOC: ntoc entries of {type, subtype, position}.
    std::vector<ImageEntry> images;
    images.reserve(ntoc);
    for (uint32_t i = 0; i < ntoc; ++i) {
        uint32_t type, subtype, position;
        if (!readU32(f, type) || !readU32(f, subtype) || !readU32(f, position)) return false;
        if (type != XCURSOR_IMAGE_TYPE) continue;
        ImageEntry e;
        e.nominalSize = subtype;
        e.pixelsOffset = position;
        images.push_back(e);
    }
    if (images.empty()) return false;

    // Read each image chunk's header. Layout (per chunk):
    //   header(u32), type(u32, must=image), subtype(u32, nominal_size),
    //   version(u32), width(u32), height(u32), xhot(u32), yhot(u32),
    //   delay(u32), then width*height ARGB pixels (each u32).
    for (auto& e : images) {
        f.seekg(e.pixelsOffset, std::ios::beg);
        uint32_t chunkHdrLen, chunkType, chunkSubtype, chunkVer;
        if (!readU32(f, chunkHdrLen) || !readU32(f, chunkType)
            || !readU32(f, chunkSubtype) || !readU32(f, chunkVer)) return false;
        if (chunkType != XCURSOR_IMAGE_TYPE) return false;
        if (!readU32(f, e.width) || !readU32(f, e.height)
            || !readU32(f, e.hotspotX) || !readU32(f, e.hotspotY)
            || !readU32(f, e.delayMs)) return false;
        // The image chunk header may be longer than 36 bytes in future
        // versions; seek to pixelsOffset + chunkHdrLen for the pixels.
        e.pixelsOffset = e.pixelsOffset + chunkHdrLen;
    }

    // Group by nominal size; first subimage of each group is frame 0.
    // We don't have explicit subimage IDs in the TOC, but the spec says
    // images of the same nominal size appearing in TOC order are frames
    // 0, 1, 2, ... — so the first occurrence of any given nominal_size is
    // frame 0 for that size.
    std::vector<uint32_t> seenSizes;
    std::vector<ImageEntry> frameZero;
    for (auto& e : images) {
        if (std::find(seenSizes.begin(), seenSizes.end(), e.nominalSize) != seenSizes.end()) {
            continue;
        }
        seenSizes.push_back(e.nominalSize);
        frameZero.push_back(e);
    }

    // Pick the size: smallest one with nominalSize >= sizePx, else largest.
    const ImageEntry* pick = nullptr;
    for (auto& e : frameZero) {
        if (e.nominalSize >= sizePx) {
            if (!pick || e.nominalSize < pick->nominalSize) pick = &e;
        }
    }
    if (!pick) {
        for (auto& e : frameZero) {
            if (!pick || e.nominalSize > pick->nominalSize) pick = &e;
        }
    }
    if (!pick) return false;

    // Read the pixels: width*height ARGB uint32, little-endian. On LE host
    // the bytes land as B,G,R,A (matching BGRA8 the compositor wants).
    // Documented portability caveat: on a BE host we'd need to byte-swap.
    // Verification env is LE (x86_64) per status.md; flag if we ever care.
    const size_t pxCount = size_t(pick->width) * size_t(pick->height);
    const size_t byteCount = pxCount * 4;
    out.width = pick->width;
    out.height = pick->height;
    out.hotspotX = pick->hotspotX;
    out.hotspotY = pick->hotspotY;
    out.rgba.resize(byteCount);
    f.seekg(pick->pixelsOffset, std::ios::beg);
    if (!f.read(reinterpret_cast<char*>(out.rgba.data()), byteCount)) return false;

    // XCursor pixels are PREMULTIPLIED alpha per the spec. The compositor's
    // blend path expects premultiplied; pass-through.
    return true;
}

// 16x16 fallback arrow (BGRA8, premultiplied). Drawn as a simple solid arrow.
// Used only for shape "default" when no theme has it; ensures tests run
// without depending on the host's installed themes.
void buildFallbackArrow(ResolvedShape& out) {
    constexpr uint32_t W = 16, H = 16;
    out.width = W;
    out.height = H;
    out.hotspotX = 0;
    out.hotspotY = 0;
    out.rgba.assign(W * H * 4, 0);
    // A simple triangular arrow with a black outline + white fill in the
    // top-left region. Row N has pixels [0..N] filled. The body is filled
    // white, with a 1px black border on the right and bottom edges.
    auto setPx = [&](uint32_t x, uint32_t y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
        size_t i = (y * W + x) * 4;
        out.rgba[i + 0] = b;
        out.rgba[i + 1] = g;
        out.rgba[i + 2] = r;
        out.rgba[i + 3] = a;
    };
    for (uint32_t y = 0; y < 12; ++y) {
        for (uint32_t x = 0; x <= y && x < W; ++x) {
            // Border (right edge of arrow, last column of this row): black.
            // Last row of the arrow body: black.
            if (x == y || y == 11) setPx(x, y, 0, 0, 0, 255);
            else setPx(x, y, 255, 255, 255, 255);
        }
    }
}

}  // namespace

bool resolveShape(const std::string& name,
                  uint32_t sizePx,
                  uint32_t scale,
                  ResolvedShape& out) {
    const uint32_t effSize = std::max<uint32_t>(1, sizePx * std::max<uint32_t>(1, scale));

    const char* themeEnv = std::getenv("XCURSOR_THEME");
    std::string theme = (themeEnv && *themeEnv) ? themeEnv : "default";
    auto paths = iconSearchPath();

    std::string file = resolveShapeFileWithInheritance(paths, theme, name);
    if (!file.empty()) {
        if (parseXcursorFile(file, effSize, out)) return true;
    }
    // Theme miss: built-in fallback for 'default' only.
    if (name == "default") {
        buildFallbackArrow(out);
        return true;
    }
    return false;
}

void reload() {
    // No in-process state to flush yet (filesystem walks are stateless;
    // the JS-side LRU is what holds parsed results). Hook is here so
    // a future config-driven theme reload has a place to clear native
    // caches without touching the JS layer.
}

}  // namespace overdraw::cursor
