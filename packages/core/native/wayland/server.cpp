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

    eventLoop_ = wl_display_get_event_loop(display_);
    int fd = wl_event_loop_get_fd(eventLoop_);

    // libuv integration (architecture.md "frame pacing and threading"):
    //  - poll the event loop fd; on readable, dispatch.
    //  - flush clients before libuv blocks (prepare handle). Missing the
    //    pre-poll flush is the canonical cause of stalled Wayland clients.
    poll_.data = this;
    uv_poll_init(loop, &poll_, fd);
    uv_poll_start(&poll_, UV_READABLE, onLoopReadable);

    prepare_.data = this;
    uv_prepare_init(loop, &prepare_);
    uv_prepare_start(&prepare_, onPrepare);

    started_ = true;
    std::printf("[wl] server up on %s\n", socketName_.c_str());
    return true;
}

void Server::onLoopReadable(uv_poll_t* handle, int status, int) {
    if (status < 0) return;
    auto* self = static_cast<Server*>(handle->data);
    wl_event_loop_dispatch(self->eventLoop_, 0);
    wl_display_flush_clients(self->display_);
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
    uv_close(reinterpret_cast<uv_handle_t*>(&poll_), nullptr);
    uv_close(reinterpret_cast<uv_handle_t*>(&prepare_), nullptr);
    if (display_) {
        wl_display_destroy(display_);
        display_ = nullptr;
    }
}

}  // namespace overdraw::wayland
