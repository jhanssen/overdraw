// Minimal fd-readiness event loop, abstracted so the Linux epoll backend can be
// swapped for a kqueue backend (BSD/macOS) later. The GPU process multiplexes
// its wire / control / input / host-Wayland fds through this. No platform
// headers leak through this interface.

#ifndef OVERDRAW_GPU_EVENT_LOOP_H_
#define OVERDRAW_GPU_EVENT_LOOP_H_

#include <cstdint>
#include <functional>
#include <memory>

namespace overdraw::gpu {

class EventLoop {
  public:
    enum Events : uint32_t { kRead = 1u, kWrite = 2u };

    // Called when a registered fd is ready; `ready` is a bitmask of Events.
    using Callback = std::function<void(uint32_t ready)>;

    // Build the platform loop (epoll on Linux, kqueue later). Null on failure.
    static std::unique_ptr<EventLoop> create();

    virtual ~EventLoop() = default;

    // Register / re-arm / drop interest. `events` is a bitmask of Events.
    virtual bool add(int fd, uint32_t events, Callback cb) = 0;
    virtual bool modify(int fd, uint32_t events) = 0;
    virtual bool remove(int fd) = 0;

    // Wait up to `timeoutMs` (-1 = forever) for readiness, dispatch callbacks for
    // every ready fd, then return. Returns false on a fatal loop error.
    virtual bool runOnce(int timeoutMs) = 0;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_EVENT_LOOP_H_
