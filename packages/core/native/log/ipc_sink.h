// spdlog sink that serializes a log record into LogPacket datagrams on the
// log socket. Used by the GPU process.
//
// Before the log socket fd is set (the GPU process is given its fd via argv,
// so this window is the few instructions before main() parses it), records
// are appended to a bounded in-memory ring; once setFd() is called, the ring
// flushes in order and direct send takes over.

#ifndef OVERDRAW_LOG_IPC_SINK_H_
#define OVERDRAW_LOG_IPC_SINK_H_

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <vector>

#include <spdlog/sinks/base_sink.h>

namespace overdraw::log {

class IpcSink : public spdlog::sinks::base_sink<std::mutex> {
public:
    // Ring capacity (records) before the socket fd is set. Overflow drops the
    // oldest and surfaces a single overflow record (level=warn, area=Ipc).
    static constexpr size_t kRingCapacity = 256;

    IpcSink();
    ~IpcSink() override;

    // After this is called, future records send synchronously on `fd`. Drains
    // any buffered records first (in order, oldest first). Takes ownership in
    // the sense that the caller must not close `fd` while the sink is alive.
    void setFd(int fd);

protected:
    void sink_it_(const spdlog::details::log_msg& msg) override;
    void flush_() override {}

private:
    struct Buffered {
        uint8_t level;
        uint8_t area;       // overdraw::log::Area as u8; encoded from logger name
        uint64_t monotonicNs;
        std::string text;
    };

    // Send one assembled record. Returns false on hard socket error.
    bool sendRecord_(uint8_t level, uint8_t area, uint64_t ns,
                     const char* text, size_t len);

    int fd_ = -1;
    std::atomic<uint32_t> seq_{0};
    std::deque<Buffered> ring_;  // protected by base_sink mutex_
    size_t droppedSincePrevOverflow_ = 0;
};

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_IPC_SINK_H_
