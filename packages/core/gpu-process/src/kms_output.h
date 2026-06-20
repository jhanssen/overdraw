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
//     state. Keyed by the dense `outputId` assigned at enumeration order.
//   - the page-flip event handling (DRM event fd, drmHandleEvent); flips are
//     routed to the owning output by the CRTC id the kernel reports.
//
// Bring-up sequence (open()): see drm-design.md "DRM/KMS bring-up" §1-13.
// Steady state (per output):
//   - acquireScanoutAt() returns the next FREE slot's wgpu::Texture (or null
//     if all slots are in flight; the JS compositor's frame is skipped).
//   - presentScanoutAt() issues drmModeAtomicCommit with PAGE_FLIP_EVENT and
//     (when available) IN_FENCE_FD on the plane.
//   - pump() drains DRM events; on flip-complete the owning ring's state
//     machine advances and the frame clock signals the next acquire is ready.
//
// createWgpuSurface() returns null: KMS has no Dawn WSI surface.

#ifndef OVERDRAW_GPU_KMS_OUTPUT_H_
#define OVERDRAW_GPU_KMS_OUTPUT_H_

#include <cstdint>
#include <memory>
#include <unordered_map>
#include <unordered_set>
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
    // OutputBackend hook: fills `out` with the LOWEST live outputId's
    // descriptor (or zeroed when no outputs are live). The KMS code path
    // doesn't use this -- main.cpp iterates outputIds() + describeOutputAt()
    // -- but the base class requires it for the nested host-window backend.
    void describeOutput(OutputDescriptorInfo& out) const override;

    // Per-output access keyed by dense outputId (assigned by allocateOutputId,
    // lowest-free; see multi-output-design.md §3). The dense id is a TRANSIENT
    // runtime routing key, not stable across unplug/replug; durable identity
    // lives on the connector name + EDID.
    size_t outputCount() const { return outputs_.size(); }
    bool   hasOutput(uint32_t outputId) const { return outputs_.count(outputId) != 0; }
    // Returns every live outputId in ascending order. Snapshot copy; safe to
    // use across mutating calls.
    std::vector<uint32_t> outputIds() const;
    void describeOutputAt(uint32_t outputId, OutputDescriptorInfo& out) const;
    wgpu::Texture acquireScanoutAt(uint32_t outputId, int& outSlotIdx);
    bool presentScanoutAt(uint32_t outputId, int slotIdx, int inFenceFd);
    const KmsScanoutRing::Slot& scanoutSlotAt(uint32_t outputId, int slotIdx) const;
    uint32_t crtcIdAt(uint32_t outputId) const;

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
    // modeset again). While paused, presentScanoutAt() is a no-op (returns
    // true). On resume(): a clarifying no-op today -- the state was already
    // reset on pause; the call exists so a future change can force an
    // immediate modeset without waiting for the next render. Both are
    // idempotent.
    void pause();
    void resume();
    bool isPaused() const { return paused_; }

    // The card's dev_t (for the dmabuf-feedback main_device + sanity-check
    // that Dawn picked an adapter on the same physical GPU). 0 if open()
    // didn't succeed.
    uint64_t deviceId() const { return deviceId_; }

    // Rescan result: which outputIds vanished and which were freshly
    // created. The caller (GPU process main loop) uses these to send the
    // OutputRemoved / OutputAdded IPC tags; descriptors for added ids can
    // be queried via describeOutputAt().
    struct RescanResult {
        std::vector<uint32_t> removed;
        std::vector<uint32_t> added;
    };

    // Re-probe every DRM connector and reconcile against the current
    // outputs_ set. Implements multi-output-design.md §10's two-pass
    // (scan -> disconnect-vanished -> recheck-CRTCs -> connect-new). Idempotent
    // when nothing changed (empty added/removed). Safe to call any time
    // after open() has succeeded; does NOT allocate scanout rings -- those
    // come from the core's ScanoutReserve after the OutputAdded IPC.
    //
    // Limitations:
    //   - The two-pass "recheck-CRTCs" pass is a no-op for already-assigned
    //     outputs: an output never loses its CRTC mid-run unless it itself
    //     disconnects. So connector X that was previously skipped for
    //     lack of a free CRTC IS retried (it's just a new connect-new), but
    //     a swap like \"X has CRTC 0; Y wants CRTC 0; if we moved X to CRTC
    //     1 then Y fits\" is NOT performed. That cornered case stays a TODO
    //     pending a real reproduction; the design doc (§10) calls it out.
    RescanResult rescan();

  private:
    // One driven monitor: its topology, scanout ring, mode blob, and page-flip
    // state. Held by unique_ptr because KmsScanoutRing is non-movable (deleted
    // copy + a user dtor), so PerOutput cannot live by value in containers
    // that reallocate / rehash.
    struct PerOutput {
        uint32_t outputId = 0;
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

    // Lookup helper: returns nullptr if outputId is not live.
    PerOutput* find(uint32_t outputId);
    const PerOutput* find(uint32_t outputId) const;

    // Build a fresh PerOutput for a connector that has just come up (or
    // was just enumerated at startup). Picks a free CRTC + primary plane
    // matching the connector's possible_crtcs mask, resolves all property
    // ids, and inserts into outputs_ keyed by outputId. Returns false on
    // any sub-step failure (logged); leaves outputs_ unchanged on failure.
    // Used by both open() and rescan(); each call grows usedCrtcs_ on
    // success.
    bool connectOutput(DrmTopology topo, uint32_t outputId);

    // Tear down one PerOutput's software state: drop the CRTC from
    // usedCrtcs_, destroy the mode blob, clear the ring slots, remove the
    // entry from outputs_. Does NOT issue an atomic-disable commit -- a
    // vanished connector is already off, and the next time the CRTC is
    // reused, the new initial commit's ALLOW_MODESET fully reprograms it.
    // No-op if outputId is not live.
    void disconnectOutput(uint32_t outputId);

    // Smallest non-negative uint32 not currently in use by outputs_. Today
    // outputs_ stays small (<10), so the linear scan is fine; revisit if
    // outputs ever go into the hundreds (multi-card territory, M9+).
    uint32_t allocateOutputId() const;

    int drmFd_ = -1;   // borrowed; not closed
    gbm_device* gbm_ = nullptr;
    uint64_t deviceId_ = 0;
    bool shouldClose_ = false;
    bool paused_ = false;
    std::unordered_map<uint32_t, std::unique_ptr<PerOutput>> outputs_;
    // CRTC ids currently bound to a live output. Mutated by connectOutput
    // (insert) / disconnectOutput (erase). connectOutput passes a transient
    // vector view of this set into the existing pickCrtc helper.
    std::unordered_set<uint32_t> usedCrtcs_;
    ResizeListener resizeListener_;
    FlipCompleteCb flipCompleteListener_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_KMS_OUTPUT_H_
