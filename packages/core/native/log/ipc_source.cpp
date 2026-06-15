#include "log/ipc_source.h"

#include <cerrno>
#include <cstring>

#include <sys/socket.h>
#include <unistd.h>

#include <spdlog/spdlog.h>

#include "log/log.h"
#include "log/log_wire.h"

namespace overdraw::log {

IpcSource::IpcSource() = default;

IpcSource::~IpcSource() { stop(); }

void IpcSource::start(int fd) {
    stop();
    stop_.store(false, std::memory_order_relaxed);
    fd_ = fd;
    thread_ = std::thread([this] { run_(); });
}

void IpcSource::stop() {
    stop_.store(true, std::memory_order_relaxed);
    if (fd_ >= 0) {
        // Shutdown to unblock blocked recv.
        ::shutdown(fd_, SHUT_RD);
    }
    if (thread_.joinable()) thread_.join();
    if (fd_ >= 0) {
        ::close(fd_);
        fd_ = -1;
    }
}

void IpcSource::run_() {
    LogPacket pkt;
    while (!stop_.load(std::memory_order_relaxed)) {
        const ssize_t r = ::recv(fd_, &pkt, sizeof(LogPacket), 0);
        if (r == 0) return;                            // peer closed
        if (r < 0) {
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
            return;                                    // hard error
        }
        if (static_cast<size_t>(r) < sizeof(LogPacketHeader)) continue;
        if (pkt.hdr.fragLen > kLogFragBytes) continue;  // malformed
        if (pkt.hdr.fragCount == 0) continue;
        if (pkt.hdr.fragIdx >= pkt.hdr.fragCount) continue;

        Assembly& a = inflight_[pkt.hdr.seq];
        if (a.need == 0) {
            a.need = pkt.hdr.fragCount;
            a.buf.reserve(pkt.hdr.totalLen);
        }
        a.buf.append(pkt.payload, pkt.hdr.fragLen);
        ++a.got;
        if (a.got != a.need) continue;

        // Complete. Dispatch into host spdlog.
        const auto level = static_cast<spdlog::level::level_enum>(pkt.hdr.level);
        const auto area = static_cast<Area>(pkt.hdr.area);
        if (static_cast<size_t>(area) < static_cast<size_t>(Area::Count_)) {
            // Resolve through spdlog's registry by name; the returned
            // shared_ptr keeps the logger alive even if our own registry
            // is torn down concurrently. Pass the message through
            // fmt::runtime to avoid interpreting `{`/`}` in untrusted text.
            if (auto lg = spdlog::get(areaName(area))) {
                lg->log(level, fmt::runtime(a.buf));
            }
        }
        inflight_.erase(pkt.hdr.seq);
    }
}

}  // namespace overdraw::log
