#include "log/paths.h"

#include <cerrno>
#include <cstdlib>
#include <sys/stat.h>

namespace overdraw::log {

namespace {

// mkdir -p for exactly two levels of possible absence: parents of the state
// root are expected to exist (~/.local/state is created by systemd/logind on
// modern systems, but create it too just in case).
bool ensureDir(const std::string& path) {
    if (path.empty()) return false;
    std::string partial;
    partial.reserve(path.size());
    for (size_t i = 1; i <= path.size(); ++i) {
        if (i == path.size() || path[i] == '/') {
            partial = path.substr(0, i);
            if (::mkdir(partial.c_str(), 0755) != 0 && errno != EEXIST) return false;
        }
    }
    return true;
}

}  // namespace

std::string stateDir() {
    if (const char* o = std::getenv("OVERDRAW_STATE_DIR"); o && *o) return o;
    if (const char* x = std::getenv("XDG_STATE_HOME"); x && *x)
        return std::string(x) + "/overdraw";
    if (const char* h = std::getenv("HOME"); h && *h)
        return std::string(h) + "/.local/state/overdraw";
    return {};
}

std::string logsDir() {
    std::string d = stateDir();
    if (d.empty()) return {};
    d += "/logs";
    if (!ensureDir(d)) return {};
    return d;
}

std::string crashesDir() {
    std::string d = stateDir();
    if (d.empty()) return {};
    d += "/crashes";
    if (!ensureDir(d)) return {};
    return d;
}

}  // namespace overdraw::log
