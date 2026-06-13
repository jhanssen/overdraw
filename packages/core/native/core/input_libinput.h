// Phase-2 bare-metal input backend.
//
// Reads events from /dev/input/event* via libinput, with device fds opened
// through libseat. Emits the same normalized core::InputEvent stream the
// WaylandInputBackend emits, so the seat/focus/wl_seat layer above is
// unchanged.
//
// libinput exposes one pollable fd per context. The addon registers a uv_poll
// on it and calls drain() on UV_READABLE; drain() calls libinput_dispatch and
// then loops on libinput_get_event, converting each event to an InputEvent.
//
// Pointer position is accumulated from relative motion deltas (libinput's
// LIBINPUT_EVENT_POINTER_MOTION) into output-space coordinates. Touchpads in
// absolute mode and tablets are not supported in v1 (LIBINPUT_EVENT_POINTER_
// MOTION_ABSOLUTE is dropped). Scroll is reported via the legacy
// LIBINPUT_EVENT_POINTER_AXIS path (broadest compat); the newer v120 scroll
// events are not used in v1.

#ifndef OVERDRAW_CORE_INPUT_LIBINPUT_H_
#define OVERDRAW_CORE_INPUT_LIBINPUT_H_

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "input.h"

struct libinput;
struct libinput_event;
struct udev;

namespace overdraw::core {

class Seat;

class LibinputBackend : public InputBackend {
  public:
    // The backend borrows `seat`; the caller must keep it alive for the
    // backend's lifetime. `width`/`height` are the initial output logical
    // size used to clamp the accumulated cursor position. `seatName` is the
    // libseat seat name (e.g. "seat0"); libinput needs it via
    // libinput_udev_assign_seat.
    LibinputBackend(Seat& seat, std::string seatName, uint32_t width, uint32_t height);
    ~LibinputBackend() override;

    LibinputBackend(const LibinputBackend&) = delete;
    LibinputBackend& operator=(const LibinputBackend&) = delete;

    // Bring up libinput. Returns false on failure; error() carries a
    // description.
    bool init();

    void start(InputSink* sink) override { sink_ = sink; }
    void stop() override { sink_ = nullptr; }
    int pollFd() const override;
    void drain() override;

    // Update the output logical size used for cursor clamping (resize).
    void setOutputSize(uint32_t width, uint32_t height) override {
        width_ = width; height_ = height;
    }

    const std::string& error() const { return error_; }

  private:
    // libinput interface trampolines: open_restricted opens via the seat,
    // close_restricted releases.
    static int openRestricted_(const char* path, int flags, void* userdata);
    static void closeRestricted_(int fd, void* userdata);

    void dispatchEvent(libinput_event* ev);

    Seat&        seat_;
    std::string  seatName_;
    uint32_t     width_  = 0;
    uint32_t     height_ = 0;

    // Cursor position accumulator (output-space logical pixels).
    double       cursorX_ = 0.0;
    double       cursorY_ = 0.0;

    struct udev*     udev_ = nullptr;
    struct libinput* li_   = nullptr;

    InputSink*   sink_ = nullptr;
    std::string  error_;

    // Track libseat deviceIds for fds we've opened, so close_restricted can
    // release the right id. Keyed by fd. Small map (one entry per input
    // device); a flat vector is plenty.
    struct DevEntry { int fd; int deviceId; };
    std::vector<DevEntry> devices_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_INPUT_LIBINPUT_H_
