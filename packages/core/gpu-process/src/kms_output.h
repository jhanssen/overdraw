// KMS output backend (phase 2, bare-metal mode).
//
// Implements OutputBackend by driving DRM/atomic on a real connector +
// CRTC + primary plane. Owns:
//   - the DRM card fd (received from the core via SetDrmFd; this class does
//     NOT close it, the core's libseat owns the device).
//   - a GBM device on that fd, for scanout buffer allocation.
//   - a 3-slot scanout ring (KmsScanoutRing) whose textures back the
//     compositor's render passes.
//   - the resolved topology (connector + CRTC + plane + property ids).
//   - the page-flip event handling (DRM event fd, drmHandleEvent).
//
// Bring-up sequence (open()): see drm-design.md "DRM/KMS bring-up" §1-13.
// Steady state:
//   - acquireScanout() returns the next FREE slot's wgpu::Texture (or nullptr
//     if all slots are in flight; the JS compositor's frame is skipped).
//   - presentScanout() issues drmModeAtomicCommit with PAGE_FLIP_EVENT and
//     (when available) IN_FENCE_FD on the plane.
//   - pump() drains DRM events; on flip-complete the ring's state machine
//     advances and the frame clock signals the next acquire is ready.
//
// createWgpuSurface() returns null: KMS has no Dawn WSI surface. The GPU
// process's main loop branches on this in slice 4.

#ifndef OVERDRAW_GPU_KMS_OUTPUT_H_
#define OVERDRAW_GPU_KMS_OUTPUT_H_

#include <cstdint>
#include <memory>

#include "dawn/webgpu_cpp.h"

#include "drm_utils.h"
#include "kms_scanout_ring.h"
#include "output_backend.h"

struct gbm_device;

namespace overdraw::gpu {

class KmsOutputBackend : public OutputBackend {
  public:
    // `drmFd` is the card fd, opened by the core via libseat and SCM_RIGHTS-
    // passed to the GPU process. The backend uses it but does not own it;
    // the core's seat is the owner.
    explicit KmsOutputBackend(int drmFd) : drmFd_(drmFd) {}
    ~KmsOutputBackend() override;

    // First phase: DRM/atomic caps, topology resolution (connector / CRTC /
    // plane), GBM device. The scanout ring is NOT allocated here because the
    // GPU device (needed for SharedTextureMemory import) isn't resolved
    // until the wire handshake completes -- the device handshake and the
    // DRM bring-up are independent in the GPU process. `title` is unused
    // (no window in KMS mode). Returns false on failure; error is logged.
    bool open(const char* title) override;
    void close() override;

    // Second phase: allocate the scanout ring (dual-imported as wgpu::Texture
    // on `device`), and issue the initial atomic modeset (connector -> CRTC,
    // CRTC mode + active, primary plane FB = slot 0's fb_id). Called from
    // the GPU process's main loop AFTER the core's device is resolved via
    // wire handshake. Returns false on failure.
    bool initScanout(const wgpu::Device& device);

    OutputSize size() const override { return { topo_.mode.hdisplay, topo_.mode.vdisplay }; }
    void describeOutput(OutputDescriptorInfo& out) const override;

    // Dawn WSI is not used on KMS. Return null; the GPU process main loop
    // branches on a null surface to skip WSI bring-up.
    wgpu::Surface createWgpuSurface(wgpu::Instance& /*instance*/) override {
        return wgpu::Surface();
    }

    int eventFd() const override { return drmFd_; }
    void pump() override;
    bool shouldClose() const override { return shouldClose_; }
    void setResizeListener(ResizeListener cb) override { resizeListener_ = std::move(cb); }

    // KMS-specific entry points used by main.cpp's render loop. Both return
    // -1 on failure (slot exhausted; commit rejected).
    //
    // acquireScanout() returns the wgpu::Texture for the next FREE slot
    // (or null if none are free) and stashes the slot idx for present.
    // The returned texture lives until the corresponding presentScanout()
    // is followed by the flip-complete that retires it.
    wgpu::Texture acquireScanout(int& outSlotIdx);

    // presentScanout commits the just-rendered slot to the display. If
    // inFenceFd >= 0, it's attached to the plane via the IN_FENCE_FD
    // property so the kernel waits for the GPU render to complete before
    // latching. The fd is dup'd by the kernel; the caller closes it.
    // Returns false if the atomic commit was rejected.
    bool presentScanout(int slotIdx, int inFenceFd);

    // Callback invoked when a page-flip retires a slot (the slot that just
    // exited SCANOUT and is now FREE). Used by the main loop to drive frame
    // pacing and (later, slice 6) buffer-release.
    using FlipCompleteCb = std::function<void(int retiredSlotIdx)>;
    void setFlipCompleteListener(FlipCompleteCb cb) { flipCompleteListener_ = std::move(cb); }

    // The card's dev_t (for the dmabuf-feedback main_device + sanity-check
    // that Dawn picked an adapter on the same physical GPU). 0 if open()
    // didn't succeed.
    uint64_t deviceId() const { return deviceId_; }

    // Borrowed access to a ring slot, for main.cpp's InjectTexture path.
    // Returns the slot's underlying GBM bo + dmabuf fd + wgpu::Texture.
    const KmsScanoutRing::Slot& scanoutSlot(int idx) const { return ring_.slot(idx); }

  private:
    // Page-flip C trampoline (libdrm calls back into this).
    static void pageFlipTrampoline(int /*fd*/, unsigned int /*sequence*/,
                                    unsigned int /*tv_sec*/, unsigned int /*tv_usec*/,
                                    unsigned int /*crtc_id*/, void* userdata);

    int drmFd_ = -1;   // borrowed; not closed
    gbm_device* gbm_ = nullptr;
    uint64_t deviceId_ = 0;
    DrmTopology topo_{};
    KmsScanoutRing ring_;
    uint32_t modeBlobId_ = 0;
    bool didInitialCommit_ = false;
    bool shouldClose_ = false;
    int pendingFlipSlot_ = -1;  // -1 = no flip in flight
    ResizeListener resizeListener_;
    FlipCompleteCb flipCompleteListener_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_KMS_OUTPUT_H_
