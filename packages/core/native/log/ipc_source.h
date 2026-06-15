// Host-side reader for the log socket. Reassembles fragmented LogPackets and
// dispatches each record into the host's local spdlog logger for that area
// (so GPU-origin records flow through the same sinks as host-origin ones).
//
// The reader runs on a dedicated thread (logging is not in the hot path of
// the event loop and a blocking read is the simplest correct shape).

#ifndef OVERDRAW_LOG_IPC_SOURCE_H_
#define OVERDRAW_LOG_IPC_SOURCE_H_

#include <atomic>
#include <cstdint>
#include <string>
#include <thread>
#include <unordered_map>

namespace overdraw::log {

class IpcSource {
public:
    IpcSource();
    ~IpcSource();

    // Start the reader. `fd` is the host-side end of the log socket; the
    // source takes ownership and closes it on stop().
    void start(int fd);

    // Stop and join. Idempotent.
    void stop();

private:
    void run_();

    int fd_ = -1;
    std::atomic<bool> stop_{false};
    std::thread thread_;

    struct Assembly {
        std::string buf;     // accumulated fragments
        uint16_t need = 0;   // fragCount
        uint16_t got = 0;    // fragments received so far
    };
    std::unordered_map<uint32_t, Assembly> inflight_;
};

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_IPC_SOURCE_H_
