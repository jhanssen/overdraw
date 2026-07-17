#include "server.h"

#include <cstdio>

#include <wayland-server-core.h>

namespace overdraw::wayland {

Server::~Server() { stop(); }

bool Server::start(uv_loop_t* loop) {
    if (started_) return true;

    display_ = wl_display_create();
    if (!display_) {
        std::fprintf(stderr, "[wl] wl_display_create failed\n");
        return false;
    }

    const char* sock = wl_display_add_socket_auto(display_);
    if (!sock) {
        std::fprintf(stderr, "[wl] add_socket_auto failed\n");
        wl_display_destroy(display_);
        display_ = nullptr;
        return false;
    }
    socketName_ = sock;

    // Per-client outgoing buffers grow on demand up to this cap (default is a
    // fixed 4 KiB). At the default, a client that stalls for a few hundred ms
    // while events stream at it (e.g. high-rate pointer motion) overflows and
    // gets disconnected; 1 MiB absorbs transient stalls.
    wl_display_set_default_max_buffer_size(display_, 1024 * 1024);

    eventLoop_ = wl_display_get_event_loop(display_);
    int fd = wl_event_loop_get_fd(eventLoop_);

    // libuv integration (architecture.md "frame pacing and threading"):
    //  - poll the event loop fd; on readable, dispatch.
    //  - flush clients before libuv blocks (prepare handle). Missing the
    //    pre-poll flush is the canonical cause of stalled Wayland clients.
    poll_.data = this;
    if (uv_poll_init(loop, &poll_, fd) != 0) {
        std::fprintf(stderr, "[wl] uv_poll_init failed\n");
        wl_display_destroy(display_);
        display_ = nullptr;
        eventLoop_ = nullptr;
        return false;
    }
    uv_poll_start(&poll_, UV_READABLE, onLoopReadable);

    prepare_.data = this;
    uv_prepare_init(loop, &prepare_);
    uv_prepare_start(&prepare_, onPrepare);

    started_ = true;
    std::printf("[wl] server up on %s\n", socketName_.c_str());
    return true;
}

void Server::onLoopReadable(uv_poll_t* handle, int status, int) {
    // A negative status means libuv disarmed this watcher (e.g. POLLERR ->
    // UV_EBADF); swallowing it turns a reported failure into a silent
    // permanent stall of all client dispatch. Shout instead.
    if (status < 0) {
        std::fprintf(stderr, "[wl] uv_poll on wayland loop fd died: %s\n",
                     uv_strerror(status));
        return;
    }
    auto* self = static_cast<Server*>(handle->data);
    const auto body = [self] {
        wl_event_loop_dispatch(self->eventLoop_, 0);
        wl_display_flush_clients(self->display_);
        if (self->onPump_) self->onPump_();
    };
    if (self->dispatchScope_) self->dispatchScope_(body);
    else body();
}

void Server::drainEvents() {
    if (!eventLoop_) return;
    wl_event_loop_dispatch(eventLoop_, 0);  // 0 = non-blocking
    wl_display_flush_clients(display_);
}

void Server::onPrepare(uv_prepare_t* handle) {
    auto* self = static_cast<Server*>(handle->data);
    wl_display_flush_clients(self->display_);
}

void Server::stop() {
    if (!started_) return;
    started_ = false;
    uv_poll_stop(&poll_);
    uv_prepare_stop(&prepare_);
    // Track close completion via a counter the callbacks decrement. uv_close
    // is asynchronous: libuv runs the close callback on the NEXT loop tick.
    // The Server's memory (including the uv handles) is freed by the
    // destructor immediately after stop() returns, so we must not return
    // until libuv has fully closed both handles -- otherwise libuv's
    // pending-close list ends up with a stale pointer and trips its
    // UV_HANDLE_CLOSING assertion on the next teardown sweep.
    int pending = 2;
    poll_.data    = &pending;
    prepare_.data = &pending;
    uv_close(reinterpret_cast<uv_handle_t*>(&poll_),
             [](uv_handle_t* h) { --*static_cast<int*>(h->data); });
    uv_close(reinterpret_cast<uv_handle_t*>(&prepare_),
             [](uv_handle_t* h) { --*static_cast<int*>(h->data); });
    uv_loop_t* loop = poll_.loop;
    while (pending > 0) uv_run(loop, UV_RUN_NOWAIT);
    if (display_) {
        wl_display_destroy(display_);
        display_ = nullptr;
    }
}

}  // namespace overdraw::wayland
