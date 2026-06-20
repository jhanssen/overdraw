#include "kms_output.h"

#include <algorithm>
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
    //   each output's ring (wgpu refs + dmabuf fds + GBM bo's + KMS fb_ids)
    //   each output's mode blob
    //   GBM device
    //   topology / properties (no owned resources, just ids)
    // The DRM fd itself is owned by the core's libseat; we don't close it.
    for (auto& [id, o] : outputs_) {
        o->ring.clear();
        if (o->modeBlobId != 0 && drmFd_ >= 0) {
            drmModeDestroyPropertyBlob(drmFd_, o->modeBlobId);
            o->modeBlobId = 0;
        }
    }
    outputs_.clear();
    usedCrtcs_.clear();
    if (gbm_) {
        gbm_device_destroy(gbm_);
        gbm_ = nullptr;
    }
    deviceId_ = 0;
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

    // 4: pick the primary connector (env var OVERDRAW_CONNECTOR may pin a name).
    DrmTopology primaryTopo{};
    const char* prefer = ::getenv("OVERDRAW_CONNECTOR");
    if (!pickConnector(drmFd_, prefer ? prefer : std::string{},
                       primaryTopo.connectorId, primaryTopo.connectorName,
                       primaryTopo.mode)) {
        return false;
    }

    // 8: GBM device on the DRM fd, shared by every output's scanout ring.
    gbm_ = gbm_create_device(drmFd_);
    if (!gbm_) {
        std::fprintf(stderr, "[kms] gbm_create_device failed: %s\n", std::strerror(errno));
        return false;
    }

    // Build the driven-output list: the primary connector first (outputId 0),
    // then every other connected connector in enumeration order. Each gets a
    // DISTINCT CRTC (excluding ones already claimed this session) + primary
    // plane + resolved property ids via connectOutput(). A connector that
    // can't get a distinct CRTC/plane is logged and skipped -- the others
    // still work. Skipped connectors are NOT retried inside open(); a later
    // rescan() (e.g. after an existing output disconnects, freeing its CRTC)
    // does retry.
    if (!connectOutput(std::move(primaryTopo), 0)) {
        std::fprintf(stderr, "[kms] primary output bring-up failed\n");
        return false;
    }
    const uint32_t primaryConnectorId = outputs_[0]->topo.connectorId;

    for (auto& c : enumerateConnectors(drmFd_)) {
        if (c.connectorId == primaryConnectorId) continue;
        DrmTopology topo{};
        topo.connectorId = c.connectorId;
        topo.connectorName = c.name;
        topo.mode = c.mode;
        connectOutput(std::move(topo), allocateOutputId());
    }

    // Steps 9-13 (scanout rings + initial modeset) happen in initScanout(),
    // which needs the GPU device.
    return true;
}

bool KmsOutputBackend::connectOutput(DrmTopology topo, uint32_t outputId) {
    // pickCrtc takes a vector view of the used set; rebuild it cheaply each
    // call. usedCrtcs_ is the source of truth.
    std::vector<uint32_t> usedView(usedCrtcs_.begin(), usedCrtcs_.end());
    if (!pickCrtc(drmFd_, topo.connectorId, topo.crtcId, usedView)) {
        std::fprintf(stderr, "[kms] connector %s id=%u: no distinct CRTC; skipping\n",
                     topo.connectorName.c_str(), topo.connectorId);
        return false;
    }
    if (!pickPrimaryPlane(drmFd_, topo.crtcId, topo.planeId)) {
        std::fprintf(stderr, "[kms] connector %s id=%u crtc=%u: no primary plane; skipping\n",
                     topo.connectorName.c_str(), topo.connectorId, topo.crtcId);
        return false;
    }
    if (!resolveProperties(drmFd_, topo)) {
        std::fprintf(stderr, "[kms] connector %s id=%u: property resolve failed; skipping\n",
                     topo.connectorName.c_str(), topo.connectorId);
        return false;
    }
    usedCrtcs_.insert(topo.crtcId);
    std::printf("[kms] output %u connector %s id=%u mode=%ux%u @%umHz crtc=%u plane=%u\n",
                outputId, topo.connectorName.c_str(), topo.connectorId,
                topo.mode.hdisplay, topo.mode.vdisplay, topo.mode.vrefreshMhz,
                topo.crtcId, topo.planeId);
    auto out = std::make_unique<PerOutput>();
    out->outputId = outputId;
    out->topo = std::move(topo);
    outputs_.emplace(outputId, std::move(out));
    return true;
}

void KmsOutputBackend::disconnectOutput(uint32_t outputId) {
    auto it = outputs_.find(outputId);
    if (it == outputs_.end()) return;
    PerOutput& o = *it->second;

    // Software teardown only. The connector is already off (it vanished, or
    // the kernel disabled it on our behalf via udev). The next time this
    // CRTC is reused for a different connector, that connect's initial
    // ALLOW_MODESET commit fully reprograms it. If we ever support
    // electively disabling an output while it's still physically connected
    // (M8 \"disabled output\"), we'd want an atomic-disable commit here.
    usedCrtcs_.erase(o.topo.crtcId);
    o.ring.clear();
    if (o.modeBlobId != 0 && drmFd_ >= 0) {
        drmModeDestroyPropertyBlob(drmFd_, o.modeBlobId);
        o.modeBlobId = 0;
    }
    std::printf("[kms] output %u connector %s disconnected (crtc %u released)\n",
                outputId, o.topo.connectorName.c_str(), o.topo.crtcId);
    outputs_.erase(it);
}

uint32_t KmsOutputBackend::allocateOutputId() const {
    for (uint32_t i = 0; ; ++i) {
        if (outputs_.find(i) == outputs_.end()) return i;
    }
}

KmsOutputBackend::RescanResult KmsOutputBackend::rescan() {
    RescanResult result;
    if (drmFd_ < 0) return result;

    // Phase 1: scan. enumerateConnectors() returns every connector that
    // currently reports connection==CONNECTED with a usable mode.
    auto live = enumerateConnectors(drmFd_);

    // Index live connectors by id for fast lookup, and build the
    // already-claimed connector set for phase 4 dedup.
    std::unordered_map<uint32_t, const ConnectorInfo*> liveById;
    liveById.reserve(live.size());
    for (const auto& c : live) liveById.emplace(c.connectorId, &c);

    std::unordered_set<uint32_t> claimedConnectors;
    claimedConnectors.reserve(outputs_.size());
    for (const auto& [id, o] : outputs_) claimedConnectors.insert(o->topo.connectorId);

    // Phase 2: disconnect-vanished. An output's connector that is no longer
    // in the live set goes away. Iterate over a snapshot of ids so we can
    // erase from outputs_ during the walk.
    std::vector<uint32_t> ids = outputIds();
    for (uint32_t id : ids) {
        const auto it = outputs_.find(id);
        if (it == outputs_.end()) continue;
        const uint32_t connId = it->second->topo.connectorId;
        if (liveById.find(connId) == liveById.end()) {
            result.removed.push_back(id);
            disconnectOutput(id);
        }
    }

    // Phase 3: recheck-CRTCs is currently a no-op for already-assigned
    // outputs (see RescanResult docstring for the limitation). Phase 4
    // (below) is the actual two-pass for connectors-without-an-output:
    // they try to claim a free CRTC each rescan, picking up CRTCs freed by
    // phase 2.

    // Phase 4: connect-new. Any live connector that doesn't already back
    // a live output tries to claim a free CRTC + plane and join outputs_.
    // A connector that fails (e.g. no matching free CRTC) is silently
    // skipped this rescan; the next rescan retries it.
    for (const auto& c : live) {
        if (claimedConnectors.count(c.connectorId)) continue;
        DrmTopology topo{};
        topo.connectorId   = c.connectorId;
        topo.connectorName = c.name;
        topo.mode          = c.mode;
        const uint32_t newId = allocateOutputId();
        if (connectOutput(std::move(topo), newId)) {
            result.added.push_back(newId);
        }
    }

    return result;
}

bool KmsOutputBackend::initRingFor(PerOutput& o, const wgpu::Device& device) {
    // The compositor's render format. We use BGRA8Unorm-equivalent on the
    // wgpu side; the matching DRM fourcc is XRGB8888 (alpha discarded at
    // scanout). The compositor's clear-color path uses BGRA8Unorm; matching
    // the format here keeps the JS side's render passes unchanged.
    constexpr uint32_t kFourcc = DRM_FORMAT_XRGB8888;

    // Per-plane modifier set the kernel advertises for this format. May be
    // empty on older drivers; the ring then falls back to LINEAR.
    std::vector<PlaneFormatModifier> planeFormats =
        readPlaneFormats(drmFd_, o.topo.planeId, o.topo.planeProps.in_formats);
    return o.ring.init(drmFd_, gbm_, device,
                       o.topo.mode.hdisplay, o.topo.mode.vdisplay, kFourcc,
                       planeFormats);
}

bool KmsOutputBackend::initScanout(const wgpu::Device& device) {
    if (drmFd_ < 0 || !gbm_ || outputs_.empty()) {
        std::fprintf(stderr, "[kms] initScanout: open() not completed\n");
        return false;
    }

    // Primary (lowest live id) ring failure is fatal; a secondary ring failure
    // drops that output. The lowest id is 0 right after open(); using outputIds()
    // keeps this correct under churn.
    std::vector<uint32_t> ids = outputIds();
    if (!initRingFor(*outputs_[ids[0]], device)) {
        std::fprintf(stderr, "[kms] primary scanout ring init failed\n");
        return false;
    }
    for (size_t i = 1; i < ids.size(); ++i) {
        const uint32_t id = ids[i];
        if (!initRingFor(*outputs_[id], device)) {
            std::fprintf(stderr, "[kms] output %u scanout ring init failed; dropping\n", id);
            outputs_[id]->ring.clear();
            outputs_.erase(id);
        }
    }
    return true;
}

bool KmsOutputBackend::initScanoutForOutput(uint32_t outputId,
                                            const wgpu::Device& device) {
    if (drmFd_ < 0 || !gbm_) {
        std::fprintf(stderr, "[kms] initScanoutForOutput: backend not open\n");
        return false;
    }
    PerOutput* o = find(outputId);
    if (!o) {
        std::fprintf(stderr, "[kms] initScanoutForOutput: unknown outputId=%u\n", outputId);
        return false;
    }
    if (!initRingFor(*o, device)) {
        std::fprintf(stderr, "[kms] output %u scanout ring init failed; dropping\n",
                     outputId);
        // Caller treats this as a hard-drop: the connector came up but the
        // ring wouldn't allocate (modifier mismatch, GBM exhaustion, ...).
        // Remove from outputs_ so the next rescan can retry it from scratch
        // rather than leaving a half-built entry.
        disconnectOutput(outputId);
        return false;
    }
    return true;
}

void KmsOutputBackend::fillIdentity(uint32_t connectorId, const std::string& name,
                                    OutputDescriptorInfo& out) const {
    EdidInfo edid;
    if (drmFd_ >= 0 && connectorId && readEdid(drmFd_, connectorId, edid)) {
        out.physicalWidthMm  = edid.physicalWidthMm;
        out.physicalHeightMm = edid.physicalHeightMm;
        // Connector name: e.g. "eDP-1". Real, drm-known identity.
        std::strncpy(out.name, name.c_str(), sizeof(out.name) - 1);
        // Make = "overdraw" (we don't expose the host manufacturer; same as
        // nested-mode policy).
        std::strncpy(out.make, "overdraw", sizeof(out.make) - 1);
        // Model: EDID product name if available, else the connector name.
        const std::string& model = !edid.productName.empty() ? edid.productName : name;
        std::strncpy(out.model, model.c_str(), sizeof(out.model) - 1);
        // Durable identifier (multi-output-design §3). Empty when the EDID
        // header didn't parse; the core falls back to the connector name.
        std::strncpy(out.edidId, edid.stableId.c_str(), sizeof(out.edidId) - 1);
    } else {
        std::strncpy(out.name, name.c_str(), sizeof(out.name) - 1);
        std::strncpy(out.make, "overdraw", sizeof(out.make) - 1);
        std::strncpy(out.model, name.c_str(), sizeof(out.model) - 1);
        // edidId stays empty (default-constructed); core falls back to name.
    }
}

void KmsOutputBackend::describeFrom(const PerOutput& o, OutputDescriptorInfo& out) const {
    out.width            = o.topo.mode.hdisplay;
    out.height           = o.topo.mode.vdisplay;
    out.refreshMhz       = o.topo.mode.vrefreshMhz;
    out.scale            = 1;
    out.transform        = 0;
    fillIdentity(o.topo.connectorId, o.topo.connectorName, out);
}

OutputSize KmsOutputBackend::size() const {
    if (outputs_.empty()) return { 0, 0 };
    // Lowest live outputId -- "primary"-ish, in the sense relevant to legacy
    // single-output callers (the OutputBackend interface). After churn this
    // may not be the connector that was outputId 0 at startup; that's fine,
    // the OutputBackend interface doesn't promise identity stability.
    std::vector<uint32_t> ids = outputIds();
    auto it = outputs_.find(ids[0]);
    return { it->second->topo.mode.hdisplay, it->second->topo.mode.vdisplay };
}

void KmsOutputBackend::describeOutput(OutputDescriptorInfo& out) const {
    if (outputs_.empty()) {
        out = OutputDescriptorInfo{};
        return;
    }
    std::vector<uint32_t> ids = outputIds();
    describeFrom(*outputs_.find(ids[0])->second, out);
}

std::vector<uint32_t> KmsOutputBackend::outputIds() const {
    std::vector<uint32_t> ids;
    ids.reserve(outputs_.size());
    for (const auto& [id, _o] : outputs_) ids.push_back(id);
    std::sort(ids.begin(), ids.end());
    return ids;
}

KmsOutputBackend::PerOutput* KmsOutputBackend::find(uint32_t outputId) {
    auto it = outputs_.find(outputId);
    return it == outputs_.end() ? nullptr : it->second.get();
}

const KmsOutputBackend::PerOutput* KmsOutputBackend::find(uint32_t outputId) const {
    auto it = outputs_.find(outputId);
    return it == outputs_.end() ? nullptr : it->second.get();
}

void KmsOutputBackend::describeOutputAt(uint32_t outputId, OutputDescriptorInfo& out) const {
    const PerOutput* o = find(outputId);
    if (!o) { out = OutputDescriptorInfo{}; return; }
    describeFrom(*o, out);
}

uint32_t KmsOutputBackend::crtcIdAt(uint32_t outputId) const {
    const PerOutput* o = find(outputId);
    return o ? o->topo.crtcId : 0;
}

const KmsScanoutRing::Slot& KmsOutputBackend::scanoutSlotAt(uint32_t outputId, int slotIdx) const {
    // Callers must only ask about live outputIds; we do not synthesize an
    // empty slot for absent ids (the legacy API contract is unchanged from
    // the prior outputs_[outputIdx] indexing -- accessing an absent id was
    // a precondition violation then too).
    return find(outputId)->ring.slot(slotIdx);
}

wgpu::Texture KmsOutputBackend::acquireOutputImpl(PerOutput& o, int& outSlotIdx) {
    const int idx = o.ring.acquireFree();
    outSlotIdx = idx;
    if (idx < 0) return wgpu::Texture();
    return o.ring.slot(idx).tex;
}

wgpu::Texture KmsOutputBackend::acquireScanoutAt(uint32_t outputId, int& outSlotIdx) {
    PerOutput* o = find(outputId);
    if (!o) { outSlotIdx = -1; return wgpu::Texture(); }
    return acquireOutputImpl(*o, outSlotIdx);
}

void KmsOutputBackend::pause() {
    if (paused_) return;
    paused_ = true;
    for (auto& [id, o] : outputs_) {
        o->pendingFlipSlot = -1;
        o->ring.resetAllSlotsToFree();
        o->didInitialCommit = false;
    }
    std::printf("[kms] paused (VT switched away or seat disabled)\n");
}

void KmsOutputBackend::resume() {
    if (!paused_) return;
    paused_ = false;
    std::printf("[kms] resumed (next present will re-run modeset)\n");
}

bool KmsOutputBackend::presentOutputImpl(PerOutput& o, int slotIdx, int inFenceFd) {
    if (paused_) {
        // The seat is disabled; the kernel has revoked DRM master and any
        // commit would EACCES. Swallow the present and discard the fence
        // fd (caller already closed its copy via the SCM_RIGHTS receive).
        (void)inFenceFd;
        return true;
    }
    if (slotIdx < 0 || drmFd_ < 0) return false;
    const auto& s = o.ring.slot(slotIdx);
    const DrmTopology& topo = o.topo;
    drmModeAtomicReq* req = drmModeAtomicAlloc();
    if (!req) {
        std::fprintf(stderr, "[kms] drmModeAtomicAlloc failed\n");
        return false;
    }

    const uint32_t modeW = topo.mode.hdisplay;
    const uint32_t modeH = topo.mode.vdisplay;
    auto add = [&](uint32_t obj, uint32_t prop, uint64_t v) {
        if (prop) drmModeAtomicAddProperty(req, obj, prop, v);
    };

    // Plane: which CRTC, which FB, src + crtc rects. src_* are 16.16 fixed-
    // point in buffer space; crtc_* are integers in mode space.
    add(topo.planeId, topo.planeProps.fb_id,   s.fbId);
    add(topo.planeId, topo.planeProps.crtc_id, topo.crtcId);
    add(topo.planeId, topo.planeProps.src_x,   0);
    add(topo.planeId, topo.planeProps.src_y,   0);
    add(topo.planeId, topo.planeProps.src_w,   static_cast<uint64_t>(o.ring.width())  << 16);
    add(topo.planeId, topo.planeProps.src_h,   static_cast<uint64_t>(o.ring.height()) << 16);
    add(topo.planeId, topo.planeProps.crtc_x,  0);
    add(topo.planeId, topo.planeProps.crtc_y,  0);
    add(topo.planeId, topo.planeProps.crtc_w,  modeW);
    add(topo.planeId, topo.planeProps.crtc_h,  modeH);

    // Explicit sync: tell the kernel to wait for this fence before latching.
    // The fd is dup'd by the kernel; caller still owns the original.
    if (inFenceFd >= 0 && topo.planeProps.in_fence_fd) {
        add(topo.planeId, topo.planeProps.in_fence_fd, static_cast<uint64_t>(inFenceFd));
    }

    // Atomic commit flags differ between the initial modeset and steady-state
    // page flips.
    //
    // Initial (didInitialCommit == false):
    //   ALLOW_MODESET only. The initial commit synchronously sets up the CRTC
    //   / connector / mode; it does not produce a page-flip event (kernel
    //   docs: ALLOW_MODESET and PAGE_FLIP_EVENT together are accepted but
    //   the semantics on older Intel kernels are unreliable, so we keep them
    //   separate). NONBLOCK is not used: the modeset takes effect when the
    //   commit returns.
    //
    // Steady-state (didInitialCommit == true):
    //   PAGE_FLIP_EVENT | NONBLOCK. The kernel queues the flip for the next
    //   vblank and the page-flip event arrives via drmHandleEvent on the
    //   DRM fd in pump().
    uint32_t flags = 0;
    if (!o.didInitialCommit) {
        // First commit also sets up CRTC + connector + mode.
        add(topo.connectorId, topo.connectorProps.crtc_id, topo.crtcId);
        if (o.modeBlobId == 0) {
            o.modeBlobId = createModeBlob(drmFd_, topo.mode.raw);
            if (o.modeBlobId == 0) { drmModeAtomicFree(req); return false; }
        }
        add(topo.crtcId, topo.crtcProps.mode_id, o.modeBlobId);
        add(topo.crtcId, topo.crtcProps.active,  1);
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

    const bool wasInitial = !o.didInitialCommit;
    o.didInitialCommit = true;
    o.ring.markPendingFlip(slotIdx);
    o.pendingFlipSlot = slotIdx;
    // Initial commit ran ALLOW_MODESET without PAGE_FLIP_EVENT (the kernel-
    // docs path; combining them is unreliable on some drivers). That commit
    // is synchronous -- the modeset is done by the time we return -- so the
    // kernel will NOT deliver a flip event later, and the wake/render state
    // machine would never get its first onFrameComplete. Fake one inline:
    // transition the slot to SCANOUT now and fire the listener so the next
    // render is scheduled.
    if (wasInitial) {
        const int retired = o.ring.onFlipComplete(slotIdx);
        o.pendingFlipSlot = -1;
        if (flipCompleteListener_) flipCompleteListener_(o.outputId, retired);
    }
    return true;
}

bool KmsOutputBackend::presentScanoutAt(uint32_t outputId, int slotIdx, int inFenceFd) {
    PerOutput* o = find(outputId);
    if (!o) return false;
    return presentOutputImpl(*o, slotIdx, inFenceFd);
}

void KmsOutputBackend::pageFlipTrampoline(int /*fd*/, unsigned int /*sequence*/,
                                          unsigned int /*tv_sec*/, unsigned int /*tv_usec*/,
                                          unsigned int crtc_id, void* userdata) {
    auto* self = static_cast<KmsOutputBackend*>(userdata);
    if (!self) return;
    // Route the flip to the output whose CRTC the kernel reported.
    for (auto& [id, o] : self->outputs_) {
        if (o->topo.crtcId != crtc_id) continue;
        const int flipped = o->pendingFlipSlot;
        o->pendingFlipSlot = -1;
        if (flipped < 0) return;
        const int retired = o->ring.onFlipComplete(flipped);
        if (self->flipCompleteListener_) self->flipCompleteListener_(o->outputId, retired);
        return;
    }
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
