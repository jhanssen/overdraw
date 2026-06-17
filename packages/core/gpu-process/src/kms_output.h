// KMS output backend (bare-metal mode).
//
// Implements OutputBackend by driving DRM/atomic on every connected
// connector + a distinct CRTC + primary plane. Owns:
//   - the DRM card fd (received from the core via SetDrmFd; this class does
//     NOT close it, the core's libseat owns the device).
//   - a single GBM device on that fd, shared by all outputs for scanout
//     buffer allocation.
//   - one PerOutput per driven monitor: its resolved topology (connector +
//     CRTC + plane + property ids), a 3-slot scanout ring (KmsScanoutRing)
//     whose textures back the compositor's render passes, and its page-flip
//     state. outputs_[0] is the primary.
//   - the page-flip event handling (DRM event fd, drmHandleEvent); flips are
//     routed to the owning output by the CRTC id the kernel reports.
//
// Bring-up sequence (open()): see drm-design.md "DRM/KMS bring-up" §1-13.
// Steady state (per output):
//   - acquireScanout() returns the next FREE slot's wgpu::Texture (or nullptr
//     if all slots are in flight; the JS compositor's frame is skipped).
//   - presentScanout() issues drmModeAtomicCommit with PAGE_FLIP_EVENT and
//     (when available) IN_FENCE_FD on the plane.
//   - pump() drains DRM events; on flip-complete the owning ring's state
//     machine advances and the frame clock signals the next acquire is ready.
//
// createWgpuSurface() returns null: KMS has no Dawn WSI surface.

#ifndef OVERDRAW_GPU_KMS_OUTPUT_H_
#define OVERDRAW_GPU_KMS_OUTPUT_H_

#include <cstdint>
#include <memory>
#include <vector>

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

    // First phase: DRM/atomic caps, then resolve a topology (connector / CRTC
    // / plane) for every connected connector that can claim a distinct CRTC +
    // plane, and create the shared GBM device. The scanout rings are NOT
    // allocated here because the GPU device (needed for SharedTextureMemory
    // import) isn't resolved until the wire handshake completes -- the device
    // handshake and the DRM bring-up are independent in the GPU process.
    // `title` is unused (no window in KMS mode). Returns false on failure;
    // error is logged.
    bool open(const char* title) override;
    void close() override;

    // Second phase: allocate the scanout ring for every output (dual-imported
    // as wgpu::Texture on `device`). The initial atomic modeset is issued
    // lazily on each output's first present. Called from the GPU process's
    // main loop AFTER the core's device is resolved via wire handshake.
    // Returns false only if the PRIMARY ring fails; a secondary ring failure
    // drops that output and keeps going.
    bool initScanout(const wgpu::Device& device);

    OutputSize size() const override;
    void describeOutput(OutputDescriptorInfo& out) const override;

    // Connected monitors beyond the primary (outputs_[1..]). Each is driven
    // with its own CRTC + plane + ring, same as the primary; these accessors
    // exist for the legacy primary-plus-extras reporting shape in main.cpp.
    size_t extraOutputCount() const { return outputs_.empty() ? 0 : outputs_.size() - 1; }
    void describeExtraOutput(size_t i, OutputDescriptorInfo& out) const;

    // Per-output access by dense output index (0 = primary).
    size_t outputCount() const { return outputs_.size(); }
    void describeOutputAt(size_t outputIdx, OutputDescriptorInfo& out) const;
    wgpu::Texture acquireScanoutAt(size_t outputIdx, int& outSlotIdx);
    bool presentScanoutAt(size_t outputIdx, int slotIdx, int inFenceFd);
    const KmsScanoutRing::Slot& scanoutSlotAt(size_t outputIdx, int slotIdx) const;
    uint32_t crtcIdAt(size_t outputIdx) const;

    // Dawn WSI is not used on KMS. Return null; the GPU process main loop
    // branches on a null surface to skip WSI bring-up.
    wgpu::Surface createWgpuSurface(wgpu::Instance& /*instance*/) override {
        return wgpu::Surface();
    }

    int eventFd() const override { return drmFd_; }
    // The scanout card fd. Used to match the Dawn adapter to this GPU.
    int drmFd() const { return drmFd_; }
    void pump() override;
    bool shouldClose() const override { return shouldClose_; }
    void setResizeListener(ResizeListener cb) override { resizeListener_ = std::move(cb); }

    // KMS-specific entry points used by main.cpp's render loop, operating on
    // the primary output. Both return -1 / false on failure (slot exhausted;
    // commit rejected).
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

    // Callback invoked when a page-flip retires a slot on some output. Carries
    // the dense outputId that flipped and the slot index that just exited
    // SCANOUT and is now FREE (-1 on that output's first flip). Used by the
    // main loop to drive per-output frame pacing and buffer-release.
    using FlipCompleteCb = std::function<void(uint32_t outputId, int retiredSlotIdx)>;
    void setFlipCompleteListener(FlipCompleteCb cb) { flipCompleteListener_ = std::move(cb); }

    // VT-switch lifecycle. On pause(): drop any pending flip wait, reset every
    // ring slot to FREE on every output, clear each didInitialCommit so the
    // next post-resume present runs the ALLOW_MODESET path (the kernel has
    // revoked DRM master under us; on resume libseat hands it back and we must
    // modeset again). While paused, presentScanout() is a no-op (returns true).
    // On resume(): a clarifying no-op today -- the state was already reset on
    // pause; the call exists so a future change can force an immediate modeset
    // without waiting for the next render. Both are idempotent.
    void pause();
    void resume();
    bool isPaused() const { return paused_; }

    // The card's dev_t (for the dmabuf-feedback main_device + sanity-check
    // that Dawn picked an adapter on the same physical GPU). 0 if open()
    // didn't succeed.
    uint64_t deviceId() const { return deviceId_; }

    // Borrowed access to the primary ring's slot, for main.cpp's InjectTexture
    // path. Returns the slot's underlying GBM bo + dmabuf fd + wgpu::Texture.
    const KmsScanoutRing::Slot& scanoutSlot(int idx) const;

  private:
    // One driven monitor: its topology, scanout ring, mode blob, and page-flip
    // state. Held by unique_ptr because KmsScanoutRing is non-movable (deleted
    // copy + a user dtor), so PerOutput cannot live by value in a vector that
    // reallocates.
    struct PerOutput {
        uint32_t outputId = 0;       // dense id: 0 = primary, 1.. = extras
        DrmTopology topo{};
        KmsScanoutRing ring;
        uint32_t modeBlobId = 0;
        bool didInitialCommit = false;
        int pendingFlipSlot = -1;    // -1 = no flip in flight
    };

    // Page-flip C trampoline (libdrm calls back into this). The 5th argument is
    // the CRTC id the kernel reports, used to route the flip to its output.
    static void pageFlipTrampoline(int /*fd*/, unsigned int /*sequence*/,
                                    unsigned int /*tv_sec*/, unsigned int /*tv_usec*/,
                                    unsigned int crtc_id, void* userdata);

    // Fill the make/model/name + physical-dims identity fields from the
    // connector's EDID (best-effort). The caller fills
    // width/height/refresh/scale/transform.
    void fillIdentity(uint32_t connectorId, const std::string& name,
                      OutputDescriptorInfo& out) const;

    // Fill width/height/refresh/scale/transform/identity from one output.
    void describeFrom(const PerOutput& o, OutputDescriptorInfo& out) const;

    // Acquire/present implementations operating on a given output.
    wgpu::Texture acquireOutputImpl(PerOutput& o, int& outSlotIdx);
    bool presentOutputImpl(PerOutput& o, int slotIdx, int inFenceFd);

    int drmFd_ = -1;   // borrowed; not closed
    gbm_device* gbm_ = nullptr;
    uint64_t deviceId_ = 0;
    bool shouldClose_ = false;
    bool paused_ = false;
    std::vector<std::unique_ptr<PerOutput>> outputs_;  // outputs_[0] is the primary
    ResizeListener resizeListener_;
    FlipCompleteCb flipCompleteListener_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_KMS_OUTPUT_H_
