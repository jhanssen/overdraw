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

// Max fds attachable to one side-channel message (single-plane dmabuf needs 1;
// allow a few for multi-plane later).
constexpr int kMaxMsgFds = 4;

// Send a message with `nfds` file descriptors attached via SCM_RIGHTS (blocking).
// The receiver gets dup'd copies; the sender keeps ownership of its fds.
inline bool sendMessageFds(int fd, const Message& msg, const int* fds, int nfds) {
    if (nfds < 0 || nfds > kMaxMsgFds) return false;
    iovec iov{const_cast<Message*>(&msg), sizeof(Message)};
    msghdr mh{};
    mh.msg_iov = &iov;
    mh.msg_iovlen = 1;

    char ctrl[CMSG_SPACE(sizeof(int) * kMaxMsgFds)];
    if (nfds > 0) {
        std::memset(ctrl, 0, sizeof(ctrl));
        mh.msg_control = ctrl;
        mh.msg_controllen = CMSG_SPACE(sizeof(int) * nfds);
        cmsghdr* cm = CMSG_FIRSTHDR(&mh);
        cm->cmsg_level = SOL_SOCKET;
        cm->cmsg_type = SCM_RIGHTS;
        cm->cmsg_len = CMSG_LEN(sizeof(int) * nfds);
        std::memcpy(CMSG_DATA(cm), fds, sizeof(int) * nfds);
        mh.msg_controllen = cm->cmsg_len;
    }
    return ::sendmsg(fd, &mh, 0) == static_cast<ssize_t>(sizeof(Message));
}

// Non-blocking receive of one message plus any attached fds. On success fills
// `msg`, writes received fds into `fds` (caller owns/closes them) and sets
// `*nfdsOut`. Returns true if a message was read.
inline bool recvMessageNBFds(int fd, Message& msg, int* fds, int* nfdsOut) {
    *nfdsOut = 0;
    iovec iov{&msg, sizeof(Message)};
    msghdr mh{};
    mh.msg_iov = &iov;
    mh.msg_iovlen = 1;
    char ctrl[CMSG_SPACE(sizeof(int) * kMaxMsgFds)];
    mh.msg_control = ctrl;
    mh.msg_controllen = sizeof(ctrl);

    ssize_t r = ::recvmsg(fd, &mh, MSG_DONTWAIT);
    if (r != static_cast<ssize_t>(sizeof(Message))) return false;

    for (cmsghdr* cm = CMSG_FIRSTHDR(&mh); cm; cm = CMSG_NXTHDR(&mh, cm)) {
        if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
            int n = static_cast<int>((cm->cmsg_len - CMSG_LEN(0)) / sizeof(int));
            if (n > kMaxMsgFds) n = kMaxMsgFds;
            std::memcpy(fds, CMSG_DATA(cm), sizeof(int) * n);
            *nfdsOut = n;
        }
    }
    return true;
}

}  // namespace overdraw::ipc

#endif  // OVERDRAW_IPC_TRANSPORT_H_
