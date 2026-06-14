#include "seat.h"

// libseat.h lacks extern "C" guards; wrap it ourselves so the C++ caller links
// against the C ABI symbols.
extern "C" {
#include <libseat.h>
}

#include <cerrno>
#include <cstring>

namespace overdraw::core {

Seat::~Seat() { close(); }

void Seat::onEnable_(struct libseat* /*ls*/, void* userdata) {
    auto* self = static_cast<Seat*>(userdata);
    self->active_ = true;
    if (self->onEnable_cb_) self->onEnable_cb_();
}

void Seat::onDisable_(struct libseat* /*ls*/, void* userdata) {
    auto* self = static_cast<Seat*>(userdata);
    self->active_ = false;
    if (self->onDisable_cb_) self->onDisable_cb_();
    // The caller's onDisable callback is responsible for tearing down device
    // usage and calling ackDisable(); we do not ack here so the caller's
    // teardown completes before the seat provider proceeds.
}

bool Seat::open(StateCb onEnable, StateCb onDisable) {
    if (seat_) {
        error_ = "seat already open";
        return false;
    }
    onEnable_cb_  = std::move(onEnable);
    onDisable_cb_ = std::move(onDisable);

    static const struct libseat_seat_listener kListener = {
        .enable_seat  = &Seat::onEnable_,
        .disable_seat = &Seat::onDisable_,
    };
    seat_ = libseat_open_seat(&kListener, this);
    if (!seat_) {
        error_ = std::string("libseat_open_seat failed: ") + std::strerror(errno);
        return false;
    }
    // libseat fires enable_seat synchronously during open if the session is
    // already active; active_ is set in the trampoline.
    return true;
}

void Seat::close() {
    if (!seat_) return;
    libseat_close_seat(seat_);
    seat_ = nullptr;
    active_ = false;
}

int Seat::pollFd() const {
    if (!seat_) return -1;
    return libseat_get_fd(seat_);
}

bool Seat::dispatch() {
    if (!seat_) return false;
    int n = libseat_dispatch(seat_, 0);
    if (n < 0) {
        error_ = std::string("libseat_dispatch failed: ") + std::strerror(errno);
        return false;
    }
    return true;
}

void Seat::ackDisable() {
    if (!seat_) return;
    libseat_disable_seat(seat_);
}

void Seat::setCallbacks(StateCb onEnable, StateCb onDisable) {
    onEnable_cb_  = std::move(onEnable);
    onDisable_cb_ = std::move(onDisable);
}

bool Seat::switchSession(int n) {
    if (!seat_) return false;
    return libseat_switch_session(seat_, n) == 0;
}

bool Seat::openDevice(const char* path, int& outFd, int& outDeviceId) {
    if (!seat_) {
        error_ = "seat not open";
        return false;
    }
    if (!active_) {
        error_ = "seat not active";
        return false;
    }
    int fd = -1;
    int id = libseat_open_device(seat_, path, &fd);
    if (id < 0) {
        error_ = std::string("libseat_open_device(") + path + ") failed: " + std::strerror(errno);
        return false;
    }
    outFd       = fd;
    outDeviceId = id;
    return true;
}

bool Seat::closeDevice(int deviceId) {
    if (!seat_) {
        error_ = "seat not open";
        return false;
    }
    if (libseat_close_device(seat_, deviceId) < 0) {
        error_ = std::string("libseat_close_device failed: ") + std::strerror(errno);
        return false;
    }
    return true;
}

std::string Seat::name() const {
    if (!seat_) return {};
    const char* n = libseat_seat_name(seat_);
    return n ? std::string(n) : std::string();
}

}  // namespace overdraw::core
