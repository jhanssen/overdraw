// Shared transport helpers for the core <-> GPU-process link.
//
// - FdSerializer: a dawn::wire::CommandSerializer that length-prefixes each
//   command block and writes it to a unix socket. Both the wire client (core)
//   and wire server (GPU process) use one.
// - readWireFrame: blocking-once-peeked read of a single length-prefixed wire
//   frame; returns false if no complete frame is currently available.
// - sendMessage / recvMessage: framed side-channel control messages.

#ifndef OVERDRAW_IPC_TRANSPORT_H_
#define OVERDRAW_IPC_TRANSPORT_H_

#include <cstdint>
#include <cstring>
#include <vector>

#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#include "dawn/wire/Wire.h"

#include "side_channel.h"

namespace overdraw::ipc {

class FdSerializer : public dawn::wire::CommandSerializer {
  public:
    explicit FdSerializer(int fd) : fd_(fd) {}

    size_t GetMaximumAllocationSize() const override { return 1u << 20; }

    // Dawn batches multiple commands between Flush() calls: each GetCmdSpace
    // hands back a region the wire writes one command into, and they accumulate
    // until Flush. We must APPEND (not overwrite) so the whole batch is sent as
    // one length-prefixed frame; HandleCommands on the peer processes the batch.
    void* GetCmdSpace(size_t size) override {
        size_t offset = pending_;
        if (offset + size > buf_.size()) buf_.resize(offset + size);
        pending_ = offset + size;
        return buf_.data() + offset;
    }

    bool Flush() override {
        if (!pending_) return true;
        uint32_t len = static_cast<uint32_t>(pending_);
        if (writeAll(&len, 4) || writeAll(buf_.data(), len)) return false;
        pending_ = 0;
        return true;
    }

  private:
    int writeAll(const void* p, size_t n) {
        const uint8_t* b = static_cast<const uint8_t*>(p);
        while (n) {
            ssize_t w = ::write(fd_, b, n);
            if (w <= 0) return -1;
            b += w;
            n -= static_cast<size_t>(w);
        }
        return 0;
    }

    int fd_;
    std::vector<uint8_t> buf_ = std::vector<uint8_t>(4096);
    size_t pending_ = 0;
};

// Reads one length-prefixed wire frame if a complete one is available now.
// Returns true and fills `out`; false if nothing pending or the peer closed.
inline bool readWireFrame(int fd, std::vector<uint8_t>& out) {
    uint32_t len;
    ssize_t r = ::recv(fd, &len, 4, MSG_DONTWAIT | MSG_PEEK);
    if (r != 4) return false;
    size_t got = 0;
    uint8_t* p = reinterpret_cast<uint8_t*>(&len);
    while (got < 4) {
        ssize_t k = ::read(fd, p + got, 4 - got);
        if (k <= 0) return false;
        got += static_cast<size_t>(k);
    }
    out.resize(len);
    got = 0;
    while (got < len) {
        ssize_t k = ::read(fd, out.data() + got, len - got);
        if (k <= 0) return false;
        got += static_cast<size_t>(k);
    }
    return true;
}

// Side-channel control message send (blocking).
inline bool sendMessage(int fd, const Message& msg) {
    iovec iov{const_cast<Message*>(&msg), sizeof(Message)};
    msghdr mh{};
    mh.msg_iov = &iov;
    mh.msg_iovlen = 1;
    return ::sendmsg(fd, &mh, 0) == static_cast<ssize_t>(sizeof(Message));
}

// Non-blocking side-channel receive of one message. Returns true if one was read.
inline bool recvMessageNB(int fd, Message& msg) {
    iovec iov{&msg, sizeof(Message)};
    msghdr mh{};
    mh.msg_iov = &iov;
    mh.msg_iovlen = 1;
    return ::recvmsg(fd, &mh, MSG_DONTWAIT) == static_cast<ssize_t>(sizeof(Message));
}

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_TRANSPORT_H_
