// Linux epoll backend for EventLoop. A kqueue backend would implement the same
// EventLoop interface in a sibling file selected by the build.

#include "event_loop.h"

#include <cerrno>
#include <cstdio>
#include <unordered_map>
#include <vector>

#include <unistd.h>
#include <sys/epoll.h>

namespace overdraw::gpu {
namespace {

uint32_t toEpoll(uint32_t events) {
    uint32_t e = 0;
    if (events & EventLoop::kRead) e |= EPOLLIN;
    if (events & EventLoop::kWrite) e |= EPOLLOUT;
    return e;
}

uint32_t fromEpoll(uint32_t ev) {
    uint32_t e = 0;
    if (ev & (EPOLLIN | EPOLLHUP | EPOLLERR)) e |= EventLoop::kRead;
    if (ev & EPOLLOUT) e |= EventLoop::kWrite;
    return e;
}

class EpollLoop final : public EventLoop {
  public:
    bool init() {
        epfd_ = ::epoll_create1(EPOLL_CLOEXEC);
        return epfd_ >= 0;
    }
    ~EpollLoop() override { if (epfd_ >= 0) ::close(epfd_); }

    bool add(int fd, uint32_t events, Callback cb) override {
        epoll_event ee{};
        ee.events = toEpoll(events);
        ee.data.fd = fd;
        if (::epoll_ctl(epfd_, EPOLL_CTL_ADD, fd, &ee) != 0) {
            std::perror("[gpu] epoll_ctl add");
            return false;
        }
        cbs_[fd] = std::move(cb);
        return true;
    }

    bool modify(int fd, uint32_t events) override {
        epoll_event ee{};
        ee.events = toEpoll(events);
        ee.data.fd = fd;
        return ::epoll_ctl(epfd_, EPOLL_CTL_MOD, fd, &ee) == 0;
    }

    bool remove(int fd) override {
        cbs_.erase(fd);
        return ::epoll_ctl(epfd_, EPOLL_CTL_DEL, fd, nullptr) == 0;
    }

    bool runOnce(int timeoutMs) override {
        epoll_event evs[16];
        int n = ::epoll_wait(epfd_, evs, 16, timeoutMs);
        if (n < 0) {
            if (errno == EINTR) return true;
            std::perror("[gpu] epoll_wait");
            return false;
        }
        for (int i = 0; i < n; ++i) {
            auto it = cbs_.find(evs[i].data.fd);
            if (it != cbs_.end()) it->second(fromEpoll(evs[i].events));
        }
        return true;
    }

  private:
    int epfd_ = -1;
    std::unordered_map<int, Callback> cbs_;
};

}  // namespace

std::unique_ptr<EventLoop> EventLoop::create() {
    auto loop = std::make_unique<EpollLoop>();
    if (!loop->init()) return nullptr;
    return loop;
}

}  // namespace overdraw::gpu
