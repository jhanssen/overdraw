#include "gpu_process.h"

#include <cstdint>
#include <cstdio>
#include <cstring>

#include <fcntl.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

namespace overdraw::core {

GpuProcess spawnGpuProcess(const char* binPath, uint32_t headlessW, uint32_t headlessH,
                           OutputBackendKind output) {
    GpuProcess out;
    const bool headless = headlessW != 0 && headlessH != 0;
    int wireFds[2], ctrlFds[2], inputFds[2], logFds[2];
    // Wire socket: STREAM (length-prefixed framing). Control + input channels:
    // SEQPACKET so fixed-size messages keep their datagram boundaries. Input is
    // a separate socket (GPU process -> core, one-way) so unsolicited input
    // events never interleave with control request/reply traffic on ctrlFd.
    // Log: SEQPACKET, one-way (GPU process -> core); separated from ctrl so
    // log bursts cannot delay control messages and the log frame can carry
    // variable-length payload (fragmented across multiple datagrams).
    if (::socketpair(AF_UNIX, SOCK_STREAM, 0, wireFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, ctrlFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, inputFds) ||
        ::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, logFds)) {
        std::perror("socketpair");
        return out;
    }

    // Enlarge the kernel socket buffers on the high-volume wire socket (both
    // ends) so the OS keeps draining our queued bytes while we are busy with
    // other work, rather than filling quickly and forcing an EAGAIN / wait for
    // writable. We still buffer in userspace (the kernel buffer can always
    // fill under enough load); this just makes that rarer. Best-effort: the
    // kernel clamps to net.core.wmem_max/rmem_max, so failures are non-fatal.
    const int wireBuf = 8 * 1024 * 1024;
    for (int i = 0; i < 2; ++i) {
        ::setsockopt(wireFds[i], SOL_SOCKET, SO_SNDBUF, &wireBuf, sizeof(wireBuf));
        ::setsockopt(wireFds[i], SOL_SOCKET, SO_RCVBUF, &wireBuf, sizeof(wireBuf));
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
        ::fcntl(logFds[1], F_SETFD, 0);
        // The parent runtime marks stdout/stderr close-on-exec; clear it so the
        // GPU process's diagnostics reach the same destination as the core's.
        // Otherwise these fds close at exec and the first device the Vulkan
        // driver opens reuses fd 1/2, silently swallowing all GPU-side output.
        ::fcntl(STDOUT_FILENO, F_SETFD, 0);
        ::fcntl(STDERR_FILENO, F_SETFD, 0);
        char a1[16], a2[16], a3[16], a4[32], asize[32];
        std::snprintf(a1, sizeof(a1), "%d", wireFds[1]);
        std::snprintf(a2, sizeof(a2), "%d", ctrlFds[1]);
        std::snprintf(a3, sizeof(a3), "%d", inputFds[1]);
        std::snprintf(a4, sizeof(a4), "--log-fd=%d", logFds[1]);
        // Output-backend argv flag: only meaningful in non-headless mode (headless
        // has no output backend at all). Pass it explicitly so the child does not
        // have to infer from environment.
        const char* outputArg = output == OutputBackendKind::Kms
            ? "--output=kms" : "--output=nested";
        if (headless) {
            std::snprintf(asize, sizeof(asize), "%ux%u", headlessW, headlessH);
            ::execl(binPath, binPath, a1, a2, a3, a4, "--headless", asize,
                    static_cast<char*>(nullptr));
        } else {
            ::execl(binPath, binPath, a1, a2, a3, a4, outputArg,
                    static_cast<char*>(nullptr));
        }
        ::perror("execl");
        _exit(127);
    }

    // Parent: keep the core-side fds, close the GPU-side ends.
    ::close(wireFds[1]);
    ::close(ctrlFds[1]);
    ::close(inputFds[1]);
    ::close(logFds[1]);
    out.pid = pid;
    out.wireFd = wireFds[0];
    out.ctrlFd = ctrlFds[0];
    out.inputFd = inputFds[0];
    out.logFd = logFds[0];
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
