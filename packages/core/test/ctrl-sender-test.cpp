// CtrlSender wedge-resistance test.
//
// The pair sender/receiver is a non-blocking SOCK_SEQPACKET socket pair. The
// receiver intentionally never reads. After enough sends the kernel's send
// buffer is full and a raw sendmsg would EAGAIN; the contract of CtrlSender is
// that send() returns true (queued) and never blocks. Drain the receiver and
// assert pumpOut() empties the queue.
//
// Exit 0 = pass.

#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>

#include "transport.h"

using namespace overdraw::ipc;

int main() {
    int sv[2];
    if (::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) != 0) { std::perror("socketpair"); return 1; }
    if (!setNonBlocking(sv[0])) { std::fprintf(stderr, "setNonBlocking failed\n"); return 1; }

    CtrlSender sender(sv[0]);

    // 1) Steady-state: a send to a peer that IS draining succeeds immediately
    //    and leaves no queue (the common path).
    Message m{};
    m.tag = Tag::Hello;
    m.width = 42;
    if (!sender.send(m)) { std::fprintf(stderr, "first send failed\n"); return 1; }
    if (sender.hasPendingOut()) { std::fprintf(stderr, "queue not empty after fresh send\n"); return 1; }
    Message got{};
    if (!recvMessageNB(sv[1], got) || got.width != 42) {
        std::fprintf(stderr, "fresh-send recv mismatch\n"); return 1;
    }
    std::printf("steady-state send OK\n");

    // 2) Backpressure: keep sending without draining sv[1]. The kernel buffer
    //    is small (per-SEQPACKET datagram, default ~200KB / msg) -- a handful
    //    of fixed-size Messages must fill it. Eventually trySend returns 0
    //    (EAGAIN) and the message is enqueued.
    int sent = 0;
    while (sent < 200000) {
        Message q{};
        q.tag = Tag::Hello;
        q.width = static_cast<uint32_t>(sent);
        if (!sender.send(q)) { std::fprintf(stderr, "send returned fatal\n"); return 1; }
        ++sent;
        if (sender.hasPendingOut()) break;
    }
    if (!sender.hasPendingOut()) {
        std::fprintf(stderr, "never built backpressure after %d sends\n", sent);
        return 1;
    }
    std::printf("backpressure built after %d sends; queue non-empty\n", sent);

    // 3) Drain the receiver; pumpOut must empty the queue.
    Message tmp{};
    int drained = 0;
    while (recvMessageNB(sv[1], tmp)) ++drained;
    std::printf("drained %d messages from peer\n", drained);

    // pumpOut may need several iterations as we re-drain (the queue size > one
    // kernel buffer's worth). Loop until empty or progress stalls.
    int iter = 0;
    while (sender.hasPendingOut() && iter < 1000) {
        if (!sender.pumpOut()) { std::fprintf(stderr, "pumpOut fatal\n"); return 1; }
        // Drain the peer between pumps so the kernel buffer reopens.
        while (recvMessageNB(sv[1], tmp)) {}
        ++iter;
    }
    if (sender.hasPendingOut()) {
        std::fprintf(stderr, "queue still non-empty after %d pumps\n", iter);
        return 1;
    }
    std::printf("pumpOut drained the queue in %d iterations\n", iter);

    ::close(sv[0]);
    ::close(sv[1]);
    std::printf("PASS\n");
    return 0;
}
