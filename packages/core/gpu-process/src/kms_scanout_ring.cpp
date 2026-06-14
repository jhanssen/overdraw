#include "kms_scanout_ring.h"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <vector>

#include <unistd.h>

extern "C" {
#include <gbm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm_fourcc.h>
}

#include "allocator.h"
#include "drm_utils.h"

namespace overdraw::gpu {

KmsScanoutRing::~KmsScanoutRing() {
    clear();
}

void KmsScanoutRing::clear() {
    for (auto& s : slots_) releaseSlot(s);
    drmFd_ = -1;
    gbm_ = nullptr;
    width_ = 0;
    height_ = 0;
    fourcc_ = 0;
    chosenModifier_ = 0;
}

void KmsScanoutRing::releaseSlot(Slot& s) {
    // Order matters: drop the Dawn references first (so the dmabuf isn't
    // still imported when we close it / remove the FB).
    s.tex = nullptr;
    s.mem = nullptr;
    if (s.fbId != 0 && drmFd_ >= 0) {
        drmModeRmFB(drmFd_, s.fbId);
        s.fbId = 0;
    }
    if (s.dmabufFd >= 0) {
        ::close(s.dmabufFd);
        s.dmabufFd = -1;
    }
    if (s.bo) {
        gbm_bo_destroy(s.bo);
        s.bo = nullptr;
    }
    s.state = SlotState::FREE;
}

namespace {

// Try to allocate + import + AddFB2 with one modifier. On success leaves the
// Slot fully populated and returns true; on any sub-step failure releases
// what's been done and returns false.
bool tryAllocateSlot(int drmFd, gbm_device* gbm, const wgpu::Device& device,
                     uint32_t width, uint32_t height, uint32_t fourcc,
                     uint64_t modifier, KmsScanoutRing::Slot& s) {
    uint64_t modList[1] = { modifier };
    s.bo = gbm_bo_create_with_modifiers(gbm, width, height, fourcc, modList, 1);
    if (!s.bo) {
        // Not a hard error -- modifier may not be allocatable by GBM. Caller
        // tries the next modifier.
        return false;
    }
    s.modifier = modifier;
    s.stride   = gbm_bo_get_stride_for_plane(s.bo, 0);
    s.offset   = gbm_bo_get_offset(s.bo, 0);
    s.dmabufFd = gbm_bo_get_fd_for_plane(s.bo, 0);
    if (s.dmabufFd < 0) {
        std::fprintf(stderr, "[kms] gbm_bo_get_fd_for_plane failed: %s\n",
                     std::strerror(errno));
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return false;
    }

    DmabufBuffer buf{};
    buf.fd       = s.dmabufFd;
    buf.modifier = s.modifier;
    buf.stride   = s.stride;
    buf.offset   = s.offset;
    buf.width    = width;
    buf.height   = height;
    if (!Allocator::importTexture(device, fourcc, buf, s.mem, s.tex)) {
        std::fprintf(stderr, "[kms] importTexture rejected modifier 0x%lx\n",
                     static_cast<unsigned long>(modifier));
        ::close(s.dmabufFd); s.dmabufFd = -1;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        s.mem = nullptr; s.tex = nullptr;
        return false;
    }

    // AddFB2WithModifiers needs per-plane handles. Single-plane format here.
    uint32_t handles[4] = { gbm_bo_get_handle(s.bo).u32, 0, 0, 0 };
    uint32_t pitches[4] = { s.stride, 0, 0, 0 };
    uint32_t offsets[4] = { s.offset, 0, 0, 0 };
    uint64_t modifiers[4] = { s.modifier, 0, 0, 0 };
    const uint32_t flags = (s.modifier && s.modifier != DRM_FORMAT_MOD_LINEAR)
                            ? DRM_MODE_FB_MODIFIERS : 0;
    if (drmModeAddFB2WithModifiers(drmFd, width, height, fourcc,
                                   handles, pitches, offsets, modifiers,
                                   &s.fbId, flags) != 0) {
        std::fprintf(stderr, "[kms] drmModeAddFB2WithModifiers failed: %s\n",
                     std::strerror(errno));
        s.tex = nullptr; s.mem = nullptr;
        ::close(s.dmabufFd); s.dmabufFd = -1;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return false;
    }
    s.state = KmsScanoutRing::SlotState::FREE;
    return true;
}

}  // namespace

bool KmsScanoutRing::init(int drmFd, gbm_device* gbm,
                          const wgpu::Device& device,
                          uint32_t width, uint32_t height, uint32_t fourcc,
                          const std::vector<PlaneFormatModifier>& planeModifiers) {
    drmFd_  = drmFd;
    gbm_    = gbm;
    width_  = width;
    height_ = height;
    fourcc_ = fourcc;

    // Build the candidate modifier list. ORDER: tiled modifiers (advertised
    // by the plane's IN_FORMATS) first, since LINEAR scanout targets on
    // integrated GPUs render multiple ms slower (no GPU tile compression).
    // LINEAR is appended last as a guaranteed-single-plane fallback.
    //
    // tryAllocateSlot below uses GBM + Dawn ImportSharedTextureMemory; if
    // a modifier requires auxiliary planes (CCS / compression metadata)
    // not in our single-plane import path, Dawn rejects with "plane count
    // (N) does not match provided (1)" and we move to the next candidate.
    std::vector<uint64_t> candidates;
    for (const auto& pm : planeModifiers) {
        if (pm.fourcc != fourcc) continue;
        if (pm.modifier == DRM_FORMAT_MOD_LINEAR) continue;  // LINEAR added last
        candidates.push_back(pm.modifier);
    }
    candidates.push_back(DRM_FORMAT_MOD_LINEAR);

    // Try modifiers in order until one succeeds for slot 0. The remaining
    // slots use the SAME modifier (the kernel requires every plane->fb of a
    // single CRTC to be consistent during steady state).
    uint64_t chosen = 0;
    bool gotFirst = false;
    for (uint64_t m : candidates) {
        if (tryAllocateSlot(drmFd_, gbm_, device, width_, height_, fourcc_, m, slots_[0])) {
            chosen = m;
            gotFirst = true;
            break;
        }
    }
    if (!gotFirst) {
        std::fprintf(stderr, "[kms] no usable modifier for scanout (%u advertised + LINEAR fallback)\n",
                     static_cast<uint32_t>(planeModifiers.size()));
        return false;
    }
    chosenModifier_ = chosen;

    for (size_t i = 1; i < kSlotCount; ++i) {
        if (!tryAllocateSlot(drmFd_, gbm_, device, width_, height_, fourcc_, chosen, slots_[i])) {
            std::fprintf(stderr, "[kms] failed to allocate scanout slot %zu\n", i);
            // Tear down what we built so the dtor doesn't see half-state.
            for (size_t j = 0; j <= i; ++j) releaseSlot(slots_[j]);
            return false;
        }
    }
    std::printf("[kms] scanout ring: %zu slots, %ux%u fourcc=0x%08x modifier=0x%lx\n",
                kSlotCount, width_, height_, fourcc_,
                static_cast<unsigned long>(chosen));
    return true;
}

int KmsScanoutRing::acquireFree() const {
    for (size_t i = 0; i < kSlotCount; ++i) {
        if (slots_[i].state == SlotState::FREE) return static_cast<int>(i);
    }
    return -1;
}

void KmsScanoutRing::markPendingFlip(int idx) {
    if (idx < 0 || static_cast<size_t>(idx) >= kSlotCount) return;
    slots_[idx].state = SlotState::PENDING_FLIP;
}

int KmsScanoutRing::onFlipComplete(int flippedIdx) {
    if (flippedIdx < 0 || static_cast<size_t>(flippedIdx) >= kSlotCount) return -1;
    int retiredIdx = -1;
    for (size_t i = 0; i < kSlotCount; ++i) {
        if (static_cast<int>(i) == flippedIdx) continue;
        if (slots_[i].state == SlotState::SCANOUT) {
            slots_[i].state = SlotState::FREE;
            retiredIdx = static_cast<int>(i);
            break;
        }
    }
    slots_[flippedIdx].state = SlotState::SCANOUT;
    return retiredIdx;
}

void KmsScanoutRing::resetAllSlotsToFree() {
    for (auto& s : slots_) s.state = SlotState::FREE;
}

}  // namespace overdraw::gpu
