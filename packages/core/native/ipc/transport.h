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
#include <cstdlib>
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
// Wire (SOCK_STREAM): length-prefixed, kind-tagged frames, buffered NB I/O.
// ---------------------------------------------------------------------------

// Frame kinds multiplexed on the wire socket. kind=0 is Dawn wire bytes (the
// only payload Dawn ever produces); kind != 0 are overdraw-internal control
// frames (access brackets) that ride the same FIFO so they are ordered against
// the Dawn commands around them without a cross-channel barrier.
//
// ImportClientTex / ClientTexImported also ride this FIFO (not the ctrl
// channel): the request allocates a server-side wire texture slot
// (Server::InjectTexture), and a wire command issued AFTER the matching
// ReserveTexture (e.g. Surface::APIGetCurrentTexture allocating the next
// sequential id) requires that slot to already exist on the server -- otherwise
// the server's Allocate sees `handle.id > mKnown.size()` and rejects the
// subsequent wire command, producing a silent missing-texture (black surface).
// Putting ImportClientTex on the wire makes it naturally FIFO-ordered with the
// surrounding wire commands so this gap cannot open. The dmabuf fd rides as
// SCM_RIGHTS on the sendmsg that delivers the kind=3 frame.
enum class FrameKind : uint8_t {
    WireBytes = 0,            // Dawn wire command batch -> WireServer::HandleCommands
    BeginAccess = 1,          // overdraw BeginAccess bracket (payload: variant + ids)
    EndAccess = 2,            // overdraw EndAccess bracket   (payload: variant + ids)
    ImportClientTex = 3,      // core -> gpu: import a CLIENT dmabuf into a reserved
                              // texture slot. fd attached via SCM_RIGHTS on the
                              // sendmsg that carried this frame.
    ClientTexImported = 4,    // gpu -> core: import done (ok=1) or failed (ok=0).
                              // No fd; the reply payload echoes the texture handle
                              // so the core's pendingJsImports list matches by id.
};

// Max fds attachable in one message (control msg OR in-band wire frame).
// Single-plane dmabuf is the only fd-bearing payload today, which needs 1; we
// keep headroom up to 4. Defined here (not next to the ctrl helpers below)
// because the wire-socket sendmsg / recvmsg paths in FdSerializer / FrameReader
// also reference it.
inline constexpr int kMaxMsgFds = 4;

// Per-frame header overhead in the byte-accounting counters. The wire format is
// [length: u32 LE][kind: u8][payload...], where `length` counts kind + payload.
// CONTRACT (load-bearing, do not break unilaterally): FdSerializer::bytesQueued
// (sender) and FrameReader::bytesConsumed (receiver) MUST both add exactly this
// many bytes per frame on top of the payload, or WireBarrier's serial comparison
// (used for ImportClientTex's recycled-handle ordering) drifts off-by-N per frame
// and silently re-admits the race. Both counters use this same constant so the
// two sides cannot diverge without editing one shared definition.
inline constexpr uint64_t kFrameHeaderBytes = 4u /*length prefix*/ + 1u /*kind*/;

// dawn::wire::CommandSerializer over a non-blocking stream socket. Dawn batches
// commands between Flush() calls; on Flush we frame the batch
// ([len][kind=0][payload]) into the outbound queue and write what the socket
// accepts. Flush NEVER blocks. The owner must call pumpOut() when the fd becomes
// writable (and may call it opportunistically) to drain the rest. appendFrame()
// emits non-Dawn (kind != 0) control frames on the SAME queue, flushing any
// staged Dawn bytes first so the kind switch is a clean FIFO boundary.
//
// appendFrameWithFds() is the variant for frames that carry SCM_RIGHTS fds
// (ImportClientTex). The fds attach to the first byte of the frame's queued
// region; pumpOut uses sendmsg+SCM_RIGHTS for that exact send, plain write()
// for the rest. Out-of-the-pumpOut-path fd ownership is tracked here so that a
// queued-but-unsent fd is closed only when its bytes ship (the caller's fd is
// dup'd into the queue at enqueue time to keep ownership clean).
class FdSerializer : public dawn::wire::CommandSerializer {
  public:
    explicit FdSerializer(int fd) : fd_(fd) { buf_.resize(kCapacity); }
    ~FdSerializer() {
        // Close any unsent dup'd fds.
        for (auto& a : fdAttachments_) {
            for (int fd : a.fds) if (fd >= 0) ::close(fd);
        }
    }

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

    // Frame the pending Dawn batch ([len][kind=0][payload]) into the outbound
    // queue, then try to flush. Never blocks. Returns false only on a fatal
    // socket error (peer closed).
    bool Flush() override {
        if (pending_) {
            frame(FrameKind::WireBytes, buf_.data(), pending_);
            pending_ = 0;
        }
        return pumpOut();
    }

    // Emit a non-Dawn control frame (kind != 0). UNCONDITIONALLY flushes any
    // staged Dawn bytes first: the socket FIFO orders FRAMES, not the unflushed
    // pending_ batch, so a control frame appended without draining pending_ would
    // land ahead of Dawn commands the caller already issued. Building the flush
    // in here makes the "kind switch is a flush boundary" invariant non-violable
    // from callers. Flush() is a cheap no-op when pending_ is empty.
    bool appendFrame(FrameKind kind, const void* payload, size_t len) {
        Flush();  // drain staged Dawn bytes as a kind=0 frame (no-op if empty)
        frame(kind, payload, len);
        return pumpOut();
    }

    // Emit a non-Dawn frame with attached SCM_RIGHTS fds. Same Flush-first
    // discipline as appendFrame. The fds are dup'd into the queue so the caller
    // can close its originals immediately; the queued copies are closed when
    // their bytes ship (or when the serializer is destroyed). Returns false on
    // fatal socket error OR on fd dup failure.
    bool appendFrameWithFds(FrameKind kind, const void* payload, size_t len,
                            const int* fds, int nfds) {
        if (nfds <= 0 || nfds > kMaxMsgFds) return false;
        Flush();
        // Record the byte offset (within the running out_ deque) where this
        // frame starts; pumpOut uses this to know when to switch to sendmsg
        // with SCM_RIGHTS.
        FdAttachment a{};
        a.startOffset = bytesQueued_;  // cumulative bytes ever queued (before adding this frame)
        a.frameBytes = kFrameHeaderBytes + len;
        for (int i = 0; i < nfds; ++i) {
            int duped = fds[i] >= 0 ? ::fcntl(fds[i], F_DUPFD_CLOEXEC, 0) : -1;
            if (duped < 0) {
                // Close any successful dups so we don't leak.
                for (int d : a.fds) if (d >= 0) ::close(d);
                return false;
            }
            a.fds.push_back(duped);
        }
        fdAttachments_.push_back(std::move(a));
        frame(kind, payload, len);
        return pumpOut();
    }

    // Cumulative count of framed bytes ever enqueued (header + payload, see
    // kFrameHeaderBytes). Used as a cross-channel ordering serial: a side-channel
    // request tagged with the value sampled after a Flush is only acted on by the
    // peer once its wire reader has consumed at least that many bytes (i.e. all
    // wire commands queued up to that point -- object creates, unregisters --
    // have been processed).
    uint64_t bytesQueued() const { return bytesQueued_; }

    // Write as much of the outbound queue as the socket accepts right now.
    // Non-blocking. Returns false on a fatal error. Call on fd-writable.
    //
    // The pump is fd-attachment aware: when the queue head is the start of an
    // fd-bearing frame, the entire frame is sent in one sendmsg with SCM_RIGHTS.
    // Otherwise plain write() chunks are used. This preserves FIFO order across
    // mixed plain / fd-bearing frames.
    bool pumpOut() {
        while (!out_.empty()) {
            // Sent-so-far counter: bytes already drained from the front of out_.
            // totalQueuedBytes_ - out_.size() is the cumulative byte offset of
            // the front of out_; compare to fdAttachments_.front().startOffset
            // to know whether the next chunk is the head of an fd-bearing frame.
            uint64_t headOffset = bytesQueued_ - out_.size();
            if (!fdAttachments_.empty() && fdAttachments_.front().startOffset == headOffset) {
                // Send the entire fd-bearing frame as one sendmsg + SCM_RIGHTS.
                FdAttachment& a = fdAttachments_.front();
                size_t n = a.frameBytes;
                if (n > out_.size()) return true;  // shouldn't happen, but defensive
                if (n > kChunk) n = kChunk;        // never exceeds frame size in any
                                                   // sane configuration; the frame
                                                   // is small (~44 bytes)
                scratch_.assign(out_.begin(), out_.begin() + static_cast<long>(n));
                iovec iov{scratch_.data(), n};
                msghdr mh{};
                mh.msg_iov = &iov;
                mh.msg_iovlen = 1;
                char ctrl[CMSG_SPACE(sizeof(int) * kMaxMsgFds)];
                std::memset(ctrl, 0, sizeof(ctrl));
                const int nfds = static_cast<int>(a.fds.size());
                mh.msg_control = ctrl;
                mh.msg_controllen = CMSG_SPACE(sizeof(int) * nfds);
                cmsghdr* cm = CMSG_FIRSTHDR(&mh);
                cm->cmsg_level = SOL_SOCKET;
                cm->cmsg_type = SCM_RIGHTS;
                cm->cmsg_len = CMSG_LEN(sizeof(int) * nfds);
                std::memcpy(CMSG_DATA(cm), a.fds.data(), sizeof(int) * nfds);
                mh.msg_controllen = cm->cmsg_len;
                ssize_t s = ::sendmsg(fd_, &mh, MSG_DONTWAIT | MSG_NOSIGNAL);
                if (s == static_cast<ssize_t>(n)) {
                    out_.erase(out_.begin(), out_.begin() + s);
                    // fds delivered; close our dup'd copies.
                    for (int d : a.fds) if (d >= 0) ::close(d);
                    fdAttachments_.pop_front();
                    continue;
                }
                if (s >= 0) {
                    // Partial: cannot happen for a single message smaller than
                    // socket-buffer space on AF_UNIX/STREAM with sendmsg one-iov,
                    // but be defensive. Bail; pump again later.
                    return true;
                }
                if (errno == EAGAIN || errno == EWOULDBLOCK) return true;
                if (errno == EINTR) continue;
                return false;  // fatal
            }
            // Plain bytes path. Copy a contiguous chunk out of the deque for write().
            size_t n = out_.size();
            if (n > kChunk) n = kChunk;
            // If an fd-bearing frame starts inside this chunk, shorten the chunk
            // so we stop at the fd-frame boundary (next iteration takes the
            // sendmsg path).
            if (!fdAttachments_.empty()) {
                uint64_t nextFdOffset = fdAttachments_.front().startOffset;
                uint64_t bytesUntilFd = nextFdOffset - headOffset;
                if (bytesUntilFd < n) n = bytesUntilFd;
            }
            if (n == 0) continue;  // immediate next iter takes the sendmsg path
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

    // Append one [length: u32 LE][kind: u8][payload] frame to the outbound queue
    // and advance the byte-accounting counter. `length` = 1 (kind) + payload len.
    // Does not write to the socket; callers follow with pumpOut().
    void frame(FrameKind kind, const void* payload, size_t payloadLen) {
        uint32_t len = static_cast<uint32_t>(1u + payloadLen);  // kind + payload
        const uint8_t* lp = reinterpret_cast<const uint8_t*>(&len);
        out_.insert(out_.end(), lp, lp + 4);
        out_.push_back(static_cast<uint8_t>(kind));
        const uint8_t* p = static_cast<const uint8_t*>(payload);
        out_.insert(out_.end(), p, p + payloadLen);
        bytesQueued_ += kFrameHeaderBytes + payloadLen;
    }

    // Fd-bearing frame metadata: at which cumulative byte offset (in the running
    // queued stream) does the frame start, how many bytes is it, and what fds
    // attach to it. In FIFO order with the byte stream.
    struct FdAttachment {
        uint64_t startOffset;
        size_t frameBytes;
        std::vector<int> fds;
    };

    int fd_;
    std::vector<uint8_t> buf_;       // current Dawn batch (pre-frame)
    size_t pending_ = 0;
    std::deque<uint8_t> out_;        // framed bytes awaiting the socket
    std::vector<uint8_t> scratch_;   // contiguous staging for write()
    uint64_t bytesQueued_ = 0;       // cumulative framed bytes enqueued (ordering serial,
                                     // also used to compute out_'s front offset:
                                     // bytesQueued_ - out_.size()).
    std::deque<FdAttachment> fdAttachments_;
};

// Accumulates bytes from a non-blocking stream socket and yields complete
// length-prefixed frames. readAvailable() drains the socket once (call on
// fd-readable); nextFrame() pops one decoded frame if fully buffered.
//
// SCM_RIGHTS support: readAvailable uses recvmsg so it can pick up fds that
// arrive attached to fd-bearing frames (ImportClientTex carries the dmabuf fd
// this way). Received fds are pushed onto a FIFO and yielded alongside the
// next fd-bearing frame via the (FrameKind&, payload, fds&) overload.
//
// The kernel attaches SCM_RIGHTS fds to a specific recvmsg's return -- the one
// that returns the first byte of the data the sender sent with that sendmsg.
// On a stream socket this means a recvmsg's ancillary fds are delivered AT or
// BEFORE the bytes of the frame they describe. We exploit that by pushing
// arriving fds into a FIFO at recv time and popping them when the matching
// fd-bearing frame is decoded. This is correct as long as the wire's frame
// FIFO order is preserved (it is: TCP/UNIX-stream-socket bytes are in order).
class FrameReader {
  public:
    explicit FrameReader(int fd) : fd_(fd) {}
    ~FrameReader() {
        // Close any received-but-unclaimed fds.
        for (int fd : recvFds_) if (fd >= 0) ::close(fd);
    }

    // Read whatever the socket has right now into the inbound buffer. Returns
    // false if the peer closed (recv returned 0); true otherwise (incl. EAGAIN).
    bool readAvailable() {
        uint8_t tmp[64 * 1024];
        for (;;) {
            iovec iov{tmp, sizeof(tmp)};
            msghdr mh{};
            mh.msg_iov = &iov;
            mh.msg_iovlen = 1;
            char ctrl[CMSG_SPACE(sizeof(int) * kMaxMsgFds) * 4];  // headroom: a few attachments per recv
            mh.msg_control = ctrl;
            mh.msg_controllen = sizeof(ctrl);
            ssize_t r = ::recvmsg(fd_, &mh, MSG_DONTWAIT | MSG_CMSG_CLOEXEC);
            if (r > 0) {
                in_.insert(in_.end(), tmp, tmp + r);
                for (cmsghdr* cm = CMSG_FIRSTHDR(&mh); cm; cm = CMSG_NXTHDR(&mh, cm)) {
                    if (cm->cmsg_level == SOL_SOCKET && cm->cmsg_type == SCM_RIGHTS) {
                        int n = static_cast<int>((cm->cmsg_len - CMSG_LEN(0)) / sizeof(int));
                        const int* fds = reinterpret_cast<const int*>(CMSG_DATA(cm));
                        for (int i = 0; i < n; ++i) recvFds_.push_back(fds[i]);
                    }
                }
                continue;
            }
            if (r == 0) return false;  // peer closed
            if (errno == EAGAIN || errno == EWOULDBLOCK) break;
            if (errno == EINTR) continue;
            return false;  // fatal
        }
        compact();
        return true;
    }

    // Pop one complete frame: its kind byte into `kind`, payload into `out`.
    // Returns true if a whole frame was buffered. Wire format is
    // [length: u32 LE][kind: u8][payload], length counting kind + payload.
    // Frames carrying SCM_RIGHTS fds must use the overload below; this one
    // surfaces nothing about attached fds (any fd that arrives still in the
    // FIFO without a caller claiming it is leaked-then-closed at teardown).
    bool nextFrame(FrameKind& kind, std::vector<uint8_t>& out) {
        size_t avail = in_.size() - rd_;
        if (avail < 4) return false;
        uint32_t len;
        std::memcpy(&len, in_.data() + rd_, 4);
        if (len < 1) return false;             // malformed: must hold a kind byte
        if (avail < 4u + len) return false;    // frame not fully buffered yet
        kind = static_cast<FrameKind>(in_[rd_ + 4]);
        size_t payloadLen = len - 1u;
        out.assign(in_.begin() + rd_ + 5, in_.begin() + rd_ + 5 + payloadLen);
        rd_ += 4u + len;
        // Header (kFrameHeaderBytes) + payload; mirrors FdSerializer exactly.
        bytesConsumed_ += kFrameHeaderBytes + payloadLen;
        return true;
    }

    // Overload that ALSO claims any fds that arrived attached to this frame.
    // Caller-owned fds are returned via `fdsOut`; the number is written to
    // `nfdsOut` (0 if no fds were attached). Used by callers that may receive
    // fd-bearing frames (FrameKind::ImportClientTex on the core->gpu wire).
    bool nextFrame(FrameKind& kind, std::vector<uint8_t>& out,
                   int* fdsOut, int* nfdsOut) {
        if (!nextFrame(kind, out)) return false;
        // For fd-bearing kinds, pop the expected number of fds from the FIFO.
        // The convention is hard-coded per kind because the payload doesn't
        // carry an "nfds" field (frames are point-to-point so both ends agree
        // on the per-kind fd shape).
        int expect = 0;
        if (kind == FrameKind::ImportClientTex) expect = 1;
        if (expect > 0) {
            if (static_cast<int>(recvFds_.size()) < expect) {
                std::fprintf(stderr,
                    "[ipc] FrameReader: frame kind=%u expects %d fd(s), have %zu\n",
                    static_cast<unsigned>(kind), expect, recvFds_.size());
                std::abort();
            }
            for (int i = 0; i < expect; ++i) {
                fdsOut[i] = recvFds_.front();
                recvFds_.pop_front();
            }
            *nfdsOut = expect;
        } else {
            *nfdsOut = 0;
        }
        return true;
    }

    // Compat overload for readers that only ever receive Dawn (kind=0) frames
    // (e.g. the core's inbound GPU->core wire). A non-zero kind here is a
    // protocol bug -- the peer wrote a control frame on a direction that has no
    // dispatcher for it -- so surface it loudly rather than mis-handing the
    // payload to the wire decoder, which would manifest as Dawn parsing garbage.
    bool nextFrame(std::vector<uint8_t>& out) {
        FrameKind kind;
        if (!nextFrame(kind, out)) return false;
        if (kind != FrameKind::WireBytes) {
            std::fprintf(stderr,
                "[ipc] FrameReader: unexpected non-Dawn frame kind=%u on a "
                "wire-bytes-only direction\n", static_cast<unsigned>(kind));
            std::abort();
        }
        return true;
    }

    // Cumulative framed bytes yielded via nextFrame (header + payload). The
    // peer's FdSerializer counts the same units (kFrameHeaderBytes), so comparing
    // this against a wireSerial sent over the side channel tells us whether all
    // wire commands up to that serial have been handed to the wire server yet.
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
    std::deque<int> recvFds_;  // fds arriving via SCM_RIGHTS, FIFO with frames
};

// ---------------------------------------------------------------------------
// Control side channel (SOCK_SEQPACKET): fixed Message + optional SCM_RIGHTS.
// ---------------------------------------------------------------------------

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
