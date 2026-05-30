// Shared transport helpers for the core <-> GPU-process link.
//
// All sockets are non-blocking. Neither process may ever park in a write():
// doing so wedges a single-threaded peer (the GPU process) and deadlocks the
// pair (each blocked writing while the other waits to be read). So every writer
// here BUFFERS what the socket cannot immediately accept and drains it later
// when the fd reports writable (libuv UV_WRITABLE in the core; epoll EPOLLOUT in
// the GPU process). Readers accumulate partial data and yield whole frames.
//
// - FdSerializer: a dawn::wire::CommandSerializer for the wire socket. Flush()
//   never blocks; it queues the framed batch and writes what fits.
// - FrameReader: non-blocking reader of length-prefixed wire frames.
// - CtrlChannel: buffered SEQPACKET control sender (with SCM_RIGHTS) + NB recv.

#ifndef OVERDRAW_IPC_TRANSPORT_H_
#define OVERDRAW_IPC_TRANSPORT_H_

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cerrno>
#include <deque>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

#include "dawn/wire/Wire.h"

#include "side_channel.h"

namespace overdraw::ipc {

// Put a fd into non-blocking mode. Returns true on success.
inline bool setNonBlocking(int fd) {
    int fl = ::fcntl(fd, F_GETFL, 0);
    if (fl < 0) return false;
    return ::fcntl(fd, F_SETFL, fl | O_NONBLOCK) == 0;
}

// ---------------------------------------------------------------------------
// Wire (SOCK_STREAM): length-prefixed frames, buffered non-blocking I/O.
// ---------------------------------------------------------------------------

// dawn::wire::CommandSerializer over a non-blocking stream socket. Dawn batches
// commands between Flush() calls; on Flush we frame the batch (4-byte LE length
// + payload) into the outbound queue and write as much as the socket accepts.
// Flush NEVER blocks. The owner must call pumpOut() when the fd becomes
// writable (and may call it opportunistically) to drain the rest.
class FdSerializer : public dawn::wire::CommandSerializer {
  public:
    explicit FdSerializer(int fd) : fd_(fd) { buf_.resize(kCapacity); }

    size_t GetMaximumAllocationSize() const override { return kMaxAllocation; }

    // Each returned region must be 8-byte aligned (Dawn lays out command structs
    // assuming kWireBufferAlignment=8; an unaligned start mis-reads u64 fields).
    // The batch buffer base is max_align_t-aligned and we only hand out the
    // current offset, which Dawn advances by 8-aligned sizes.
    void* GetCmdSpace(size_t size) override {
        size_t offset = pending_;
        if (offset + size > buf_.size()) return nullptr;  // batch overflow
        pending_ = offset + size;
        return buf_.data() + offset;
    }

    // Frame the pending batch into the outbound queue, then try to flush. Never
    // blocks. Returns false only on a fatal socket error (peer closed).
    bool Flush() override {
        if (pending_) {
            uint32_t len = static_cast<uint32_t>(pending_);
            const uint8_t* lp = reinterpret_cast<const uint8_t*>(&len);
            out_.insert(out_.end(), lp, lp + 4);
            out_.insert(out_.end(), buf_.data(), buf_.data() + pending_);
            bytesQueued_ += 4u + pending_;  // framed bytes (length prefix + payload)
            pending_ = 0;
        }
        return pumpOut();
    }

    // Cumulative count of framed bytes ever enqueued (length prefixes + payload).
    // Used as a cross-channel ordering serial: a side-channel request tagged with
    // the value sampled after a Flush is only acted on by the peer once its wire
    // reader has consumed at least that many bytes (i.e. all wire commands queued
    // up to that point -- object creates, unregisters -- have been processed).
    uint64_t bytesQueued() const { return bytesQueued_; }

    // Write as much of the outbound queue as the socket accepts right now.
    // Non-blocking. Returns false on a fatal error. Call on fd-writable.
    bool pumpOut() {
        while (!out_.empty()) {
            // Copy a contiguous chunk out of the deque for write().
            size_t n = out_.size();
            if (n > kChunk) n = kChunk;
            scratch_.assign(out_.begin(), out_.begin() + static_cast<long>(n));
            ssize_t w = ::write(fd_, scratch_.data(), n);
            if (w > 0) {
                out_.erase(out_.begin(), out_.begin() + w);
                continue;
            }
            if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return true;  // try later
            if (w < 0 && errno == EINTR) continue;
            return false;  // fatal
        }
        return true;
    }

    bool hasPendingOut() const { return !out_.empty(); }
    int fd() const { return fd_; }

  private:
    static constexpr size_t kMaxAllocation = 1u << 20;     // 1 MiB (one command)
    static constexpr size_t kCapacity = 16u * (1u << 20);  // 16 MiB batch headroom
    static constexpr size_t kChunk = 256u * 1024u;         // write granularity

    int fd_;
    std::vector<uint8_t> buf_;       // current Dawn batch (pre-frame)
    size_t pending_ = 0;
    std::deque<uint8_t> out_;        // framed bytes awaiting the socket
    std::vector<uint8_t> scratch_;   // contiguous staging for write()
    uint64_t bytesQueued_ = 0;       // cumulative framed bytes enqueued (ordering serial)
};

// Accumulates bytes from a non-blocking stream socket and yields complete
// length-prefixed frames. readAvailable() drains the socket once (call on
// fd-readable); nextFrame() pops one decoded frame if fully buffered.
class FrameReader {
  public:
    explicit FrameReader(int fd) : fd_(fd) {}

    // Read whatever the socket has right now into the inbound buffer. Returns
    // false if the peer closed (recv returned 0); true otherwise (incl. EAGAIN).
    bool readAvailable() {
        uint8_t tmp[64 * 1024];
        for (;;) {
            ssize_t r = ::read(fd_, tmp, sizeof(tmp));
            if (r > 0) { in_.insert(in_.end(), tmp, tmp + r); continue; }
            if (r == 0) return false;  // peer closed
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            if (errno == EINTR) continue;
            return false;  // fatal
        }
        compact();
        return true;
    }

    // Pop one complete frame into `out`. Returns true if a frame was available.
    bool nextFrame(std::vector<uint8_t>& out) {
        size_t avail = in_.size() - rd_;
        if (avail < 4) return false;
        uint32_t len;
        std::memcpy(&len, in_.data() + rd_, 4);
        if (avail < 4u + len) return false;
        out.assign(in_.begin() + rd_ + 4, in_.begin() + rd_ + 4 + len);
        rd_ += 4u + len;
        bytesConsumed_ += 4u + len;  // framed bytes handed out (matches FdSerializer::bytesQueued)
        return true;
    }

    // Cumulative framed bytes yielded via nextFrame. The peer's FdSerializer
    // counts the same framed units, so comparing this against a wireSerial sent
    // over the side channel tells us whether all wire commands up to that serial
    // have been handed to the wire server (HandleCommands) yet.
    uint64_t bytesConsumed() const { return bytesConsumed_; }

  private:
    // Reclaim consumed bytes from the front when the read offset grows large, to
    // bound the buffer (frames are popped from the front via rd_, not erased).
    void compact() {
        if (rd_ == 0) return;
        if (rd_ == in_.size()) { in_.clear(); rd_ = 0; return; }
        if (rd_ >= 1u << 20) { in_.erase(in_.begin(), in_.begin() + rd_); rd_ = 0; }
    }

    int fd_;
    std::vector<uint8_t> in_;
    size_t rd_ = 0;
    uint64_t bytesConsumed_ = 0;
};

// ---------------------------------------------------------------------------
// Control side channel (SOCK_SEQPACKET): fixed Message + optional SCM_RIGHTS.
// ---------------------------------------------------------------------------

// Max fds attachable to one side-channel message (single-plane dmabuf needs 1).
constexpr int kMaxMsgFds = 4;

// Buffered non-blocking control sender. Each datagram is one Message plus 0..N
// fds. If the socket can't accept it now, the message is queued (with dup'd fds
// so the caller's fds stay theirs) and retried on writable. SEQPACKET datagrams
// are atomic: a send either places the whole datagram or fails with EAGAIN.
class CtrlSender {
  public:
    explicit CtrlSender(int fd) : fd_(fd) {}
    ~CtrlSender() { for (auto& q : queue_) for (int fd : q.fds) if (fd >= 0) ::close(fd); }

    // Queue a message (+fds) and try to flush. fds are dup'd into the queue only
    // if the immediate send doesn't go through, so the common (non-blocked) path
    // does no dup. Returns false on fatal error.
    bool send(const Message& msg, const int* fds = nullptr, int nfds = 0) {
        if (queue_.empty()) {
            int r = trySend(msg, fds, nfds);
            if (r == 1) return true;       // sent
            if (r < 0) return false;       // fatal
        }
        // Could not send now (EAGAIN) or there is a backlog: enqueue (dup fds).
        Pending p;
        p.msg = msg;
        for (int i = 0; i < nfds; ++i) p.fds.push_back(fds[i] >= 0 ? ::fcntl(fds[i], F_DUPFD_CLOEXEC, 0) : -1);
        queue_.push_back(std::move(p));
        return true;
    }

    // Drain the queue as far as the socket allows. Call on fd-writable. Returns
    // false on fatal error.
    bool pumpOut() {
        while (!queue_.empty()) {
            Pending& p = queue_.front();
            int r = trySend(p.msg, p.fds.empty() ? nullptr : p.fds.data(),
                            static_cast<int>(p.fds.size()));
            if (r == 0) return true;  // EAGAIN, try later
            if (r < 0) return false;  // fatal
            for (int fd : p.fds) if (fd >= 0) ::close(fd);  // dup'd copies sent
            queue_.pop_front();
        }
        return true;
    }

    bool hasPendingOut() const { return !queue_.empty(); }
    int fd() const { return fd_; }

  private:
    struct Pending { Message msg; std::vector<int> fds; };

    // Returns 1 = sent, 0 = EAGAIN, -1 = fatal.
    int trySend(const Message& msg, const int* fds, int nfds) {
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
        for (;;) {
            ssize_t s = ::sendmsg(fd_, &mh, MSG_DONTWAIT | MSG_NOSIGNAL);
            if (s == static_cast<ssize_t>(sizeof(Message))) return 1;
            if (s < 0 && errno == EINTR) continue;
            if (s < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
            return -1;
        }
    }

    int fd_;
    std::deque<Pending> queue_;
};

// Blocking single-datagram send helpers. Used ONLY on the one-shot startup /
// handshake path, where brief blocking is acceptable and the peer is actively
// draining its startup spin. Steady-state senders MUST use CtrlSender (buffered)
// so a full socket can never wedge the event loop.
inline bool sendMessage(int fd, const Message& msg) {
    iovec iov{const_cast<Message*>(&msg), sizeof(Message)};
    msghdr mh{};
    mh.msg_iov = &iov;
    mh.msg_iovlen = 1;
    for (;;) {
        ssize_t s = ::sendmsg(fd, &mh, MSG_NOSIGNAL);
        if (s == static_cast<ssize_t>(sizeof(Message))) return true;
        if (s < 0 && errno == EINTR) continue;
        if (s < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            pollfd p{fd, POLLOUT, 0}; ::poll(&p, 1, -1); continue;
        }
        return false;
    }
}

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
    for (;;) {
        ssize_t s = ::sendmsg(fd, &mh, MSG_NOSIGNAL);
        if (s == static_cast<ssize_t>(sizeof(Message))) return true;
        if (s < 0 && errno == EINTR) continue;
        if (s < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            pollfd p{fd, POLLOUT, 0}; ::poll(&p, 1, -1); continue;
        }
        return false;
    }
}

// Non-blocking receive of one control message (no fds). True if one was read.
inline bool recvMessageNB(int fd, Message& msg) {
    iovec iov{&msg, sizeof(Message)};
    msghdr mh{};
    mh.msg_iov = &iov;
    mh.msg_iovlen = 1;
    return ::recvmsg(fd, &mh, MSG_DONTWAIT) == static_cast<ssize_t>(sizeof(Message));
}

// Non-blocking receive of one message plus any attached fds. Caller owns fds.
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
