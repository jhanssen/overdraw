// Standalone verification of SCM_RIGHTS fd passing over the side-channel
// transport. Creates a SOCK_SEQPACKET pair (as the real ctrl socket uses),
// writes a marker into a memfd, sends it with a Message via sendMessageFds, and
// reads it back through the received fd with recvMessageNBFds.
//
// Exit 0 = pass.

#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/mman.h>

#include "transport.h"

using namespace overdraw::ipc;

int main() {
    int sv[2];
    if (::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) != 0) { std::perror("socketpair"); return 1; }

    const char marker[] = "SCM_RIGHTS_OK";
    int mfd = ::memfd_create("scm-test", 0);
    if (mfd < 0) { std::perror("memfd"); return 1; }
    if (::ftruncate(mfd, 4096) != 0) { std::perror("ftruncate"); return 1; }
    void* p = ::mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, mfd, 0);
    std::memcpy(p, marker, sizeof(marker));
    ::munmap(p, 4096);

    Message msg{};
    msg.tag = Tag::Hello;
    msg.width = 1234;
    int sendFds[1] = {mfd};
    if (!sendMessageFds(sv[0], msg, sendFds, 1)) { std::fprintf(stderr, "sendMessageFds failed\n"); return 1; }

    Message got{};
    int rfds[kMaxMsgFds];
    int nfds = -1;
    // Poll briefly (non-blocking recv).
    bool ok = false;
    for (int i = 0; i < 1000 && !ok; ++i) {
        if (recvMessageNBFds(sv[1], got, rfds, &nfds)) ok = true;
        else ::usleep(1000);
    }
    if (!ok) { std::fprintf(stderr, "recv failed\n"); return 1; }
    std::printf("recv: tag=%c width=%u nfds=%d\n", static_cast<char>(got.tag), got.width, nfds);
    if (nfds != 1) { std::fprintf(stderr, "expected 1 fd, got %d\n", nfds); return 1; }

    // Read the marker through the RECEIVED fd (different fd number, same file).
    char buf[32] = {0};
    if (::pread(rfds[0], buf, sizeof(buf) - 1, 0) <= 0) { std::perror("pread"); return 1; }
    std::printf("received fd %d (orig %d) reads: \"%s\"\n", rfds[0], mfd, buf);
    bool match = std::strncmp(buf, marker, sizeof(marker)) == 0;

    ::close(rfds[0]);
    ::close(mfd);
    ::close(sv[0]);
    ::close(sv[1]);
    std::printf(match ? "PASS\n" : "FAIL\n");
    return match ? 0 : 1;
}
