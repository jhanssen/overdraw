#include "log/ring_sink.h"

#include <atomic>
#include <cstring>

#include <unistd.h>

namespace overdraw::log {

namespace {

struct Ring {
    // Total records ever written; slot = counter % kCrashRingSlots. Relaxed
    // ordering everywhere: the crash-time reader tolerates torn/stale slots.
    std::atomic<uint64_t> counter{0};
    // Each slot holds one NUL-terminated formatted line (truncated to fit).
    char slots[kCrashRingSlots][kCrashRingSlotBytes];
};

Ring& ring() {
    static Ring r;
    return r;
}

}  // namespace

void RingSink::sink_it_(const spdlog::details::log_msg& msg) {
    spdlog::memory_buf_t formatted;
    base_sink<std::mutex>::formatter_->format(msg, formatted);
    auto& r = ring();
    const uint64_t n = r.counter.load(std::memory_order_relaxed);
    char* slot = r.slots[n % kCrashRingSlots];
    size_t len = formatted.size();
    // Strip the formatter's trailing newline; dump() re-adds one.
    while (len > 0 && (formatted.data()[len - 1] == '\n' || formatted.data()[len - 1] == '\r'))
        --len;
    if (len >= kCrashRingSlotBytes) len = kCrashRingSlotBytes - 1;
    std::memcpy(slot, formatted.data(), len);
    slot[len] = '\0';
    r.counter.store(n + 1, std::memory_order_release);
}

void crashRingDump(int fd) {
    auto& r = ring();
    const uint64_t n = r.counter.load(std::memory_order_acquire);
    const uint64_t count = n < kCrashRingSlots ? n : kCrashRingSlots;
    for (uint64_t i = n - count; i < n; ++i) {
        const char* slot = r.slots[i % kCrashRingSlots];
        // strnlen keeps a torn slot from running past its bounds.
        const size_t len = ::strnlen(slot, kCrashRingSlotBytes - 1);
        if (len == 0) continue;
        ssize_t w = ::write(fd, slot, len);
        (void)w;
        w = ::write(fd, "\n", 1);
        (void)w;
    }
}

void crashRingReset() {
    auto& r = ring();
    r.counter.store(0, std::memory_order_relaxed);
    std::memset(r.slots, 0, sizeof(r.slots));
}

}  // namespace overdraw::log
