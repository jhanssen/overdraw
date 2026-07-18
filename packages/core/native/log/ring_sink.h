// In-memory ring of the most recent formatted log records, kept so the crash
// handler can append them to a crash report. One process-global ring; the
// sink instance registered by logInit writes into it.
//
// The ring is a fixed array of fixed-size char slots with a monotonically
// increasing atomic write counter. Writers format under the sink mutex like
// any spdlog sink; the crash-time reader (crashRingDump) takes no locks --
// it snapshots the counter and write()s the slots oldest-first. A slot being
// concurrently overwritten can produce one torn line in the report; the
// process is dying, so that trade is accepted.

#ifndef OVERDRAW_LOG_RING_SINK_H_
#define OVERDRAW_LOG_RING_SINK_H_

#include <mutex>

#include <spdlog/sinks/base_sink.h>

namespace overdraw::log {

inline constexpr size_t kCrashRingSlots = 256;
inline constexpr size_t kCrashRingSlotBytes = 512;

class RingSink : public spdlog::sinks::base_sink<std::mutex> {
protected:
    void sink_it_(const spdlog::details::log_msg& msg) override;
    void flush_() override {}
};

// Write the ring's contents (oldest first, one line per record) to `fd` using
// only async-signal-safe calls. Safe to call from a signal handler.
void crashRingDump(int fd);

// Test hook: clear the ring.
void crashRingReset();

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_RING_SINK_H_
