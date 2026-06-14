// GPU-process lifecycle: fork/exec the native GPU process with inherited wire +
// side-channel sockets, and tear it down (signal, reap, SIGTERM fallback).

#ifndef OVERDRAW_CORE_GPU_PROCESS_H_
#define OVERDRAW_CORE_GPU_PROCESS_H_

#include <cstdint>
#include <sys/types.h>

namespace overdraw::core {

struct GpuProcess {
    pid_t pid = -1;
    int wireFd = -1;    // core-side end of the Dawn wire socket
    int ctrlFd = -1;    // core-side end of the control side-channel socket
    int inputFd = -1;   // core-side end of the input socket (GPU process -> core)
};

// Output backend selection passed to the GPU process via argv.
enum class OutputBackendKind {
    Nested = 0,  // host Wayland (HostWindowOutputBackend); the default
    Kms    = 1,  // bare-metal DRM/KMS (KmsOutputBackend); core sends DRM fd via ctrl SetDrmFd
};

// Creates the socket pairs, forks/execs `binPath`, and returns the core-side
// fds. On failure pid < 0 and the message is written to stderr. When
// `headlessW`/`headlessH` are nonzero, the GPU process is launched in headless
// mode (no host window/surface) at that size via "--headless WxH"; that case
// ignores `output` (headless has no output backend at all). Otherwise the
// child receives "--output=kms" or "--output=nested" (default nested).
GpuProcess spawnGpuProcess(const char* binPath,
                           uint32_t headlessW = 0, uint32_t headlessH = 0,
                           OutputBackendKind output = OutputBackendKind::Nested);

// Reap the GPU process: poll briefly for a clean exit, then SIGTERM + wait.
void reapGpuProcess(pid_t pid);

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_GPU_PROCESS_H_
