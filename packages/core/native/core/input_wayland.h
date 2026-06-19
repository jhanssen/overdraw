// Phase-1 nested input backend.
//
// Reads ipc::InputMessage events forwarded by the GPU process over the input
// socket and emits normalized core::InputEvents. Host pointer positions are
// surface-local wl_fixed_t (24.8); this backend converts them to OUTPUT-space
// logical pixels. In phase 1 the output's logical size equals the host window
// size (scale 1, no resize handling yet), so the mapping is currently identity
// on the integer part. setOutputSize() exists so resize handling can update it
// without touching the seam.
//
// Keyboard codes and modifier masks are forwarded unchanged (raw evdev / host
// masks); keysym/modifier resolution belongs to the seat layer above.

#ifndef OVERDRAW_CORE_INPUT_WAYLAND_H_
#define OVERDRAW_CORE_INPUT_WAYLAND_H_

#include <cstdint>

#include "input.h"

namespace overdraw::ipc { struct InputMessage; }

namespace overdraw::core {

class WaylandInputBackend : public InputBackend {
  public:
    // `inputFd` is the core-side end of the input socket (owned by the caller;
    // this class does not close it). `width`/`height` are the output's current
    // logical size, used to map surface-local positions.
    WaylandInputBackend(int inputFd, uint32_t width, uint32_t height)
        : inputFd_(inputFd), width_(width), height_(height) {}

    void start(InputSink* sink) override { sink_ = sink; }
    void stop() override { sink_ = nullptr; }
    int pollFd() const override { return inputFd_; }
    void drain() override;

    // The wayland backend forwards already-mapped coordinates (the GPU
    // process maps host-surface-local to output space before sending),
    // so layout is ignored here. Stub for the InputBackend interface.
    void setOutputLayout(const std::vector<OutputRect>& outputs) override {
        (void)outputs;
    }

    // Test seam: feed a forwarded InputMessage through the SAME conversion path
    // drain() uses, emitting the resulting InputEvent to the sink. This exercises
    // the normalization layer (fixed-point -> output space, evdev codes, state/
    // axis enums) that injecting a pre-normalized InputEvent would bypass. The
    // only part of the real host path not covered is the GPU process's host
    // wl_seat listener + socket send, which need a real host device to drive.
    void injectMessage(const ipc::InputMessage& m);

  private:
    bool convert(const ipc::InputMessage& m, InputEvent& ev) const;

    int inputFd_;
    uint32_t width_;
    uint32_t height_;
    InputSink* sink_ = nullptr;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_INPUT_WAYLAND_H_
