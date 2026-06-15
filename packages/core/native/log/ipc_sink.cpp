#include "log/ipc_sink.h"

#include <cerrno>
#include <cstring>
#include <ctime>

#include <poll.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#include <spdlog/details/log_msg.h>
#include <spdlog/pattern_formatter.h>

#include "log/log.h"
#include "log/log_wire.h"

namespace overdraw::log {

namespace {

uint64_t monotonicNow() {
    timespec ts{};
    ::clock_gettime(CLOCK_MONOTONIC, &ts);
    return static_cast<uint64_t>(ts.tv_sec) * 1'000'000'000ull
         + static_cast<uint64_t>(ts.tv_nsec);
}

uint8_t areaFromLoggerName(std::string_view name) {
    const Area a = areaFromName(name);
    if (a == Area::Count_) return static_cast<uint8_t>(Area::Js);  // fallback
    return static_cast<uint8_t>(a);
}

}  // namespace

IpcSink::IpcSink() = default;
IpcSink::~IpcSink() = default;

void IpcSink::setFd(int fd) {
    std::lock_guard<std::mutex> lk(mutex_);
    fd_ = fd;
    // Drain buffered records in order.
    while (!ring_.empty()) {
        const Buffered& b = ring_.front();
        sendRecord_(b.level, b.area, b.monotonicNs, b.text.data(), b.text.size());
        ring_.pop_front();
    }
    if (droppedSincePrevOverflow_ > 0) {
        char buf[96];
        const int n = std::snprintf(buf, sizeof(buf),
            "log ring overflow: %zu records dropped", droppedSincePrevOverflow_);
        sendRecord_(static_cast<uint8_t>(spdlog::level::warn),
                    static_cast<uint8_t>(Area::Ipc),
                    monotonicNow(), buf, static_cast<size_t>(n));
        droppedSincePrevOverflow_ = 0;
    }
}

void IpcSink::sink_it_(const spdlog::details::log_msg& msg) {
    // Format only the user-visible message payload. Source location + level +
    // area + timestamp are carried in the packet header, not in `text`.
    const std::string text(msg.payload.data(), msg.payload.size());
    const uint8_t level = static_cast<uint8_t>(msg.level);
    const uint8_t area = areaFromLoggerName(
        std::string_view(msg.logger_name.data(), msg.logger_name.size()));
    const uint64_t ns = monotonicNow();

    if (fd_ >= 0) {
        sendRecord_(level, area, ns, text.data(), text.size());
        return;
    }
    // Pre-fd: append to ring; drop oldest on overflow.
    if (ring_.size() >= kRingCapacity) {
        ring_.pop_front();
        ++droppedSincePrevOverflow_;
    }
    ring_.push_back(Buffered{level, area, ns, text});
}

bool IpcSink::sendRecord_(uint8_t level, uint8_t area, uint64_t ns,
                          const char* text, size_t len) {
    if (fd_ < 0) return false;
    const uint32_t seq = seq_.fetch_add(1, std::memory_order_relaxed);
    const size_t fragCount = len == 0
        ? 1
        : (len + kLogFragBytes - 1) / kLogFragBytes;

    for (size_t i = 0; i < fragCount; ++i) {
        LogPacket pkt{};
        pkt.hdr.level = level;
        pkt.hdr.area = area;
        pkt.hdr.fragCount = static_cast<uint16_t>(fragCount);
        pkt.hdr.fragIdx = static_cast<uint16_t>(i);
        pkt.hdr.seq = seq;
        pkt.hdr.totalLen = static_cast<uint32_t>(len);
        pkt.hdr.monotonicNs = ns;

        const size_t off = i * kLogFragBytes;
        const size_t take = (len > off) ? std::min(kLogFragBytes, len - off) : 0;
        pkt.hdr.fragLen = static_cast<uint16_t>(take);
        if (take > 0) std::memcpy(pkt.payload, text + off, take);

        // Send the prefix actually used (header + take bytes). The peer reads
        // up to sizeof(LogPacket); short-write semantics on SEQPACKET would
        // truncate, so we still send the whole sizeof(LogPacket) to keep the
        // recv buffer math trivial -- the receiver looks only at fragLen.
        for (;;) {
            const ssize_t s = ::send(fd_, &pkt, sizeof(LogPacket), MSG_NOSIGNAL);
            if (s == static_cast<ssize_t>(sizeof(LogPacket))) break;
            if (s < 0 && errno == EINTR) continue;
            if (s < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                pollfd p{fd_, POLLOUT, 0};
                ::poll(&p, 1, -1);
                continue;
            }
            // Hard error (peer closed, etc.): give up; later records still try.
            return false;
        }
    }
    return true;
}

}  // namespace overdraw::log
