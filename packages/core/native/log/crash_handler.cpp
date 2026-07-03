#include "crash_handler.h"

#include <csignal>
#include <cstdio>

#include <execinfo.h>
#include <fcntl.h>
#include <unistd.h>

namespace overdraw::log {

namespace {

const char* g_crashPath = nullptr;
const char* g_crashLabel = nullptr;

// Async-signal-safe-ish: backtrace/backtrace_symbols_fd are commonly used
// here; the process is dying anyway.
void crashHandler(int sig) {
    int fd = ::open(g_crashPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) {
        char hdr[96];
        int n = std::snprintf(hdr, sizeof(hdr), "%s caught signal %d\n",
                              g_crashLabel, sig);
        ssize_t w = ::write(fd, hdr, static_cast<size_t>(n));
        (void)w;
        void* frames[64];
        int got = ::backtrace(frames, 64);
        ::backtrace_symbols_fd(frames, got, fd);
        ::close(fd);
    }
    ::signal(sig, SIG_DFL);
    ::raise(sig);
}

}  // namespace

void installCrashHandler(const char* path, const char* label) {
    g_crashPath = path;
    g_crashLabel = label;
    ::signal(SIGSEGV, crashHandler);
    ::signal(SIGABRT, crashHandler);
    ::signal(SIGBUS,  crashHandler);
    ::signal(SIGILL,  crashHandler);
    ::signal(SIGFPE,  crashHandler);
}

}  // namespace overdraw::log
