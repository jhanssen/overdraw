// Host Wayland output backend (phase 1, nested mode).
//
// Wraps HostWindow behind the OutputBackend interface. The GPU process is
// the Wayland client of the host compositor here; the host's wl_surface is
// the scanout target, driven by Dawn's WSI swapchain.

#ifndef OVERDRAW_GPU_OUTPUT_HOST_WINDOW_H_
#define OVERDRAW_GPU_OUTPUT_HOST_WINDOW_H_

#include <memory>

#include "host_window.h"
#include "output_backend.h"

namespace overdraw::gpu {

class HostWindowOutputBackend : public OutputBackend {
  public:
    // `inputFd` is the GPU-side end of the input socket to the core. The host
    // wl_seat listener inside HostWindow forwards pointer/keyboard events
    // over this fd. -1 disables forwarding (e.g. when the core is using the
    // libinput backend and ignores the wayland input socket).
    explicit HostWindowOutputBackend(int inputFd) : window_(inputFd) {}

    bool open(const char* title) override { return window_.open(title); }
    void close() override { /* HostWindow destructor handles release */ }

    OutputSize size() const override {
        return {window_.width(), window_.height()};
    }

    void describeOutput(OutputDescriptorInfo& out) const override;

    wgpu::Surface createWgpuSurface(wgpu::Instance& instance) override;

    int eventFd() const override { return window_.displayFd(); }
    void pump() override { window_.pump(); }
    bool shouldClose() const override { return window_.shouldClose(); }

    void setResizeListener(ResizeListener cb) override {
        window_.setResizeListener(std::move(cb));
    }

  private:
    HostWindow window_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_OUTPUT_HOST_WINDOW_H_
