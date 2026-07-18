#include "kms_output.h"

#include <algorithm>
#include <cerrno>
#include <cstring>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

extern "C" {
#include <gbm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm_fourcc.h>
}

#include "log/log.h"

namespace overdraw::gpu {

namespace {

// Bilinear-scale premultiplied BGRA pixels into a destination with its own
// stride. Premultiplied alpha makes channel-wise interpolation correct
// without unmultiply/remultiply.
void scaleBgraInto(uint8_t* dst, uint32_t dstStride, uint32_t dstW, uint32_t dstH,
                   const uint8_t* src, uint32_t srcW, uint32_t srcH, uint32_t srcStride) {
    for (uint32_t y = 0; y < dstH; ++y) {
        float fy = (y + 0.5f) * static_cast<float>(srcH) / static_cast<float>(dstH) - 0.5f;
        if (fy < 0) fy = 0;
        uint32_t y0 = static_cast<uint32_t>(fy);
        if (y0 > srcH - 1) y0 = srcH - 1;
        uint32_t y1 = y0 + 1 < srcH ? y0 + 1 : srcH - 1;
        const float wy = fy - static_cast<float>(y0);
        const uint8_t* row0 = src + y0 * srcStride;
        const uint8_t* row1 = src + y1 * srcStride;
        uint8_t* out = dst + y * dstStride;
        for (uint32_t x = 0; x < dstW; ++x) {
            float fx = (x + 0.5f) * static_cast<float>(srcW) / static_cast<float>(dstW) - 0.5f;
            if (fx < 0) fx = 0;
            uint32_t x0 = static_cast<uint32_t>(fx);
            if (x0 > srcW - 1) x0 = srcW - 1;
            uint32_t x1 = x0 + 1 < srcW ? x0 + 1 : srcW - 1;
            const float wx = fx - static_cast<float>(x0);
            for (int c = 0; c < 4; ++c) {
                const float top = row0[x0 * 4 + c] * (1.0f - wx) + row0[x1 * 4 + c] * wx;
                const float bot = row1[x0 * 4 + c] * (1.0f - wx) + row1[x1 * 4 + c] * wx;
                out[x * 4 + c] = static_cast<uint8_t>(top * (1.0f - wy) + bot * wy + 0.5f);
            }
        }
    }
}

}  // namespace

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
        resetTransientFlipState(*o);
        destroyCursorBos(*o);
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
}

bool KmsOutputBackend::open(const char* /*title*/) {
    if (drmFd_ < 0) {
        LOG_ERR(Gpu, "[kms] open: no DRM fd (SetDrmFd not received)");
        return false;
    }

    // 1: drmFd already received from the core.
    // 2-3: enable atomic + universal-planes caps.
    if (!enableDrmAtomicCaps(drmFd_)) return false;
    queryCursorSizeCaps(drmFd_, cursorCapW_, cursorCapH_);
    asyncFlipCap_ = queryAsyncPageFlipCap(drmFd_);
    LOG_INFO(Gpu, "[kms] atomic async page flips (tearing): {}",
             asyncFlipCap_ ? "supported" : "unsupported");

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
        LOG_ERR(Gpu, "[kms] gbm_create_device failed: {}", std::strerror(errno));
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
        LOG_ERR(Gpu, "[kms] primary output bring-up failed");
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
        LOG_WARN(Gpu, "[kms] connector {} id={}: no distinct CRTC; skipping",
                 topo.connectorName, topo.connectorId);
        return false;
    }
    if (!pickPrimaryPlane(drmFd_, topo.crtcId, topo.planeId)) {
        LOG_WARN(Gpu, "[kms] connector {} id={} crtc={}: no primary plane; skipping",
                 topo.connectorName, topo.connectorId, topo.crtcId);
        return false;
    }
    if (!resolveProperties(drmFd_, topo)) {
        LOG_WARN(Gpu, "[kms] connector {} id={}: property resolve failed; skipping",
                 topo.connectorName, topo.connectorId);
        return false;
    }
    // Cursor plane is best-effort: without one this output just uses the
    // software cursor. Exclude cursor planes other outputs already claimed.
    std::vector<uint32_t> claimedCursorPlanes;
    for (const auto& [id, other] : outputs_) {
        if (other->topo.cursorPlaneId) claimedCursorPlanes.push_back(other->topo.cursorPlaneId);
    }
    if (pickCursorPlane(drmFd_, topo.crtcId, topo.cursorPlaneId, claimedCursorPlanes)) {
        resolveCursorPlaneProperties(drmFd_, topo);  // zeroes cursorPlaneId on failure
    }
    usedCrtcs_.insert(topo.crtcId);
    LOG_INFO(Gpu, "[kms] output {} connector {} id={} mode={}x{} @{}.{:03}Hz crtc={} plane={} cursor-plane={}",
             outputId, topo.connectorName, topo.connectorId,
             topo.mode.hdisplay, topo.mode.vdisplay,
             topo.mode.vrefreshMhz / 1000, topo.mode.vrefreshMhz % 1000,
             topo.crtcId, topo.planeId, topo.cursorPlaneId);
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
    // electively disabling an output while it's still physically connected,
    // we'd want an atomic-disable commit here.
    usedCrtcs_.erase(o.topo.crtcId);
    o.ring.clear();
    resetTransientFlipState(o);
    destroyCursorBos(o);
    if (o.modeBlobId != 0 && drmFd_ >= 0) {
        drmModeDestroyPropertyBlob(drmFd_, o.modeBlobId);
        o.modeBlobId = 0;
    }
    LOG_INFO(Gpu, "[kms] output {} connector {} disconnected (crtc {} released)",
             outputId, o.topo.connectorName, o.topo.crtcId);
    outputs_.erase(it);
}

bool KmsOutputBackend::ensureCursorBos(PerOutput& o) {
    if (o.cursorBos[0].fbId) return true;
    for (int i = 0; i < 2; ++i) {
        CursorBo& b = o.cursorBos[i];
        drm_mode_create_dumb create{};
        create.width  = cursorCapW_;
        create.height = cursorCapH_;
        create.bpp    = 32;
        if (drmIoctl(drmFd_, DRM_IOCTL_MODE_CREATE_DUMB, &create) != 0) {
            LOG_ERR(Gpu, "[kms] cursor dumb-buffer create failed: {}",
                    std::strerror(errno));
            destroyCursorBos(o);
            return false;
        }
        b.handle = create.handle;
        b.pitch  = create.pitch;
        b.size   = create.size;
        drm_mode_map_dumb mapReq{};
        mapReq.handle = b.handle;
        if (drmIoctl(drmFd_, DRM_IOCTL_MODE_MAP_DUMB, &mapReq) != 0) {
            LOG_ERR(Gpu, "[kms] cursor dumb-buffer map failed: {}",
                    std::strerror(errno));
            destroyCursorBos(o);
            return false;
        }
        b.map = ::mmap(nullptr, b.size, PROT_READ | PROT_WRITE, MAP_SHARED,
                       drmFd_, mapReq.offset);
        if (b.map == MAP_FAILED) {
            b.map = nullptr;
            LOG_ERR(Gpu, "[kms] cursor dumb-buffer mmap failed: {}",
                    std::strerror(errno));
            destroyCursorBos(o);
            return false;
        }
        std::memset(b.map, 0, b.size);
        uint32_t handles[4] = { b.handle, 0, 0, 0 };
        uint32_t pitches[4] = { b.pitch, 0, 0, 0 };
        uint32_t offsets[4] = { 0, 0, 0, 0 };
        if (drmModeAddFB2(drmFd_, cursorCapW_, cursorCapH_, DRM_FORMAT_ARGB8888,
                          handles, pitches, offsets, &b.fbId, 0) != 0) {
            LOG_ERR(Gpu, "[kms] cursor AddFB2 failed: {}", std::strerror(errno));
            destroyCursorBos(o);
            return false;
        }
    }
    return true;
}

void KmsOutputBackend::destroyCursorBos(PerOutput& o) {
    for (CursorBo& b : o.cursorBos) {
        if (b.map) { ::munmap(b.map, b.size); b.map = nullptr; }
        if (b.fbId && drmFd_ >= 0) { drmModeRmFB(drmFd_, b.fbId); }
        b.fbId = 0;
        if (b.handle && drmFd_ >= 0) {
            drm_mode_destroy_dumb destroy{};
            destroy.handle = b.handle;
            drmIoctl(drmFd_, DRM_IOCTL_MODE_DESTROY_DUMB, &destroy);
        }
        b.handle = 0;
        b.pitch = 0;
        b.size = 0;
    }
    o.cursorImageValid = false;
}

void KmsOutputBackend::resetTransientFlipState(PerOutput& o) {
    o.cursorFlipPending = false;
    // Retire every client buffer this output still references (latched,
    // in a pending flip, or stashed) -- no flip event will arrive for
    // them, and the core must release them. Dedupe: the same buffer can
    // appear in more than one slot across a fast transition.
    uint32_t retire[3] = { o.latchedClientBufId, o.pendingClientBufId,
                           o.stashed.clientBufId };
    for (int i = 0; i < 3; ++i) {
        if (retire[i] == 0) continue;
        bool dup = false;
        for (int j = 0; j < i; ++j) if (retire[j] == retire[i]) dup = true;
        if (!dup && clientFlipListener_) {
            clientFlipListener_({ o.outputId, 0, retire[i], 0, 0, 0 });
        }
    }
    o.latchedClientFbId = 0;
    o.latchedClientBufId = 0;
    o.pendingClientFbId = 0;
    o.pendingClientBufId = 0;
    o.clientFlipPending = false;
    if (o.stashed.fence >= 0) ::close(o.stashed.fence);
    o.stashed = {};
    sweepCondemnedFbs();
}

void KmsOutputBackend::stashPresent(PerOutput& o, int slotIdx, uint32_t clientFbId,
                                    uint32_t clientBufId, uint32_t clientW,
                                    uint32_t clientH, int inFenceFd, bool tearing) {
    if (o.stashed.valid) {
        // Mailbox: the newer present supersedes the stashed one. A dropped
        // CLIENT present's buffer will never latch -- report it retired so
        // the core releases it.
        LOG_WARN(Gpu,
            "[kms] present stashed twice on output {}; dropping older (slot {} fb {})",
            o.outputId, o.stashed.slotIdx, o.stashed.clientFbId);
        if (o.stashed.clientBufId != 0 && clientFlipListener_) {
            clientFlipListener_({ o.outputId, 0, o.stashed.clientBufId, 0, 0, 0 });
        }
        if (o.stashed.fence >= 0) ::close(o.stashed.fence);
    }
    o.stashed = {};
    o.stashed.slotIdx = slotIdx;
    o.stashed.clientFbId = clientFbId;
    o.stashed.clientBufId = clientBufId;
    o.stashed.clientW = clientW;
    o.stashed.clientH = clientH;
    o.stashed.fence = inFenceFd >= 0 ? ::fcntl(inFenceFd, F_DUPFD_CLOEXEC, 0) : -1;
    o.stashed.tearing = tearing;
    o.stashed.valid = true;
}

void KmsOutputBackend::replayStashedPresent(PerOutput& o) {
    if (!o.stashed.valid) return;
    const auto st = o.stashed;
    o.stashed = {};
    presentOutputImpl(o, st.slotIdx, st.fence, st.clientFbId, st.clientBufId,
                      st.clientW, st.clientH, st.tearing);
    if (st.fence >= 0) ::close(st.fence);
}

void KmsOutputBackend::noteLatch(PerOutput& o, uint32_t latchedFb, uint32_t latchedBuf,
                                 uint64_t tvSec, uint32_t tvNsec, uint32_t seq) {
    const uint32_t retired =
        (o.latchedClientBufId != 0 && o.latchedClientBufId != latchedBuf)
            ? o.latchedClientBufId : 0;
    o.latchedClientFbId = latchedFb;
    o.latchedClientBufId = latchedBuf;
    if ((latchedBuf != 0 || retired != 0) && clientFlipListener_) {
        clientFlipListener_({ o.outputId, latchedBuf, retired, tvSec, tvNsec, seq });
    }
    sweepCondemnedFbs();
}

void KmsOutputBackend::sweepCondemnedFbs() {
    if (condemnedClientFbs_.empty() || drmFd_ < 0) return;
    auto inUse = [&](uint32_t fb) {
        for (const auto& [id, o] : outputs_) {
            if (o->latchedClientFbId == fb || o->pendingClientFbId == fb
                || (o->stashed.valid && o->stashed.clientFbId == fb)) {
                return true;
            }
        }
        return false;
    };
    for (auto it = condemnedClientFbs_.begin(); it != condemnedClientFbs_.end();) {
        if (inUse(*it)) { ++it; continue; }
        drmModeRmFB(drmFd_, *it);
        it = condemnedClientFbs_.erase(it);
    }
}

uint32_t KmsOutputBackend::importClientFb(int dmabufFd, uint32_t width, uint32_t height,
                                          uint32_t fourcc, uint64_t modifier,
                                          uint32_t offset, uint32_t stride) {
    if (drmFd_ < 0 || dmabufFd < 0) return 0;
    uint32_t handle = 0;
    if (drmPrimeFDToHandle(drmFd_, dmabufFd, &handle) != 0) {
        LOG_ERR(Gpu, "[kms] scanout: PrimeFDToHandle failed: {}",
                std::strerror(errno));
        return 0;
    }
    uint32_t handles[4] = { handle, 0, 0, 0 };
    uint32_t pitches[4] = { stride, 0, 0, 0 };
    uint32_t offsets[4] = { offset, 0, 0, 0 };
    uint64_t modifiers[4] = { modifier, 0, 0, 0 };
    uint32_t fbId = 0;
    int rc;
    if (modifier != DRM_FORMAT_MOD_INVALID) {
        rc = drmModeAddFB2WithModifiers(drmFd_, width, height, fourcc,
                                        handles, pitches, offsets, modifiers,
                                        &fbId, DRM_MODE_FB_MODIFIERS);
    } else {
        rc = drmModeAddFB2(drmFd_, width, height, fourcc,
                           handles, pitches, offsets, &fbId, 0);
    }
    // The FB holds its own reference to the BO; drop ours. Client dmabufs
    // are not otherwise imported on this card fd (rendering imports go
    // through the render node), so no handle aliasing to worry about.
    drmCloseBufferHandle(drmFd_, handle);
    if (rc != 0) {
        LOG_ERR(Gpu,
            "[kms] scanout: AddFB2 {}x{} fourcc=0x{:08x} mod=0x{:016x} failed: {}",
            width, height, fourcc, modifier, std::strerror(errno));
        return 0;
    }
    return fbId;
}

bool KmsOutputBackend::presentClientFbAt(uint32_t outputId, uint32_t fbId,
                                         uint32_t width, uint32_t height,
                                         uint32_t bufferId, int inFenceFd,
                                         bool tearing) {
    PerOutput* o = find(outputId);
    if (!o || fbId == 0) return false;
    return presentOutputImpl(*o, -1, inFenceFd, fbId, bufferId, width, height, tearing);
}

void KmsOutputBackend::condemnClientFb(uint32_t fbId) {
    if (fbId == 0) return;
    condemnedClientFbs_.push_back(fbId);
    sweepCondemnedFbs();
}

std::vector<PlaneFormatModifier>
KmsOutputBackend::primaryPlaneFormatsAt(uint32_t outputId) const {
    const PerOutput* o = find(outputId);
    if (!o) return {};
    return readPlaneFormats(drmFd_, o->topo.planeId, o->topo.planeProps.in_formats);
}

bool KmsOutputBackend::cursorPlaneInfoAt(uint32_t outputId,
                                         uint32_t& outW, uint32_t& outH) const {
    const PerOutput* o = find(outputId);
    if (!o || !o->topo.cursorPlaneId || o->cursorDemoted) return false;
    outW = cursorCapW_;
    outH = cursorCapH_;
    return true;
}

bool KmsOutputBackend::setCursorImage(uint32_t outputId, const uint8_t* pixels,
                                      uint32_t srcW, uint32_t srcH, uint32_t srcStride,
                                      uint32_t dstW, uint32_t dstH) {
    PerOutput* o = find(outputId);
    if (!o || !o->topo.cursorPlaneId || o->cursorDemoted) return false;
    if (!pixels || srcW == 0 || srcH == 0 || dstW == 0 || dstH == 0) return false;
    if (srcStride < srcW * 4) return false;
    // The core pre-checks dims against the caps it received; this is the
    // defensive backstop.
    if (dstW > cursorCapW_ || dstH > cursorCapH_) return false;
    if (!ensureCursorBos(*o)) {
        // Allocation failure is not going to heal; stop trying.
        o->cursorDemoted = true;
        return false;
    }
    CursorBo& back = o->cursorBos[1 - o->cursorFrontBo];
    std::memset(back.map, 0, back.size);
    uint8_t* dst = static_cast<uint8_t*>(back.map);
    if (srcW == dstW && srcH == dstH) {
        for (uint32_t y = 0; y < srcH; ++y) {
            std::memcpy(dst + y * back.pitch, pixels + y * srcStride, srcW * 4u);
        }
    } else {
        scaleBgraInto(dst, back.pitch, dstW, dstH, pixels, srcW, srcH, srcStride);
    }
    o->cursorFrontBo = 1 - o->cursorFrontBo;
    o->cursorImageValid = true;
    o->cursorDirty = true;
    maybeCursorCommit(*o);
    return true;
}

void KmsOutputBackend::setCursorState(uint32_t outputId, int32_t x, int32_t y,
                                      bool visible, bool commitNow) {
    PerOutput* o = find(outputId);
    if (!o || !o->topo.cursorPlaneId || o->cursorDemoted) return;
    o->cursorX = x;
    o->cursorY = y;
    o->cursorVisible = visible;
    o->cursorDirty = true;
    if (commitNow) o->cursorCommitRequested = true;
    maybeCursorCommit(*o);
}

void KmsOutputBackend::addCursorPlaneState(drmModeAtomicReq* req, PerOutput& o) const {
    const uint32_t plane = o.topo.cursorPlaneId;
    if (!plane) return;
    const auto& cp = o.topo.cursorPlaneProps;
    auto add = [&](uint32_t prop, uint64_t v) {
        if (prop) drmModeAtomicAddProperty(req, plane, prop, v);
    };
    if (o.cursorVisible && o.cursorImageValid && !o.cursorDemoted) {
        const CursorBo& b = o.cursorBos[o.cursorFrontBo];
        add(cp.fb_id,   b.fbId);
        add(cp.crtc_id, o.topo.crtcId);
        add(cp.src_x,   0);
        add(cp.src_y,   0);
        add(cp.src_w,   static_cast<uint64_t>(cursorCapW_) << 16);
        add(cp.src_h,   static_cast<uint64_t>(cursorCapH_) << 16);
        // CRTC_X/Y are signed: a cursor straddling the output's top/left
        // edge goes negative, carried as two's complement in the u64.
        add(cp.crtc_x,  static_cast<uint64_t>(static_cast<int64_t>(o.cursorX)));
        add(cp.crtc_y,  static_cast<uint64_t>(static_cast<int64_t>(o.cursorY)));
        add(cp.crtc_w,  cursorCapW_);
        add(cp.crtc_h,  cursorCapH_);
    } else {
        add(cp.fb_id,   0);
        add(cp.crtc_id, 0);
    }
}

void KmsOutputBackend::maybeCursorCommit(PerOutput& o) {
    if (paused_ || drmFd_ < 0) return;
    if (!o.cursorDirty || !o.cursorCommitRequested) return;
    if (!o.didInitialCommit) return;  // the initial modeset carries it
    // Commits are serialized per CRTC: while any flip is in flight, the
    // desired state is picked up either by the arriving present (frame
    // path) or re-checked from that flip's completion event.
    if (o.pendingFlipSlot != -1 || o.cursorFlipPending || o.clientFlipPending) return;
    if (!o.topo.cursorPlaneId || o.cursorDemoted) return;
    drmModeAtomicReq* req = drmModeAtomicAlloc();
    if (!req) return;
    addCursorPlaneState(req, o);
    int rc = drmModeAtomicCommit(drmFd_, req, DRM_MODE_ATOMIC_TEST_ONLY, this);
    if (rc == 0) {
        rc = drmModeAtomicCommit(drmFd_, req,
                                 DRM_MODE_PAGE_FLIP_EVENT | DRM_MODE_ATOMIC_NONBLOCK,
                                 this);
    }
    drmModeAtomicFree(req);
    if (rc != 0) {
        LOG_WARN(Gpu,
            "[kms] cursor-only commit failed ({}); software cursor for output {}",
            std::strerror(errno), o.outputId);
        demoteCursor(o);
        return;
    }
    o.cursorFlipPending = true;
    o.cursorDirty = false;
    o.cursorCommitRequested = false;
}

void KmsOutputBackend::demoteCursor(PerOutput& o, bool issueDisableCommit) {
    if (o.cursorDemoted) return;
    o.cursorDemoted = true;
    o.cursorVisible = false;
    o.cursorDirty = false;
    o.cursorCommitRequested = false;
    // Best-effort: turn the plane off now if nothing is in flight. If a
    // flip IS in flight, the next commit (frame or stashed present) emits
    // the disable via addCursorPlaneState.
    if (issueDisableCommit && !paused_ && o.didInitialCommit && o.pendingFlipSlot == -1
        && !o.cursorFlipPending && !o.clientFlipPending && o.topo.cursorPlaneId) {
        drmModeAtomicReq* req = drmModeAtomicAlloc();
        if (req) {
            addCursorPlaneState(req, o);  // demoted -> plane-off props
            if (drmModeAtomicCommit(drmFd_, req,
                                    DRM_MODE_PAGE_FLIP_EVENT | DRM_MODE_ATOMIC_NONBLOCK,
                                    this) == 0) {
                o.cursorFlipPending = true;
            }
            drmModeAtomicFree(req);
        }
    }
    if (cursorFallbackListener_) cursorFallbackListener_(o.outputId);
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

    // Index live connectors by id for fast lookup.
    std::unordered_map<uint32_t, const ConnectorInfo*> liveById;
    liveById.reserve(live.size());
    for (const auto& c : live) liveById.emplace(c.connectorId, &c);

    // Phase 2: disconnect-vanished + recycle-bad-link. An output's connector
    // that is no longer in the live set goes away. A connector that is still
    // connected but whose link-status property reads BAD needs the link
    // re-trained: the kernel signals this (hotplug uevent, connector still
    // CONNECTED) after e.g. a DP monitor power-cycles without dropping HPD,
    // and the only recovery is a fresh ALLOW_MODESET commit. Force the full
    // disconnect/reconnect cycle -- phase 4 re-adds the connector, and the
    // re-added output's initial commit re-modesets and writes link-status
    // GOOD. Iterate over a snapshot of ids so we can erase from outputs_
    // during the walk.
    std::vector<uint32_t> ids = outputIds();
    for (uint32_t id : ids) {
        const auto it = outputs_.find(id);
        if (it == outputs_.end()) continue;
        const auto& topo = it->second->topo;
        const bool vanished = liveById.find(topo.connectorId) == liveById.end();
        if (!vanished && !connectorLinkStatusBad(drmFd_, topo.connectorId,
                                                 topo.connectorProps.link_status)) {
            continue;
        }
        if (!vanished) {
            LOG_WARN(Gpu, "[kms] connector {} link-status BAD; recycling output {} to force a modeset",
                     topo.connectorName, id);
        }
        result.removed.push_back(id);
        disconnectOutput(id);
    }

    // Built after phase 2 so a just-recycled connector is not counted as
    // claimed -- phase 4 must pick it back up in this same rescan.
    std::unordered_set<uint32_t> claimedConnectors;
    claimedConnectors.reserve(outputs_.size());
    for (const auto& [id, o] : outputs_) claimedConnectors.insert(o->topo.connectorId);

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
        LOG_ERR(Gpu, "[kms] initScanout: open() not completed");
        return false;
    }

    // Primary (lowest live id) ring failure is fatal; a secondary ring failure
    // drops that output. The lowest id is 0 right after open(); using outputIds()
    // keeps this correct under churn.
    std::vector<uint32_t> ids = outputIds();
    if (!initRingFor(*outputs_[ids[0]], device)) {
        LOG_ERR(Gpu, "[kms] primary scanout ring init failed");
        return false;
    }
    for (size_t i = 1; i < ids.size(); ++i) {
        const uint32_t id = ids[i];
        if (!initRingFor(*outputs_[id], device)) {
            LOG_WARN(Gpu, "[kms] output {} scanout ring init failed; dropping", id);
            outputs_[id]->ring.clear();
            outputs_.erase(id);
        }
    }
    return true;
}

bool KmsOutputBackend::initScanoutForOutput(uint32_t outputId,
                                            const wgpu::Device& device) {
    if (drmFd_ < 0 || !gbm_) {
        LOG_ERR(Gpu, "[kms] initScanoutForOutput: backend not open");
        return false;
    }
    PerOutput* o = find(outputId);
    if (!o) {
        LOG_ERR(Gpu, "[kms] initScanoutForOutput: unknown outputId={}", outputId);
        return false;
    }
    if (!initRingFor(*o, device)) {
        LOG_WARN(Gpu, "[kms] output {} scanout ring init failed; dropping",
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

std::vector<DrmMode> KmsOutputBackend::enumerateModes(uint32_t outputId) const {
    const PerOutput* o = find(outputId);
    if (!o) return {};
    return enumerateModesForConnector(drmFd_, o->topo.connectorId);
}

bool KmsOutputBackend::switchMode(uint32_t outputId,
                                  uint32_t width, uint32_t height,
                                  uint32_t refreshMhz,
                                  const wgpu::Device& device) {
    PerOutput* o = find(outputId);
    if (!o) {
        LOG_ERR(Gpu, "[kms] switchMode: unknown outputId={}", outputId);
        return false;
    }
    DrmMode newMode{};
    if (!findMode(drmFd_, o->topo.connectorId, width, height, refreshMhz, newMode)) {
        LOG_WARN(Gpu,
            "[kms] switchMode: connector {} has no mode matching {}x{}@{}.{:03}Hz; ignoring",
            o->topo.connectorId, width, height,
            refreshMhz / 1000, refreshMhz % 1000);
        return false;
    }
    // No-op if already on that mode (same active dims AND refresh within
    // tolerance). Cheap to check; saves an unnecessary teardown.
    if (o->topo.mode.hdisplay == newMode.hdisplay
        && o->topo.mode.vdisplay == newMode.vdisplay
        && o->topo.mode.vrefreshMhz == newMode.vrefreshMhz) {
        return true;
    }

    // Tear down. Order matches disconnectOutput's, minus the outputs_.erase
    // (we keep the PerOutput alive across the swap; only the ring + mode
    // blob churn).
    o->ring.clear();  // releases GBM bo's, dmabuf fds, wgpu::Textures, fb_ids
    if (o->modeBlobId != 0 && drmFd_ >= 0) {
        drmModeDestroyPropertyBlob(drmFd_, o->modeBlobId);
        o->modeBlobId = 0;
    }
    // Any pending atomic flip the kernel had queued is silently cancelled by
    // the next ALLOW_MODESET commit; clear our shadow so onFlipComplete won't
    // try to advance a slot that no longer exists.
    o->pendingFlipSlot = -1;
    o->didInitialCommit = false;
    // The stashed present (if any) references the old ring; drop it. Cursor
    // image + desired state survive the mode switch (the cursor FB is
    // cap-sized, mode-independent); the post-switch modeset re-programs it.
    resetTransientFlipState(*o);
    o->cursorDirty = true;

    // Adopt the new mode.
    o->topo.mode = newMode;

    // Allocate the fresh ring at the new dims. Failure here is fatal for
    // this output -- the connector stays in outputs_ but with no ring, so
    // no frames are written for it until the caller redoes the bring-up.
    if (!initRingFor(*o, device)) {
        LOG_ERR(Gpu,
            "[kms] switchMode: ring re-init failed for outputId={} at {}x{}",
            outputId, newMode.hdisplay, newMode.vdisplay);
        return false;
    }
    LOG_INFO(Gpu, "[kms] output {} switched to {}x{}@{}.{:03}Hz",
             outputId, newMode.hdisplay, newMode.vdisplay,
             newMode.vrefreshMhz / 1000, newMode.vrefreshMhz % 1000);
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

const KmsScanoutRing::Slot& KmsOutputBackend::scanoutSlotAt(uint32_t outputId, int slotIdx) const {
    // Callers must only ask about live outputIds; we do not synthesize an
    // empty slot for absent ids (the legacy API contract is unchanged from
    // the prior outputs_[outputIdx] indexing -- accessing an absent id was
    // a precondition violation then too).
    return find(outputId)->ring.slot(slotIdx);
}

void KmsOutputBackend::pause() {
    if (paused_) return;
    paused_ = true;
    for (auto& [id, o] : outputs_) {
        o->pendingFlipSlot = -1;
        o->ring.resetAllSlotsToFree();
        o->didInitialCommit = false;
        // No flip event will arrive for a commit the revoked master had in
        // flight; the post-resume modeset re-programs the cursor plane from
        // the (kept) desired state.
        resetTransientFlipState(*o);
        o->cursorDirty = true;
    }
    LOG_INFO(Gpu, "[kms] paused (VT switched away or seat disabled)");
}

void KmsOutputBackend::resume() {
    if (!paused_) return;
    paused_ = false;
    LOG_INFO(Gpu, "[kms] resumed (next present will re-run modeset)");
}

bool KmsOutputBackend::presentOutputImpl(PerOutput& o, int slotIdx, int inFenceFd,
                                         uint32_t clientFbId, uint32_t clientBufId,
                                         uint32_t clientW, uint32_t clientH,
                                         bool tearing) {
    if (paused_) {
        // The seat is disabled; the kernel has revoked DRM master and any
        // commit would EACCES. Swallow the present and discard the fence
        // fd (caller already closed its copy via the SCM_RIGHTS receive).
        (void)inFenceFd;
        return true;
    }
    const bool isClient = clientFbId != 0;
    if ((!isClient && slotIdx < 0) || drmFd_ < 0) return false;
    // One commit in flight per CRTC, across all three commit kinds (ring
    // present, client-scanout present, cursor-only). A present arriving
    // while another flip is pending is stashed and issued from that
    // flip's completion event (sub-vblank delay, and rare: transition
    // frames only -- the frame clock otherwise serializes presents).
    if (o.cursorFlipPending || o.clientFlipPending
        || (isClient && o.pendingFlipSlot != -1)) {
        stashPresent(o, slotIdx, clientFbId, clientBufId, clientW, clientH,
                     inFenceFd, tearing);
        return true;
    }
    const uint32_t fbId = isClient ? clientFbId : o.ring.slot(slotIdx).fbId;
    const uint32_t srcW = isClient ? clientW : o.ring.width();
    const uint32_t srcH = isClient ? clientH : o.ring.height();
    const DrmTopology& topo = o.topo;

    const uint32_t modeW = topo.mode.hdisplay;
    const uint32_t modeH = topo.mode.vdisplay;

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
    // wp_tearing_control: an async-requested client present flips
    // immediately (mid-scanout, visible tear) instead of waiting for
    // vblank. Only meaningful on a steady-state flip; the modeset commit
    // can't tear. Kept best-effort: the TEST below drops the flag when
    // the kernel refuses (a commit that changes more than the primary
    // FB_ID -- e.g. the cursor moved this frame -- or a driver limit).
    const bool wantAsync = tearing && isClient && asyncFlipCap_ && o.didInitialCommit;

    uint32_t flags = 0;
    if (!o.didInitialCommit) {
        if (o.modeBlobId == 0) {
            o.modeBlobId = createModeBlob(drmFd_, topo.mode.raw);
            if (o.modeBlobId == 0) return false;
        }
        flags = DRM_MODE_ATOMIC_ALLOW_MODESET;
    } else {
        flags = DRM_MODE_PAGE_FLIP_EVENT | DRM_MODE_ATOMIC_NONBLOCK;
        if (wantAsync) flags |= DRM_MODE_PAGE_FLIP_ASYNC;
    }

    // Built as a lambda so the cursor-demotion path below can rebuild the
    // request (identical but for the cursor plane now emitting its
    // plane-off props) without duplicating this block.
    auto buildReq = [&]() -> drmModeAtomicReq* {
        drmModeAtomicReq* req = drmModeAtomicAlloc();
        if (!req) {
            LOG_ERR(Gpu, "[kms] drmModeAtomicAlloc failed");
            return nullptr;
        }
        auto add = [&](uint32_t obj, uint32_t prop, uint64_t v) {
            if (prop) drmModeAtomicAddProperty(req, obj, prop, v);
        };

        // Plane: which CRTC, which FB, src + crtc rects. src_* are 16.16
        // fixed-point in buffer space; crtc_* are integers in mode space.
        // The FB is either this frame's ring slot or a client dmabuf
        // being scanned out directly.
        add(topo.planeId, topo.planeProps.fb_id,   fbId);
        add(topo.planeId, topo.planeProps.crtc_id, topo.crtcId);
        add(topo.planeId, topo.planeProps.src_x,   0);
        add(topo.planeId, topo.planeProps.src_y,   0);
        add(topo.planeId, topo.planeProps.src_w,   static_cast<uint64_t>(srcW) << 16);
        add(topo.planeId, topo.planeProps.src_h,   static_cast<uint64_t>(srcH) << 16);
        add(topo.planeId, topo.planeProps.crtc_x,  0);
        add(topo.planeId, topo.planeProps.crtc_y,  0);
        add(topo.planeId, topo.planeProps.crtc_w,  modeW);
        add(topo.planeId, topo.planeProps.crtc_h,  modeH);

        // Explicit sync: tell the kernel to wait for this fence before
        // latching. The fd is dup'd by the kernel; caller still owns the
        // original.
        if (inFenceFd >= 0 && topo.planeProps.in_fence_fd) {
            add(topo.planeId, topo.planeProps.in_fence_fd, static_cast<uint64_t>(inFenceFd));
        }

        // Cursor plane rides every commit: position/visibility changes are
        // free on a commit that was happening anyway.
        addCursorPlaneState(req, o);

        if (!o.didInitialCommit) {
            // First commit also sets up CRTC + connector + mode.
            add(topo.connectorId, topo.connectorProps.crtc_id, topo.crtcId);
            // Writing GOOD on a modeset tells the kernel to retrain the link
            // if it had flagged it BAD (add() no-ops when the connector has
            // no link-status property).
            add(topo.connectorId, topo.connectorProps.link_status,
                DRM_MODE_LINK_STATUS_GOOD);
            // Takeover: a previous DRM master (another compositor on another
            // VT) may have left cursor/overlay planes latched on this CRTC
            // with its final image -- a hardware cursor frozen at its last
            // position, displayed on top of everything we scan out. Disable
            // every plane on this CRTC that isn't one of ours.
            std::vector<uint32_t> owned;
            owned.reserve(outputs_.size() * 2);
            for (const auto& [id, other] : outputs_) {
                owned.push_back(other->topo.planeId);
                if (other->topo.cursorPlaneId) owned.push_back(other->topo.cursorPlaneId);
            }
            addForeignPlaneDisables(req, drmFd_, topo.crtcId, owned);
            add(topo.crtcId, topo.crtcProps.mode_id, o.modeBlobId);
            add(topo.crtcId, topo.crtcProps.active,  1);
        }
        return req;
    };

    // Atomic TEST first so the kernel rejects without leaving us half-state.
    // TEST_ONLY must NOT include PAGE_FLIP_EVENT (the kernel rejects the
    // combination -- the test isn't a real commit so there's no flip to
    // signal). NONBLOCK is also irrelevant for TEST_ONLY.
    uint32_t testFlags = (flags & ~DRM_MODE_PAGE_FLIP_EVENT & ~DRM_MODE_ATOMIC_NONBLOCK)
                        | DRM_MODE_ATOMIC_TEST_ONLY;
    drmModeAtomicReq* req = buildReq();
    if (!req) return false;
    int testRc = drmModeAtomicCommit(drmFd_, req, testFlags, this);
    if (testRc != 0 && (flags & DRM_MODE_PAGE_FLIP_ASYNC)) {
        // The async refusal must not cascade into cursor demotion below --
        // retry vsynced first; the request itself is unchanged.
        flags     &= ~DRM_MODE_PAGE_FLIP_ASYNC;
        testFlags &= ~DRM_MODE_PAGE_FLIP_ASYNC;
        testRc = drmModeAtomicCommit(drmFd_, req, testFlags, this);
    }
    if (testRc != 0 && o.topo.cursorPlaneId && !o.cursorDemoted
        && o.cursorVisible && o.cursorImageValid) {
        // The cursor plane props may be what the kernel rejects (driver
        // quirk, size/format constraint the caps didn't surface). Demote
        // to software cursor and retry the frame without it -- the frame
        // must not be lost to a cursor problem.
        LOG_WARN(Gpu,
            "[kms] atomic TEST failed with cursor plane ({}); retrying without "
            "hw cursor on output {}", std::strerror(errno), o.outputId);
        demoteCursor(o, /*issueDisableCommit=*/false);
        drmModeAtomicFree(req);
        req = buildReq();  // now emits the cursor plane-off props
        if (!req) return false;
        testRc = drmModeAtomicCommit(drmFd_, req, testFlags, this);
    }
    if (testRc != 0) {
        LOG_ERR(Gpu, "[kms] atomic TEST failed: {} (flags=0x{:x})",
                std::strerror(errno), testFlags);
        drmModeAtomicFree(req);
        return false;
    }
    int rc = drmModeAtomicCommit(drmFd_, req, flags, this);
    if (rc != 0 && (flags & DRM_MODE_PAGE_FLIP_ASYNC)) {
        // TEST passed but the real commit refused the async flip (state
        // moved between the two); land the frame vsynced.
        flags &= ~DRM_MODE_PAGE_FLIP_ASYNC;
        rc = drmModeAtomicCommit(drmFd_, req, flags, this);
    }
    drmModeAtomicFree(req);
    if (rc != 0) {
        LOG_ERR(Gpu, "[kms] atomic commit failed: {} (flags=0x{:x})",
                std::strerror(errno), flags);
        return false;
    }
    if (wantAsync) {
        // One-shot per-output logs so a bare-metal run can tell whether
        // tearing actually engaged for an async-requesting client.
        if ((flags & DRM_MODE_PAGE_FLIP_ASYNC) && !o.tearingEngagedLogged) {
            o.tearingEngagedLogged = true;
            LOG_INFO(Gpu, "[kms] output {}: tearing engaged (async page flip)",
                     o.outputId);
        } else if (!(flags & DRM_MODE_PAGE_FLIP_ASYNC) && !o.tearingFallbackLogged) {
            o.tearingFallbackLogged = true;
            LOG_INFO(Gpu, "[kms] output {}: async flip refused; vsynced instead "
                     "(may engage on later frames)", o.outputId);
        }
    }
    // This commit carried the current desired cursor state.
    o.cursorDirty = false;
    o.cursorCommitRequested = false;

    const bool wasInitial = !o.didInitialCommit;
    o.didInitialCommit = true;
    if (isClient) {
        o.pendingClientFbId  = clientFbId;
        o.pendingClientBufId = clientBufId;
        o.clientFlipPending  = true;
        if (wasInitial) {
            // ALLOW_MODESET commits are synchronous and deliver no flip
            // event; account the latch now (same reasoning as the ring
            // fake-flip below).
            o.clientFlipPending = false;
            o.pendingClientFbId = 0;
            o.pendingClientBufId = 0;
            struct timespec ts{};
            clock_gettime(CLOCK_MONOTONIC, &ts);
            noteLatch(o, clientFbId, clientBufId,
                      static_cast<uint64_t>(ts.tv_sec),
                      static_cast<uint32_t>(ts.tv_nsec), 0);
        }
        return true;
    }
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
        if (flipCompleteListener_) {
            // Synthetic flip: no kernel timestamp / sequence available yet.
            // Sample CLOCK_MONOTONIC now so wp_presentation has something
            // sensible to report; the real next page-flip will overwrite.
            struct timespec ts{};
            clock_gettime(CLOCK_MONOTONIC, &ts);
            flipCompleteListener_(o.outputId, retired,
                                  static_cast<uint64_t>(ts.tv_sec),
                                  static_cast<uint32_t>(ts.tv_nsec), 0);
        }
        struct timespec ts{};
        clock_gettime(CLOCK_MONOTONIC, &ts);
        noteLatch(o, 0, 0, static_cast<uint64_t>(ts.tv_sec),
                  static_cast<uint32_t>(ts.tv_nsec), 0);
    }
    return true;
}

bool KmsOutputBackend::presentScanoutAt(uint32_t outputId, int slotIdx, int inFenceFd) {
    PerOutput* o = find(outputId);
    if (!o) return false;
    return presentOutputImpl(*o, slotIdx, inFenceFd);
}

void KmsOutputBackend::pageFlipTrampoline(int /*fd*/, unsigned int sequence,
                                          unsigned int tv_sec, unsigned int tv_usec,
                                          unsigned int crtc_id, void* userdata) {
    auto* self = static_cast<KmsOutputBackend*>(userdata);
    if (!self) return;
    // Route the flip to the output whose CRTC the kernel reported.
    for (auto& [id, o] : self->outputs_) {
        if (o->topo.crtcId != crtc_id) continue;
        const uint64_t sec = static_cast<uint64_t>(tv_sec);
        const uint32_t nsec = static_cast<uint32_t>(tv_usec) * 1000u;
        const int flipped = o->pendingFlipSlot;
        o->pendingFlipSlot = -1;
        if (flipped < 0) {
            // Not a ring flip. Either a client-scanout present's flip (a
            // client dmabuf latched -- report it for pacing + release and
            // advance the latch bookkeeping) or a cursor-only commit's
            // (which must NOT feed any pacing -- it only unblocks the next
            // commit).
            if (o->clientFlipPending) {
                o->clientFlipPending = false;
                const uint32_t fb = o->pendingClientFbId;
                const uint32_t buf = o->pendingClientBufId;
                o->pendingClientFbId = 0;
                o->pendingClientBufId = 0;
                self->noteLatch(*o, fb, buf, sec, nsec, sequence);
                self->replayStashedPresent(*o);
                self->maybeCursorCommit(*o);
                return;
            }
            if (o->cursorFlipPending) {
                o->cursorFlipPending = false;
                if (o->stashed.valid) {
                    // A present arrived while the cursor flip was in
                    // flight; issue it now (it folds the latest cursor
                    // state).
                    self->replayStashedPresent(*o);
                } else {
                    self->maybeCursorCommit(*o);
                }
            }
            return;
        }
        const int retired = o->ring.onFlipComplete(flipped);
        if (self->flipCompleteListener_) {
            // Kernel-supplied (tv_sec, tv_usec) promoted to nsec + the
            // vsync sequence number; CLOCK_MONOTONIC by default for DRM
            // page-flip events.
            self->flipCompleteListener_(o->outputId, retired, sec, nsec, sequence);
        }
        // A ring frame latched: any client buffer that was on the plane is
        // now retired (the scanout-leave transition).
        self->noteLatch(*o, 0, 0, sec, nsec, sequence);
        self->replayStashedPresent(*o);
        // Cursor motion that arrived while this frame flip was in flight
        // and asked for a commit of its own.
        self->maybeCursorCommit(*o);
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
