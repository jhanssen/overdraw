#include "gpu_process.h"

#include <cstdio>

#include <fcntl.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

namespace overdraw::core {

GpuProcess spawnGpuProcess(const char* binPath) {
    GpuProcess out;
    int wireFds[2], ctrlFds[2], inputFds[2];
    // Wire socket: STREAM (length-prefixed framing). Control + input channels:
    // SEQPACKET so fixed-size messages keep their datagram boundaries. Input is
    // a separate socket (GPU process -> core, one-way) so unsolicited input
    // events never interleave with control request/reply traffic on ctrlFd.
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, wireFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ctrlFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, inputFds)) {
        std::perror("socketpair");
        return out;
    }

    const pid_t parentPid = ::getpid();  // for the child's fork-race death check
    pid_t pid = ::fork();
    if (pid < 0) {
        std::perror("fork");
        return out;
    }
    if (pid == 0) {
        // Child: die if the core (our parent) dies, even by crash/SIGKILL, so a
        // GPU process is never orphaned holding the host window + GPU. PDEATHSIG
        // survives execve. Guard the fork-vs-parent-death race: if the parent
        // already exited before we set this, getppid() is no longer the core
        // (reparented to init/pid 1), so exit now.
        ::prctl(PR_SET_PDEATHSIG, SIGKILL);
        if (::getppid() != parentPid) _exit(0);
        // Child: keep the GPU-side fds open across exec.
        ::fcntl(wireFds[1], F_SETFD, 0);
        ::fcntl(ctrlFds[1], F_SETFD, 0);
        ::fcntl(inputFds[1], F_SETFD, 0);
        char a1[16], a2[16], a3[16];
        std::snprintf(a1, sizeof(a1), "%d", wireFds[1]);
        std::snprintf(a2, sizeof(a2), "%d", ctrlFds[1]);
        std::snprintf(a3, sizeof(a3), "%d", inputFds[1]);
        ::execl(binPath, binPath, a1, a2, a3, static_cast<char*>(nullptr));
        ::perror("execl");
        _exit(127);
    }

    // Parent: keep the core-side fds, close the GPU-side ends.
    ::close(wireFds[1]);
    ::close(ctrlFds[1]);
    ::close(inputFds[1]);
    out.pid = pid;
    out.wireFd = wireFds[0];
    out.ctrlFd = ctrlFds[0];
    out.inputFd = inputFds[0];
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
