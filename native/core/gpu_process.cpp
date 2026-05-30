#include "gpu_process.h"

#include <cstdio>

#include <fcntl.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

namespace overdraw::core {

GpuProcess spawnGpuProcess(const char* binPath) {
    GpuProcess out;
    int wireFds[2], ctrlFds[2];
    // Wire socket: STREAM (length-prefixed framing). Side channel: SEQPACKET so
    // fixed-size control messages keep their datagram boundaries.
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, wireFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ctrlFds)) {
        std::perror("socketpair");
        return out;
    }

    pid_t pid = ::fork();
    if (pid < 0) {
        std::perror("fork");
        return out;
    }
    if (pid == 0) {
        // Child: keep the GPU-side fds open across exec.
        ::fcntl(wireFds[1], F_SETFD, 0);
        ::fcntl(ctrlFds[1], F_SETFD, 0);
        char a1[16], a2[16];
        std::snprintf(a1, sizeof(a1), "%d", wireFds[1]);
        std::snprintf(a2, sizeof(a2), "%d", ctrlFds[1]);
        ::execl(binPath, binPath, a1, a2, static_cast<char*>(nullptr));
        ::perror("execl");
        _exit(127);
    }

    // Parent: keep the core-side fds, close the GPU-side ends.
    ::close(wireFds[1]);
    ::close(ctrlFds[1]);
    out.pid = pid;
    out.wireFd = wireFds[0];
    out.ctrlFd = ctrlFds[0];
    return out;
}

void reapGpuProcess(pid_t pid) {
    if (pid <= 0) return;
    int status = 0;
    for (int i = 0; i < 500; ++i) {  // ~0.5s grace for a clean exit
        if (::waitpid(pid, &status, WNOHANG) == pid) return;
        ::usleep(1000);
    }
    ::kill(pid, SIGTERM);
    ::waitpid(pid, &status, 0);
}

}  // namespace overdraw::core
