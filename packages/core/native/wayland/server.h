// Wayland server + generic protocol trampoline (core side).
//
// Stands up a libwayland-server display on a listening socket, integrated into
// the libuv loop that Node owns. Interfaces are registered at runtime from the
// generated signature metadata (no per-protocol C); incoming requests are
// decoded to a typed tuple and dispatched to JS handlers.
//
// This first slice exposes the server lifecycle + the libuv integration. Runtime
// interface registration and request dispatch build on top.

#ifndef OVERDRAW_WAYLAND_SERVER_H_
#define OVERDRAW_WAYLAND_SERVER_H_

#include <functional>
#include <memory>
#include <string>
#include <thread>

#include <uv.h>

struct wl_display;
struct wl_event_loop;

namespace overdraw::wayland {

class Server {
  public:
    Server() = default;
    ~Server();

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // Create the display, add a listening socket, and integrate the event loop
    // into `loop` (Node's libuv loop). Returns false on failure.
    bool start(uv_loop_t* loop);

    // The socket name clients connect to (WAYLAND_DISPLAY), e.g. "wayland-1".
    const std::string& socketName() const { return socketName_; }

    void stop();

    wl_display* display() const { return display_; }

    // Optional hook fired AFTER wl_event_loop_dispatch returns (i.e. after a
    // libwayland poll tick handled any incoming client requests). Used by the
    // addon's wake state machine to schedule a render when client activity
    // arrived. Calls happen on the Node main thread, synchronously, from
    // inside onLoopReadable.
    using PumpHook = std::function<void()>;
    void setOnPump(PumpHook cb) { onPump_ = std::move(cb); }

    // Drain pending wayland-server events synchronously (without blocking
    // libuv). Used by the frame-trigger path right before deciding what to
    // render: if a client commit arrived between the last server-pump and
    // the page-flip event we are now processing, drainEvents() pulls it in
    // so the upcoming dispatchFrameCallbacks sees the new callback.
    void drainEvents();

  private:
    static void onAsync(uv_async_t* handle);
    static void onPrepare(uv_prepare_t* handle);

    // Watcher-thread body: poll(2) on the wayland event-loop fd + the stop
    // eventfd; hand readiness to the main thread via async_ and wait for the
    // dispatch handshake. See the comment in start() for why uv_poll cannot
    // be used here (the fd is an epoll fd).
    void watchLoop();

    wl_display* display_ = nullptr;
    wl_event_loop* eventLoop_ = nullptr;
    std::string socketName_;

    PumpHook onPump_;

    int wlFd_ = -1;    // libwayland's event-loop epoll fd (owned by libwayland)
    int stopFd_ = -1;  // eventfd; written by stop() to end the watcher thread
    std::thread watcher_;
    uv_sem_t dispatchedSem_{};
    uv_async_t async_{};
    uv_prepare_t prepare_{};
    bool started_ = false;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_SERVER_H_
