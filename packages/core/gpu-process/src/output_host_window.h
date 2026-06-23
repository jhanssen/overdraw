// Host Wayland output backend (nested mode).
//
// Wraps HostWindow behind the OutputBackend interface. The GPU process is
// the Wayland client of the host compositor here; the host's wl_surface is
// the scanout target.
//
// The render-into-and-present path runs through a WaylandScanoutRing of
// dmabufs allocated GPU-side and wrapped as host wl_buffer proxies via the
// host's zwp_linux_dmabuf_v1. The compositor renders into the next FREE
// slot's dmabuf; presentScanout() attaches the slot's wl_buffer to the
// host wl_surface, damages, commits, and marks the slot PENDING_FLIP. The
// host's wl_buffer.release event drives a flip-complete callback that
// transitions the prior SCANOUT slot to FREE and the just-presented one
// to SCANOUT.
//
// createWgpuSurface() remains for compatibility with the older WSI-driven
// path during the transition; once the scanout-ring path is the only
// caller, it will be removed along with the rest of the Dawn WSI bring-up
// in the GPU process.

#ifndef OVERDRAW_GPU_OUTPUT_HOST_WINDOW_H_
#define OVERDRAW_GPU_OUTPUT_HOST_WINDOW_H_

#include <memory>

#include "host_window.h"
#include "output_backend.h"
#include "wayland_scanout_ring.h"

struct gbm_device;

namespace overdraw::gpu {

class HostWindowOutputBackend : public OutputBackend {
  public:
    // `inputFd` is the GPU-side end of the input socket to the core. The host
    // wl_seat listener inside HostWindow forwards pointer/keyboard events
    // over this fd. -1 disables forwarding (e.g. when the core is using the
    // libinput backend and ignores the wayland input socket).
    explicit HostWindowOutputBackend(int inputFd) : window_(inputFd) {}
    ~HostWindowOutputBackend() override;

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
    void setFrameDoneListener(FrameDoneListener cb) override {
        window_.setFrameDoneListener(std::move(cb));
    }
    void armFrameCallback() override { window_.armFrameCallback(); }

    // ---- Scanout-ring API (the new nested-present path) ----------------

    // Allocate the host-attached dmabuf scanout ring against `device`. The
    // ring's GBM allocator is `gbm` (borrowed; not owned). `fourcc` is the
    // DRM fourcc for the scanout format; the modifier is picked from the
    // intersection of host-advertised modifiers and what the GPU can both
    // allocate and import. Returns false on failure.
    //
    // Must be called AFTER open() AND after the Dawn device is resolved.
    // Idempotent: a second call tears down the prior ring and rebuilds at
    // the new dimensions (used on host-window resize).
    bool initScanout(gbm_device* gbm, const wgpu::Device& device, uint32_t fourcc);

    // Returns the next FREE slot's wgpu::Texture (and writes its index to
    // outSlotIdx), or null when no slot is free or the ring is not built.
    // The texture is borrowed; the slot retains ownership.
    wgpu::Texture acquireScanout(int& outSlotIdx);

    // Present the slot returned by the matching acquireScanout: attach the
    // slot's wl_buffer to the host wl_surface, damage_buffer (whole
    // surface for now), commit, and mark the slot PENDING_FLIP. The host's
    // subsequent wl_buffer.release on the slot drives the flip-complete
    // callback (see setBufferReleaseListener).
    void presentScanout(int slotIdx);

    // Direct access to the ring for callers that need slot fields (e.g.
    // to bind the wgpu::SharedTextureMemory for producer access brackets
    // during JS-driven render submits). Null when the ring is not built.
    WaylandScanoutRing* scanoutRing() { return scanoutBuilt_ ? &ring_ : nullptr; }
    const WaylandScanoutRing* scanoutRing() const {
        return scanoutBuilt_ ? &ring_ : nullptr;
    }

    // Callback fired when the host releases a slot's wl_buffer (the
    // nested-mode equivalent of a KMS page-flip-complete event). Carries
    // the slot index that just became FREE; -1 is never reported here
    // (release maps to a known slot or we ignore it as stale).
    using BufferReleaseListener = std::function<void(int retiredSlotIdx)>;
    void setBufferReleaseListener(BufferReleaseListener cb) {
        bufferReleaseListener_ = std::move(cb);
    }

    // Trampoline for the host wl_buffer.release listener installed per
    // slot during initScanout. Public so the C trampoline can dispatch
    // here.
    void onBufferRelease(struct wl_buffer* buf);

  private:
    HostWindow window_;
    WaylandScanoutRing ring_;
    bool scanoutBuilt_ = false;
    BufferReleaseListener bufferReleaseListener_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_OUTPUT_HOST_WINDOW_H_
