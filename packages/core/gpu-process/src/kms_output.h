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
//   - presentScanoutAt() issues drmModeAtomicCommit with PAGE_FLIP_EVENT and
//     (when available) IN_FENCE_FD on the plane.
//   - pump() drains DRM events; on flip-complete the owning ring's state
//     machine advances and the frame clock signals the next acquire is ready.
//
#ifndef OVERDRAW_GPU_KMS_OUTPUT_H_
#define OVERDRAW_GPU_KMS_OUTPUT_H_

#include <cstdint>
#include <functional>
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

    // Per-output ring init for runtime adds (post-rescan). Called from the
    // OutputAdded -> ScanoutReserve handshake; the caller already knows the
    // specific outputId that just came up. Returns false on ring-allocation
    // failure (in which case the entry is dropped from outputs_ so the next
    // rescan can retry from scratch).
    bool initScanoutForOutput(uint32_t outputId, const wgpu::Device& device);

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
    bool   hasOutput(uint32_t outputId) const { return outputs_.count(outputId) != 0; }
    // Returns every live outputId in ascending order. Snapshot copy; safe to
    // use across mutating calls.
    std::vector<uint32_t> outputIds() const;
    void describeOutputAt(uint32_t outputId, OutputDescriptorInfo& out) const;
    bool presentScanoutAt(uint32_t outputId, int slotIdx, int inFenceFd);
    const KmsScanoutRing::Slot& scanoutSlotAt(uint32_t outputId, int slotIdx) const;

    int eventFd() const override { return drmFd_; }
    // The scanout card fd. Used to match the Dawn adapter to this GPU.
    int drmFd() const { return drmFd_; }
    void pump() override;
    bool shouldClose() const override { return shouldClose_; }
    // KMS output resizes (mode switches) propagate to the core via the
    // ScanoutRebuild wire frame, not this listener; accept and discard.
    void setResizeListener(ResizeListener) override {}

    // Callback invoked when a page-flip retires a slot on some output. Carries
    // the dense outputId that flipped and the slot index that just exited
    // SCANOUT and is now FREE (-1 on that output's first flip). tv_sec /
    // tv_nsec / seq are the kernel-supplied page-flip timestamp + vsync
    // sequence (drmEventContext version 3, page_flip_handler2), used to
    // drive wp_presentation. Used by the main loop to drive per-output
    // frame pacing and buffer-release.
    using FlipCompleteCb = std::function<void(uint32_t outputId, int retiredSlotIdx,
                                              uint64_t tvSec, uint32_t tvNsec, uint32_t seq)>;
    void setFlipCompleteListener(FlipCompleteCb cb) { flipCompleteListener_ = std::move(cb); }

    // -------------------------------------------------------------------
    // Hardware cursor plane.
    //
    // Each output that resolved a cursor plane scans the cursor out of a
    // small linear ARGB8888 dumb buffer on that plane; position changes
    // ride the next atomic commit (every frame commit re-programs the
    // cursor plane) or, when the core says no frame is coming, a cursor-
    // only commit issued here. Cursor-only commits and frame commits are
    // serialized: while a cursor-only flip is in flight an arriving
    // present is stashed and issued from the cursor flip's event.
    // -------------------------------------------------------------------

    // Whether outputId has a usable cursor plane; fills the device's
    // cursor buffer dims (the FB is always exactly this size).
    bool cursorPlaneInfoAt(uint32_t outputId, uint32_t& outW, uint32_t& outH) const;

    // Install a cursor image: `pixels` is srcW x srcH premultiplied BGRA
    // rows at `srcStride` bytes. The image is scaled to dstW x dstH (when
    // different) and placed top-left in the cursor FB, remainder
    // transparent. Returns false when the image can't be used (dst dims
    // exceed the cursor FB, buffer alloc/map failure) -- the caller should
    // demote this output to the software cursor.
    bool setCursorImage(uint32_t outputId, const uint8_t* pixels,
                        uint32_t srcW, uint32_t srcH, uint32_t srcStride,
                        uint32_t dstW, uint32_t dstH);

    // Desired cursor plane state. x/y are device pixels relative to the
    // output (hotspot already applied; may be negative). commitNow means
    // no present is coming for this output, so apply via a cursor-only
    // commit as soon as the plane is free.
    void setCursorState(uint32_t outputId, int32_t x, int32_t y,
                        bool visible, bool commitNow);

    // Invoked when the kernel rejects a commit because of the cursor
    // plane: the output has been demoted to software cursor (its cursor
    // plane released). The listener should tell the core so it resumes
    // compositing the cursor for this output.
    using CursorFallbackCb = std::function<void(uint32_t outputId)>;
    void setCursorFallbackListener(CursorFallbackCb cb) { cursorFallbackListener_ = std::move(cb); }

    // -------------------------------------------------------------------
    // Direct scanout of client dmabufs (see scanout-design.md).
    //
    // A client buffer is imported once as a KMS FB (importClientFb) and
    // then presented on an output's primary plane instead of a ring slot.
    // Commits share the per-CRTC serialization with ring presents and
    // cursor-only commits; a present arriving while another flip is in
    // flight is stashed and issued from that flip's event.
    // -------------------------------------------------------------------

    // Wrap a client dmabuf as a KMS FB (drmModeAddFB2WithModifiers).
    // Returns the fbId, or 0 when the kernel refuses the buffer (the
    // caller reports not-scannable and the core composites it).
    uint32_t importClientFb(int dmabufFd, uint32_t width, uint32_t height,
                            uint32_t fourcc, uint64_t modifier,
                            uint32_t offset, uint32_t stride);

    // Put a client FB on outputId's primary plane. Returns false when the
    // atomic TEST rejects it (caller emits ScanoutClientReject and the
    // core composites; nothing was committed). bufferId is the core-side
    // buffer key echoed through the flip listener.
    bool presentClientFbAt(uint32_t outputId, uint32_t fbId,
                           uint32_t width, uint32_t height,
                           uint32_t bufferId, int inFenceFd);

    // Mark a client FB for destruction. RmFB on a latched FB force-
    // disables the plane, so condemned FBs are destroyed only once no
    // output has them latched or pending (swept at flip events and
    // teardown).
    void condemnClientFb(uint32_t fbId);

    // A page flip involving client scanout completed: latchedBufferId is
    // the client buffer now on the plane (0 when a ring frame latched);
    // retiredBufferId is the client buffer the flip displaced (0 = none).
    struct ClientFlipInfo {
        uint32_t outputId = 0;
        uint32_t latchedBufferId = 0;
        uint32_t retiredBufferId = 0;
        uint64_t tvSec = 0;
        uint32_t tvNsec = 0;
        uint32_t seq = 0;
    };
    using ClientFlipCb = std::function<void(const ClientFlipInfo&)>;
    void setClientFlipListener(ClientFlipCb cb) { clientFlipListener_ = std::move(cb); }

    // The (format, modifier) set the output's PRIMARY plane advertises
    // (IN_FORMATS). Used to build the dmabuf-feedback scanout tranche.
    // Empty when the output is unknown or the property is absent.
    std::vector<PlaneFormatModifier> primaryPlaneFormatsAt(uint32_t outputId) const;

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

    // Switch one connected output to a new mode. The new mode MUST already
    // exist in the connector's mode list (no custom-mode validation here;
    // see drm_utils::findMode). On success: the prior ring is torn down,
    // the mode blob is destroyed, topo.mode is updated, didInitialCommit
    // is cleared (so the next present runs ALLOW_MODESET with a fresh
    // blob), and a fresh ring is allocated at the new dims. Returns true
    // on success; false on unknown outputId / mode-not-found / ring
    // re-alloc failure (in which case the output is left in a torn-down
    // state -- the caller is expected to disconnect it and re-add).
    //
    // The CALLER is responsible for emitting the ScanoutRebuild wire
    // frame after this returns true; KmsOutputBackend has no IPC.
    // See multi-output-design §10.5.
    bool switchMode(uint32_t outputId, uint32_t width, uint32_t height,
                    uint32_t refreshMhz, const wgpu::Device& device);

    // Return every mode the connector backing `outputId` advertises.
    // Empty when the outputId is unknown or the connector has no modes.
    // Used by the OutputModes wire emit so the core can surface the
    // full mode list to wlr-output-management clients.
    std::vector<DrmMode> enumerateModes(uint32_t outputId) const;

  private:
    // One driven monitor: its topology, scanout ring, mode blob, and page-flip
    // state. Held by unique_ptr because KmsScanoutRing is non-movable (deleted
    // copy + a user dtor), so PerOutput cannot live by value in containers
    // that reallocate / rehash.
    // One CPU-writable cursor framebuffer: a linear ARGB8888 dumb buffer
    // kept mmap'd for its lifetime, wrapped as a KMS FB.
    struct CursorBo {
        uint32_t handle = 0;   // dumb-buffer GEM handle
        uint32_t pitch  = 0;
        uint64_t size   = 0;
        void*    map    = nullptr;
        uint32_t fbId   = 0;
    };

    struct PerOutput {
        uint32_t outputId = 0;
        DrmTopology topo{};
        KmsScanoutRing ring;
        uint32_t modeBlobId = 0;
        bool didInitialCommit = false;
        int pendingFlipSlot = -1;    // -1 = no flip in flight

        // Cursor plane state. Image writes go to the back bo (1 - front)
        // and swap, so the latched FB is never scribbled on mid-scanout.
        CursorBo cursorBos[2];
        int  cursorFrontBo = 0;
        bool cursorImageValid = false;   // an image has been installed
        int32_t cursorX = 0;             // device px, hotspot-adjusted
        int32_t cursorY = 0;
        bool cursorVisible = false;
        bool cursorDirty = false;            // desired state not yet committed
        bool cursorCommitRequested = false;  // core asked for a cursor-only commit
        bool cursorFlipPending = false;      // cursor-only commit awaiting its event
        bool cursorDemoted = false;          // kernel rejected the plane; software now

        // Client direct scanout: which client FB/buffer is latched on the
        // primary plane (0 = a ring frame is latched) and which is in a
        // pending flip.
        uint32_t latchedClientFbId  = 0;
        uint32_t latchedClientBufId = 0;
        uint32_t pendingClientFbId  = 0;
        uint32_t pendingClientBufId = 0;
        bool clientFlipPending = false;

        // Present stashed because another flip was in flight when it
        // arrived; issued from that flip's event. Either a ring slot
        // (slotIdx >= 0) or a client FB (clientFbId != 0). Fence fd is
        // owned here.
        struct StashedPresent {
            int slotIdx = -1;
            uint32_t clientFbId = 0;
            uint32_t clientBufId = 0;
            uint32_t clientW = 0;
            uint32_t clientH = 0;
            int fence = -1;
            bool valid = false;
        } stashed;
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

    // Present implementation operating on a given output. Exactly one of
    // slotIdx >= 0 (ring present) or clientFbId != 0 (client scanout
    // present) is set; the client variant carries the buffer dims (for
    // SRC_W/H) and the core-side bufferId for flip reporting.
    bool presentOutputImpl(PerOutput& o, int slotIdx, int inFenceFd,
                           uint32_t clientFbId = 0, uint32_t clientBufId = 0,
                           uint32_t clientW = 0, uint32_t clientH = 0);

    // Stash a present that cannot commit now (another flip in flight);
    // replayed from that flip's completion event.
    void stashPresent(PerOutput& o, int slotIdx, uint32_t clientFbId,
                      uint32_t clientBufId, uint32_t clientW, uint32_t clientH,
                      int inFenceFd);
    // Issue the stashed present (if any). Called from flip events.
    void replayStashedPresent(PerOutput& o);
    // Emit the client-flip listener event + advance latched bookkeeping
    // for a flip that latched `latchedFb`/`latchedBuf` (0/0 = ring frame),
    // then sweep condemned FBs.
    void noteLatch(PerOutput& o, uint32_t latchedFb, uint32_t latchedBuf,
                   uint64_t tvSec, uint32_t tvNsec, uint32_t seq);
    // RmFB every condemned FB no output has latched or pending.
    void sweepCondemnedFbs();

    // Add the cursor plane's desired state to `req`: full props when
    // visible with a valid image, else FB_ID=0 + CRTC_ID=0 (plane off).
    // No-op when the output has no cursor plane.
    void addCursorPlaneState(drmModeAtomicReq* req, PerOutput& o) const;

    // Issue a cursor-only atomic commit (PAGE_FLIP_EVENT | NONBLOCK)
    // carrying the desired cursor state. Preconditions checked inside:
    // initial modeset done, no flip of either kind in flight.
    void maybeCursorCommit(PerOutput& o);

    // Demote this output to software cursor: mark the plane unusable (all
    // later commits emit the plane-off props), and tell the core via the
    // fallback listener so it resumes compositing the cursor. The cursor
    // bos stay allocated until output teardown -- the plane may still be
    // latched on one until the next commit turns it off.
    // issueDisableCommit=false when the caller is about to commit anyway
    // (the caller's commit carries the plane-off props; a self-issued one
    // would collide with it).
    void demoteCursor(PerOutput& o, bool issueDisableCommit = true);

    // Allocate (lazily) / destroy the two cursor dumb-buffer FBs.
    bool ensureCursorBos(PerOutput& o);
    void destroyCursorBos(PerOutput& o);
    // Drop any in-flight cursor-only flip + stashed present (VT pause,
    // mode switch, teardown).
    void resetTransientFlipState(PerOutput& o);

    // Allocate the 3-slot scanout ring for one PerOutput against `device`.
    // Shared by initScanout (startup, every output) and initScanoutForOutput
    // (post-rescan, single output).
    bool initRingFor(PerOutput& o, const wgpu::Device& device);

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
    // outputs ever go into the hundreds (multi-card territory).
    uint32_t allocateOutputId() const;

    int drmFd_ = -1;   // borrowed; not closed
    gbm_device* gbm_ = nullptr;
    bool shouldClose_ = false;
    bool paused_ = false;
    // Device-wide cursor FB dims (DRM_CAP_CURSOR_WIDTH/HEIGHT).
    uint32_t cursorCapW_ = 0;
    uint32_t cursorCapH_ = 0;
    std::unordered_map<uint32_t, std::unique_ptr<PerOutput>> outputs_;
    // CRTC ids currently bound to a live output. Mutated by connectOutput
    // (insert) / disconnectOutput (erase). connectOutput passes a transient
    // vector view of this set into the existing pickCrtc helper.
    std::unordered_set<uint32_t> usedCrtcs_;
    FlipCompleteCb flipCompleteListener_;
    CursorFallbackCb cursorFallbackListener_;
    ClientFlipCb clientFlipListener_;
    // Client FBs waiting for a safe RmFB (not latched/pending anywhere).
    std::vector<uint32_t> condemnedClientFbs_;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_KMS_OUTPUT_H_
