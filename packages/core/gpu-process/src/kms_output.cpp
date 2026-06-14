#include "kms_output.h"

#include <cerrno>
#include <cstdio>
#include <cstring>

#include <sys/stat.h>

extern "C" {
#include <gbm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm_fourcc.h>
}

namespace overdraw::gpu {

KmsOutputBackend::~KmsOutputBackend() {
    close();
}

void KmsOutputBackend::close() {
    // Tear down in reverse construction order:
    //   ring (wgpu refs + dmabuf fds + GBM bo's + KMS fb_ids)
    //   mode blob
    //   GBM device
    //   topology / properties (no owned resources, just ids)
    // The DRM fd itself is owned by the core's libseat; we don't close it.
    ring_.clear();
    if (modeBlobId_ != 0 && drmFd_ >= 0) {
        drmModeDestroyPropertyBlob(drmFd_, modeBlobId_);
        modeBlobId_ = 0;
    }
    if (gbm_) {
        gbm_device_destroy(gbm_);
        gbm_ = nullptr;
    }
    deviceId_ = 0;
    didInitialCommit_ = false;
}

bool KmsOutputBackend::open(const char* /*title*/) {
    if (drmFd_ < 0) {
        std::fprintf(stderr, "[kms] open: no DRM fd (SetDrmFd not received)\n");
        return false;
    }

    // 1: drmFd already received from the core.
    // 2-3: enable atomic + universal-planes caps.
    if (!enableDrmAtomicCaps(drmFd_)) return false;

    // Record the card's dev_t for dmabuf-feedback / adapter sanity check.
    struct stat st{};
    if (::fstat(drmFd_, &st) == 0) deviceId_ = static_cast<uint64_t>(st.st_rdev);

    // 4: pick a connector (env var OVERDRAW_CONNECTOR may pin a name).
    const char* prefer = ::getenv("OVERDRAW_CONNECTOR");
    if (!pickConnector(drmFd_, prefer ? prefer : std::string{},
                       topo_.connectorId, topo_.connectorName, topo_.mode)) {
        return false;
    }
    std::printf("[kms] connector %s id=%u mode=%ux%u @%umHz\n",
                topo_.connectorName.c_str(), topo_.connectorId,
                topo_.mode.hdisplay, topo_.mode.vdisplay, topo_.mode.vrefreshMhz);

    // 5: mode picked alongside the connector (preferred or mode 0).
    // 6: CRTC.
    if (!pickCrtc(drmFd_, topo_.connectorId, topo_.crtcId)) return false;
    std::printf("[kms] crtc id=%u\n", topo_.crtcId);

    // 7: primary plane.
    if (!pickPrimaryPlane(drmFd_, topo_.crtcId, topo_.planeId)) return false;
    std::printf("[kms] plane id=%u\n", topo_.planeId);

    // Resolve all property ids we'll set in atomic commits.
    if (!resolveProperties(drmFd_, topo_)) return false;

    // 8: GBM device on the DRM fd. Created here so initScanout()'s scanout
    // ring can call gbm_bo_create_with_modifiers directly without re-opening.
    gbm_ = gbm_create_device(drmFd_);
    if (!gbm_) {
        std::fprintf(stderr, "[kms] gbm_create_device failed: %s\n", std::strerror(errno));
        return false;
    }

    // Steps 9-13 (scanout ring + initial modeset) happen in initScanout(),
    // which needs the GPU device.
    return true;
}

bool KmsOutputBackend::initScanout(const wgpu::Device& device) {
    if (drmFd_ < 0 || !gbm_) {
        std::fprintf(stderr, "[kms] initScanout: open() not completed\n");
        return false;
    }

    // The compositor's render format. We use BGRA8Unorm-equivalent on the
    // wgpu side; the matching DRM fourcc is XRGB8888 (alpha discarded at
    // scanout). The compositor's clear-color path uses BGRA8Unorm; matching
    // the format here keeps the JS side's render passes unchanged.
    constexpr uint32_t kFourcc = DRM_FORMAT_XRGB8888;

    // Per-plane modifier set the kernel advertises for this format. May be
    // empty on older drivers; the ring then falls back to LINEAR.
    std::vector<PlaneFormatModifier> planeFormats =
        readPlaneFormats(drmFd_, topo_.planeId, topo_.planeProps.in_formats);

    if (!ring_.init(drmFd_, gbm_, device,
                    topo_.mode.hdisplay, topo_.mode.vdisplay, kFourcc,
                    planeFormats)) {
        std::fprintf(stderr, "[kms] scanout ring init failed\n");
        return false;
    }
    return true;
}

void KmsOutputBackend::describeOutput(OutputDescriptorInfo& out) const {
    out.width            = topo_.mode.hdisplay;
    out.height           = topo_.mode.vdisplay;
    out.refreshMhz       = topo_.mode.vrefreshMhz;
    out.scale            = 1;
    out.transform        = 0;

    EdidInfo edid;
    if (drmFd_ >= 0 && topo_.connectorId &&
        readEdid(drmFd_, topo_.connectorId, edid)) {
        out.physicalWidthMm  = edid.physicalWidthMm;
        out.physicalHeightMm = edid.physicalHeightMm;
        // Connector name: e.g. "eDP-1". Real, drm-known identity.
        std::strncpy(out.name, topo_.connectorName.c_str(), sizeof(out.name) - 1);
        // Make = "overdraw" (we don't expose the host manufacturer; same as
        // nested-mode policy).
        std::strncpy(out.make, "overdraw", sizeof(out.make) - 1);
        // Model: EDID product name if available, else the connector name.
        const std::string& model = !edid.productName.empty() ? edid.productName : topo_.connectorName;
        std::strncpy(out.model, model.c_str(), sizeof(out.model) - 1);
    } else {
        std::strncpy(out.name, topo_.connectorName.c_str(), sizeof(out.name) - 1);
        std::strncpy(out.make, "overdraw", sizeof(out.make) - 1);
        std::strncpy(out.model, topo_.connectorName.c_str(), sizeof(out.model) - 1);
    }
}

wgpu::Texture KmsOutputBackend::acquireScanout(int& outSlotIdx) {
    const int idx = ring_.acquireFree();
    outSlotIdx = idx;
    if (idx < 0) return wgpu::Texture();
    return ring_.slot(idx).tex;
}

void KmsOutputBackend::pause() {
    if (paused_) return;
    paused_ = true;
    pendingFlipSlot_ = -1;
    ring_.resetAllSlotsToFree();
    didInitialCommit_ = false;
    std::printf("[kms] paused (VT switched away or seat disabled)\n");
}

void KmsOutputBackend::resume() {
    if (!paused_) return;
    paused_ = false;
    std::printf("[kms] resumed (next present will re-run modeset)\n");
}

bool KmsOutputBackend::presentScanout(int slotIdx, int inFenceFd) {
    if (paused_) {
        // The seat is disabled; the kernel has revoked DRM master and any
        // commit would EACCES. Swallow the present and discard the fence
        // fd (caller already closed its copy via the SCM_RIGHTS receive).
        (void)inFenceFd;
        return true;
    }
    if (slotIdx < 0 || drmFd_ < 0) return false;
    const auto& s = ring_.slot(slotIdx);
    drmModeAtomicReq* req = drmModeAtomicAlloc();
    if (!req) {
        std::fprintf(stderr, "[kms] drmModeAtomicAlloc failed\n");
        return false;
    }

    const uint32_t modeW = topo_.mode.hdisplay;
    const uint32_t modeH = topo_.mode.vdisplay;
    auto add = [&](uint32_t obj, uint32_t prop, uint64_t v) {
        if (prop) drmModeAtomicAddProperty(req, obj, prop, v);
    };

    // Plane: which CRTC, which FB, src + crtc rects. src_* are 16.16 fixed-
    // point in buffer space; crtc_* are integers in mode space.
    add(topo_.planeId, topo_.planeProps.fb_id,   s.fbId);
    add(topo_.planeId, topo_.planeProps.crtc_id, topo_.crtcId);
    add(topo_.planeId, topo_.planeProps.src_x,   0);
    add(topo_.planeId, topo_.planeProps.src_y,   0);
    add(topo_.planeId, topo_.planeProps.src_w,   static_cast<uint64_t>(ring_.width())  << 16);
    add(topo_.planeId, topo_.planeProps.src_h,   static_cast<uint64_t>(ring_.height()) << 16);
    add(topo_.planeId, topo_.planeProps.crtc_x,  0);
    add(topo_.planeId, topo_.planeProps.crtc_y,  0);
    add(topo_.planeId, topo_.planeProps.crtc_w,  modeW);
    add(topo_.planeId, topo_.planeProps.crtc_h,  modeH);

    // Explicit sync: tell the kernel to wait for this fence before latching.
    // The fd is dup'd by the kernel; caller still owns the original.
    if (inFenceFd >= 0 && topo_.planeProps.in_fence_fd) {
        add(topo_.planeId, topo_.planeProps.in_fence_fd, static_cast<uint64_t>(inFenceFd));
    }

    // Atomic commit flags differ between the initial modeset and steady-state
    // page flips.
    //
    // Initial (didInitialCommit_ == false):
    //   ALLOW_MODESET only. The initial commit synchronously sets up the CRTC
    //   / connector / mode; it does not produce a page-flip event (kernel
    //   docs: ALLOW_MODESET and PAGE_FLIP_EVENT together are accepted but
    //   the semantics on older Intel kernels are unreliable, so we keep them
    //   separate). NONBLOCK is not used: the modeset takes effect when the
    //   commit returns.
    //
    // Steady-state (didInitialCommit_ == true):
    //   PAGE_FLIP_EVENT | NONBLOCK. The kernel queues the flip for the next
    //   vblank and the page-flip event arrives via drmHandleEvent on the
    //   DRM fd in pump().
    uint32_t flags = 0;
    if (!didInitialCommit_) {
        // First commit also sets up CRTC + connector + mode.
        add(topo_.connectorId, topo_.connectorProps.crtc_id, topo_.crtcId);
        if (modeBlobId_ == 0) {
            modeBlobId_ = createModeBlob(drmFd_, topo_.mode.raw);
            if (modeBlobId_ == 0) { drmModeAtomicFree(req); return false; }
        }
        add(topo_.crtcId, topo_.crtcProps.mode_id, modeBlobId_);
        add(topo_.crtcId, topo_.crtcProps.active,  1);
        flags = DRM_MODE_ATOMIC_ALLOW_MODESET;
    } else {
        flags = DRM_MODE_PAGE_FLIP_EVENT | DRM_MODE_ATOMIC_NONBLOCK;
    }

    // Atomic TEST first so the kernel rejects without leaving us half-state.
    // TEST_ONLY must NOT include PAGE_FLIP_EVENT (the kernel rejects the
    // combination -- the test isn't a real commit so there's no flip to
    // signal). NONBLOCK is also irrelevant for TEST_ONLY.
    const uint32_t testFlags = (flags & ~DRM_MODE_PAGE_FLIP_EVENT & ~DRM_MODE_ATOMIC_NONBLOCK)
                              | DRM_MODE_ATOMIC_TEST_ONLY;
    int testRc = drmModeAtomicCommit(drmFd_, req, testFlags, this);
    if (testRc != 0) {
        std::fprintf(stderr, "[kms] atomic TEST failed: %s (flags=0x%x)\n",
                     std::strerror(errno), testFlags);
        drmModeAtomicFree(req);
        return false;
    }
    int rc = drmModeAtomicCommit(drmFd_, req, flags, this);
    drmModeAtomicFree(req);
    if (rc != 0) {
        std::fprintf(stderr, "[kms] atomic commit failed: %s (flags=0x%x)\n",
                     std::strerror(errno), flags);
        return false;
    }

    const bool wasInitial = !didInitialCommit_;
    didInitialCommit_ = true;
    ring_.markPendingFlip(slotIdx);
    pendingFlipSlot_ = slotIdx;
    // Initial commit ran ALLOW_MODESET without PAGE_FLIP_EVENT (the kernel-
    // docs path; combining them is unreliable on some drivers). That commit
    // is synchronous -- the modeset is done by the time we return -- so the
    // kernel will NOT deliver a flip event later, and the wake/render state
    // machine would never get its first onFrameComplete. Fake one inline:
    // transition the slot to SCANOUT now and fire the listener so the next
    // render is scheduled.
    if (wasInitial) {
        const int retired = ring_.onFlipComplete(slotIdx);
        pendingFlipSlot_ = -1;
        if (flipCompleteListener_) flipCompleteListener_(retired);
    }
    return true;
}

void KmsOutputBackend::pageFlipTrampoline(int /*fd*/, unsigned int /*sequence*/,
                                          unsigned int /*tv_sec*/, unsigned int /*tv_usec*/,
                                          unsigned int /*crtc_id*/, void* userdata) {
    auto* self = static_cast<KmsOutputBackend*>(userdata);
    if (!self) return;
    const int flipped = self->pendingFlipSlot_;
    self->pendingFlipSlot_ = -1;
    if (flipped < 0) return;
    const int retired = self->ring_.onFlipComplete(flipped);
    if (self->flipCompleteListener_) self->flipCompleteListener_(retired);
}

void KmsOutputBackend::pump() {
    if (drmFd_ < 0) return;
    drmEventContext ev{};
    ev.version = 3;  // page_flip_handler2 (with crtc_id)
    ev.page_flip_handler2 = &KmsOutputBackend::pageFlipTrampoline;
    // Non-blocking drain.
    drmHandleEvent(drmFd_, &ev);
}

}  // namespace overdraw::gpu
