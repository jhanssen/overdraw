#include "crash_handler.h"

#include <algorithm>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <vector>

#include <dirent.h>
#include <execinfo.h>
#include <fcntl.h>
#include <unistd.h>

#include "log/ring_sink.h"

namespace overdraw::log {

namespace {

// Fixed storage read from inside the signal handler. installCrashHandler
// truncates rather than overflows.
char g_crashDir[512];
char g_crashLabel[32];

const char* signalName(int sig) {
    switch (sig) {
        case SIGSEGV: return "SIGSEGV";
        case SIGABRT: return "SIGABRT";
        case SIGBUS:  return "SIGBUS";
        case SIGILL:  return "SIGILL";
        case SIGFPE:  return "SIGFPE";
        default:      return "signal";
    }
}

// Decimal/hex formatting without snprintf (async-signal-safe).
size_t formatU64(uint64_t v, char* out) {
    char tmp[20];
    size_t n = 0;
    do { tmp[n++] = static_cast<char>('0' + v % 10); v /= 10; } while (v);
    for (size_t i = 0; i < n; ++i) out[i] = tmp[n - 1 - i];
    return n;
}

size_t formatHex(uint64_t v, char* out) {
    static const char kHex[] = "0123456789abcdef";
    char tmp[16];
    size_t n = 0;
    do { tmp[n++] = kHex[v % 16]; v /= 16; } while (v);
    for (size_t i = 0; i < n; ++i) out[i] = tmp[n - 1 - i];
    return n;
}

size_t append(char* buf, size_t at, const char* s) {
    const size_t len = std::strlen(s);
    std::memcpy(buf + at, s, len);
    return at + len;
}

void crashHandler(int sig, siginfo_t* info, void*) {
    // crash-<label>-<epochsecs>-<pid>.txt in g_crashDir. O_EXCL: never
    // clobber an earlier report (pid+time make collisions implausible; if
    // one happens anyway, losing the later report beats corrupting the
    // earlier one).
    char path[640];
    size_t at = append(path, 0, g_crashDir);
    at = append(path, at, "/crash-");
    at = append(path, at, g_crashLabel);
    path[at++] = '-';
    at += formatU64(static_cast<uint64_t>(::time(nullptr)), path + at);
    path[at++] = '-';
    at += formatU64(static_cast<uint64_t>(::getpid()), path + at);
    at = append(path, at, ".txt");
    path[at] = '\0';

    int fd = ::open(path, O_WRONLY | O_CREAT | O_EXCL, 0644);
    if (fd >= 0) {
        char hdr[192];
        size_t h = append(hdr, 0, g_crashLabel);
        h = append(hdr, h, " caught ");
        h = append(hdr, h, signalName(sig));
        h = append(hdr, h, " (");
        h += formatU64(static_cast<uint64_t>(sig), hdr + h);
        h = append(hdr, h, ")");
        if (sig == SIGSEGV || sig == SIGBUS || sig == SIGILL || sig == SIGFPE) {
            h = append(hdr, h, " addr=0x");
            h += formatHex(reinterpret_cast<uintptr_t>(info->si_addr), hdr + h);
        }
        h = append(hdr, h, "\n\n");
        ssize_t w = ::write(fd, hdr, h);
        (void)w;

        void* frames[64];
        int got = ::backtrace(frames, 64);
        ::backtrace_symbols_fd(frames, got, fd);

        static const char kSep[] = "\n--- recent log records (oldest first) ---\n";
        w = ::write(fd, kSep, sizeof(kSep) - 1);
        (void)w;
        crashRingDump(fd);
        ::close(fd);
    }
    ::signal(sig, SIG_DFL);
    ::raise(sig);
}

// Keep the newest `keep` crash-* files; unlink the rest. Sorting by name
// works because the filename embeds epoch seconds (ties broken by pid, which
// is fine for a retention policy).
void pruneCrashReports(const std::string& dir, size_t keep) {
    DIR* d = ::opendir(dir.c_str());
    if (!d) return;
    std::vector<std::string> names;
    while (dirent* e = ::readdir(d)) {
        if (std::strncmp(e->d_name, "crash-", 6) == 0) names.emplace_back(e->d_name);
    }
    ::closedir(d);
    if (names.size() <= keep) return;
    std::sort(names.begin(), names.end());
    for (size_t i = 0; i + keep < names.size(); ++i) {
        ::unlink((dir + "/" + names[i]).c_str());
    }
}

}  // namespace

void installCrashHandler(const std::string& dir, const char* label) {
    if (dir.empty()) return;
    std::snprintf(g_crashDir, sizeof(g_crashDir), "%s", dir.c_str());
    std::snprintf(g_crashLabel, sizeof(g_crashLabel), "%s", label);

    pruneCrashReports(dir, 20);

    // Dedicated signal stack so a stack-overflow SIGSEGV still gets a report.
    static std::vector<char> altStack(static_cast<size_t>(SIGSTKSZ) * 4);
    stack_t ss{};
    ss.ss_sp = altStack.data();
    ss.ss_size = altStack.size();
    ::sigaltstack(&ss, nullptr);

    struct sigaction sa{};
    sa.sa_sigaction = crashHandler;
    sa.sa_flags = SA_SIGINFO | SA_ONSTACK;
    ::sigemptyset(&sa.sa_mask);
    ::sigaction(SIGSEGV, &sa, nullptr);
    ::sigaction(SIGABRT, &sa, nullptr);
    ::sigaction(SIGBUS,  &sa, nullptr);
    ::sigaction(SIGILL,  &sa, nullptr);
    ::sigaction(SIGFPE,  &sa, nullptr);
}

}  // namespace overdraw::log
