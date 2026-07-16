#include "server.h"

#include <cstdio>

#include <poll.h>
#include <sys/eventfd.h>
#include <unistd.h>

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
    wlFd_ = wl_event_loop_get_fd(eventLoop_);

    // libuv integration (architecture.md "frame pacing and threading"):
    //
    // wlFd_ is an EPOLL fd (libwayland's internal event loop). It must NOT be
    // watched with uv_poll: libuv's poll path mis-handles epoll fds (observed
    // with libuv 1.52: the watcher delivers one event and then goes
    // permanently deaf), which starves all client dispatch whenever nothing
    // else wakes the loop. Instead, a dedicated watcher thread blocks in
    // plain poll(2) on wlFd_ and kicks a uv_async into the Node loop; the
    // async callback dispatches on the main thread, then releases the
    // watcher to poll again. The ping-pong (dispatchedSem_) means the thread
    // never spins on readiness the main thread hasn't consumed yet, and
    // level-triggered poll(2) re-reports anything left undrained.
    //
    // Client-bound events are flushed before libuv blocks (prepare handle);
    // missing the pre-poll flush is the canonical cause of stalled clients.
    async_.data = this;
    if (uv_async_init(loop, &async_, onAsync) != 0) {
        std::fprintf(stderr, "[wl] uv_async_init failed\n");
        wl_display_destroy(display_);
        display_ = nullptr;
        eventLoop_ = nullptr;
        return false;
    }
    stopFd_ = ::eventfd(0, EFD_CLOEXEC);
    if (stopFd_ < 0) {
        std::perror("[wl] eventfd");
        uv_close(reinterpret_cast<uv_handle_t*>(&async_), nullptr);
        wl_display_destroy(display_);
        display_ = nullptr;
        eventLoop_ = nullptr;
        return false;
    }
    uv_sem_init(&dispatchedSem_, 0);
    watcher_ = std::thread([this] { watchLoop(); });

    prepare_.data = this;
    uv_prepare_init(loop, &prepare_);
    uv_prepare_start(&prepare_, onPrepare);

    started_ = true;
    std::printf("[wl] server up on %s\n", socketName_.c_str());
    return true;
}

// Watcher thread: block until the wayland event loop has work (or stop is
// signalled), hand off to the main thread, wait for it to dispatch, repeat.
void Server::watchLoop() {
    for (;;) {
        pollfd fds[2] = {
            { wlFd_, POLLIN, 0 },
            { stopFd_, POLLIN, 0 },
        };
        const int r = ::poll(fds, 2, -1);
        if (r < 0) {
            if (errno == EINTR) continue;
            return;
        }
        if (fds[1].revents) return;  // stop() signalled
        if (!(fds[0].revents & (POLLIN | POLLERR | POLLHUP))) continue;
        uv_async_send(&async_);
        // Wait until the main thread has dispatched before polling again;
        // without this the level-triggered poll would spin until the main
        // thread gets scheduled.
        uv_sem_wait(&dispatchedSem_);
    }
}

void Server::onAsync(uv_async_t* handle) {
    auto* self = static_cast<Server*>(handle->data);
    const auto body = [self] {
        wl_event_loop_dispatch(self->eventLoop_, 0);
        wl_display_flush_clients(self->display_);
        if (self->onPump_) self->onPump_();
    };
    if (self->dispatchScope_) self->dispatchScope_(body);
    else body();
    uv_sem_post(&self->dispatchedSem_);
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

    // Stop the watcher thread first: signal the stop eventfd and release any
    // pending handoff wait so poll()/sem_wait can't deadlock the join.
    const uint64_t one = 1;
    if (::write(stopFd_, &one, sizeof(one)) < 0) { /* best-effort */ }
    uv_sem_post(&dispatchedSem_);
    if (watcher_.joinable()) watcher_.join();
    ::close(stopFd_);
    stopFd_ = -1;
    uv_sem_destroy(&dispatchedSem_);

    uv_prepare_stop(&prepare_);
    // Track close completion via a counter the callbacks decrement. uv_close
    // is asynchronous: libuv runs the close callback on the NEXT loop tick.
    // The Server's memory (including the uv handles) is freed by the
    // destructor immediately after stop() returns, so we must not return
    // until libuv has fully closed both handles -- otherwise libuv's
    // pending-close list ends up with a stale pointer and trips its
    // UV_HANDLE_CLOSING assertion on the next teardown sweep.
    int pending = 2;
    async_.data   = &pending;
    prepare_.data = &pending;
    uv_close(reinterpret_cast<uv_handle_t*>(&async_),
             [](uv_handle_t* h) { --*static_cast<int*>(h->data); });
    uv_close(reinterpret_cast<uv_handle_t*>(&prepare_),
             [](uv_handle_t* h) { --*static_cast<int*>(h->data); });
    uv_loop_t* loop = prepare_.loop;
    while (pending > 0) uv_run(loop, UV_RUN_NOWAIT);
    if (display_) {
        wl_display_destroy(display_);
        display_ = nullptr;
    }
}

}  // namespace overdraw::wayland
