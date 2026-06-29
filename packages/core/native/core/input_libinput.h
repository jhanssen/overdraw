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

    // VT-switch lifecycle. On suspend(): tell libinput to release all device
    // fds; libinput then asks our close_restricted trampoline (which calls
    // seat->closeDevice). After this no more events flow until resume().
    // On resume(): libinput re-opens devices through open_restricted (which
    // calls seat->openDevice -- libseat hands us fresh fds now that the seat
    // is active again). Both are idempotent. Called from the addon's Seat
    // enable/disable callbacks.
    void suspend();
    void resume();

    // Update the multi-output layout used for cursor clamping. If the
    // current cursor position is no longer inside any output, snaps it
    // into the first output's center (reseat) so subsequent motion has
    // a valid starting invariant.
    void setOutputLayout(const std::vector<OutputRect>& outputs) override;

    void setPointerLocked(bool locked) override { pointerLocked_ = locked; }

    void setPointerConfine(const std::vector<OutputRect>& rects) override { confineRects_ = rects; }

    const std::string& error() const { return error_; }

  private:
    // libinput interface trampolines: open_restricted opens via the seat,
    // close_restricted releases.
    static int openRestricted_(const char* path, int flags, void* userdata);
    static void closeRestricted_(int fd, void* userdata);

    void dispatchEvent(libinput_event* ev);
    // Emit a scroll group (axis_source, per-axis value [+ value120 for the
    // wheel source], axis_stop on a 0-value finger/continuous gesture, frame)
    // from a modern libinput SCROLL_* event. `source` is the wl_pointer
    // .axis_source enum; `hasV120` selects the wheel high-resolution path.
    void emitScroll(libinput_event* ev, uint32_t source, bool hasV120);

    Seat&        seat_;
    std::string  seatName_;
    // Output rects in global logical space. The cursor must always lie
    // inside the union of these rects; relative motion is clamped against
    // them with edge-sliding through gaps. Initial layout is a single
    // {0, 0, width, height} so the cursor starts at the center.
    std::vector<OutputRect> outputs_;

    // Cursor position accumulator (global logical pixels).
    double       cursorX_ = 0.0;
    double       cursorY_ = 0.0;

    // While true (an active zwp_locked_pointer_v1), the accumulator is frozen:
    // motion events still carry relative deltas but the cursor does not move.
    bool         pointerLocked_ = false;

    // Non-empty for an active zwp_confined_pointer_v1: the cursor is clamped to
    // the union of these rects instead of the full output union.
    std::vector<OutputRect> confineRects_;

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
