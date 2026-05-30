// GPU-process lifecycle: fork/exec the native GPU process with inherited wire +
// side-channel sockets, and tear it down (signal, reap, SIGTERM fallback).

#ifndef OVERDRAW_CORE_GPU_PROCESS_H_
#define OVERDRAW_CORE_GPU_PROCESS_H_

#include <sys/types.h>

namespace overdraw::core {

struct GpuProcess {
    pid_t pid = -1;
    int wireFd = -1;   // core-side end of the Dawn wire socket
    int ctrlFd = -1;   // core-side end of the side-channel socket
};

// Creates the socket pairs, forks/execs `binPath`, and returns the core-side
// fds. On failure pid < 0 and the message is written to stderr.
GpuProcess spawnGpuProcess(const char* binPath);

// Reap the GPU process: poll briefly for a clean exit, then SIGTERM + wait.
void reapGpuProcess(pid_t pid);

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_GPU_PROCESS_H_
