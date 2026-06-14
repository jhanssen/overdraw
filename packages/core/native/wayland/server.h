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
    static void onLoopReadable(uv_poll_t* handle, int status, int events);
    static void onPrepare(uv_prepare_t* handle);

    wl_display* display_ = nullptr;
    wl_event_loop* eventLoop_ = nullptr;
    std::string socketName_;

    PumpHook onPump_;

    uv_poll_t poll_{};
    uv_prepare_t prepare_{};
    bool started_ = false;
};

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_SERVER_H_
