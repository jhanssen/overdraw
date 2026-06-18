#include "kms_scanout_ring.h"

#include <algorithm>
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
enum class AllocResult {
    Ok,
    Failed,           // hard error; the modifier list was unusable
    RejectedModifier, // the picked modifier is unusable; *rejected set, retry without it
};

AllocResult tryAllocateSlot(int drmFd, gbm_device* gbm, const wgpu::Device& device,
                            uint32_t width, uint32_t height, uint32_t fourcc,
                            const std::vector<uint64_t>& modifiers,
                            KmsScanoutRing::Slot& s, uint64_t* rejected) {
    // Pass the full candidate set in one call and let GBM pick. The flagless
    // gbm_bo_create_with_modifiers implies GBM_BO_USE_SCANOUT|GBM_BO_USE_RENDERING,
    // so GBM intersects across both: the chosen modifier is allocatable AND
    // scanoutable AND renderable. Trying modifiers one at a time picks the
    // first ALLOCATABLE one, which may not be renderable -- the GPU writes
    // bytes in one tile layout while the display engine reads another, and
    // the result is periodic black/garbage frames whenever two CRTCs are
    // active (the rendered bytes never reach the panel correctly).
    s.bo = gbm_bo_create_with_modifiers(gbm, width, height, fourcc,
                                        modifiers.data(), modifiers.size());
    if (!s.bo) {
        return AllocResult::Failed;
    }
    s.modifier = gbm_bo_get_modifier(s.bo);
    // Reject multi-plane BOs: the import path below uses a single-plane
    // SharedTextureMemory, and AddFB2 below assembles a single-plane FB.
    // A modifier that requires auxiliary planes (e.g. CCS compression
    // metadata) silently breaks scanout because the aux plane is missing,
    // so retry without this modifier on the caller side.
    const int planeCount = gbm_bo_get_plane_count(s.bo);
    if (planeCount > 1) {
        if (rejected) *rejected = s.modifier;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return AllocResult::RejectedModifier;
    }
    s.stride   = gbm_bo_get_stride_for_plane(s.bo, 0);
    s.offset   = gbm_bo_get_offset(s.bo, 0);
    s.dmabufFd = gbm_bo_get_fd_for_plane(s.bo, 0);
    if (s.dmabufFd < 0) {
        std::fprintf(stderr, "[kms] gbm_bo_get_fd_for_plane failed: %s\n",
                     std::strerror(errno));
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return AllocResult::Failed;
    }

    DmabufBuffer buf{};
    buf.fd       = s.dmabufFd;
    buf.modifier = s.modifier;
    buf.stride   = s.stride;
    buf.offset   = s.offset;
    buf.width    = width;
    buf.height   = height;
    if (!Allocator::importTexture(device, fourcc, buf, s.mem, s.tex)) {
        // The import path is single-plane; a modifier that needs aux planes
        // surfaces here as "plane count (N) does not match provided (1)". Hand
        // back so the caller retries without this modifier.
        if (rejected) *rejected = s.modifier;
        ::close(s.dmabufFd); s.dmabufFd = -1;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        s.mem = nullptr; s.tex = nullptr;
        return AllocResult::RejectedModifier;
    }

    // AddFB2WithModifiers needs per-plane handles. Single-plane format here.
    uint32_t handles[4] = { gbm_bo_get_handle(s.bo).u32, 0, 0, 0 };
    uint32_t pitches[4] = { s.stride, 0, 0, 0 };
    uint32_t offsets[4] = { s.offset, 0, 0, 0 };
    uint64_t fbModifiers[4] = { s.modifier, 0, 0, 0 };
    const uint32_t flags = (s.modifier && s.modifier != DRM_FORMAT_MOD_LINEAR)
                            ? DRM_MODE_FB_MODIFIERS : 0;
    if (drmModeAddFB2WithModifiers(drmFd, width, height, fourcc,
                                   handles, pitches, offsets, fbModifiers,
                                   &s.fbId, flags) != 0) {
        std::fprintf(stderr, "[kms] drmModeAddFB2WithModifiers failed: %s\n",
                     std::strerror(errno));
        s.tex = nullptr; s.mem = nullptr;
        ::close(s.dmabufFd); s.dmabufFd = -1;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return AllocResult::Failed;
    }
    s.state = KmsScanoutRing::SlotState::FREE;
    return AllocResult::Ok;
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

    // Build the candidate modifier list: every modifier the plane advertises
    // for this fourcc, with LINEAR appended last as a guaranteed-single-plane
    // fallback. The full list is passed to GBM in one call (see
    // tryAllocateSlot); GBM picks the best intersection of allocatable +
    // scanoutable + renderable. Multi-plane modifiers (CCS, etc.) that our
    // single-plane import path can't use are dropped via the retry loop
    // below.
    std::vector<uint64_t> candidates;
    for (const auto& pm : planeModifiers) {
        if (pm.fourcc != fourcc) continue;
        if (pm.modifier == DRM_FORMAT_MOD_LINEAR) continue;  // LINEAR added last
        candidates.push_back(pm.modifier);
    }
    candidates.push_back(DRM_FORMAT_MOD_LINEAR);

    // Allocate slot 0 with the full candidate list; GBM picks the best
    // modifier that is BOTH allocatable AND scanoutable AND renderable. If
    // GBM picks one that requires multi-plane import (single-plane path
    // can't use it), drop it and retry with the remaining candidates.
    for (;;) {
        uint64_t rejected = 0;
        AllocResult r = tryAllocateSlot(drmFd_, gbm_, device, width_, height_, fourcc_,
                                        candidates, slots_[0], &rejected);
        if (r == AllocResult::Ok) break;
        if (r == AllocResult::Failed) {
            std::fprintf(stderr, "[kms] no usable modifier for scanout (%u advertised + LINEAR fallback)\n",
                         static_cast<uint32_t>(planeModifiers.size()));
            return false;
        }
        // RejectedModifier: remove from candidates and retry.
        candidates.erase(std::remove(candidates.begin(), candidates.end(), rejected),
                         candidates.end());
        if (candidates.empty()) {
            std::fprintf(stderr, "[kms] no single-plane scanout modifier (last rejected 0x%lx)\n",
                         static_cast<unsigned long>(rejected));
            return false;
        }
    }
    chosenModifier_ = slots_[0].modifier;
    // Remaining slots use the SAME modifier (the kernel requires every
    // plane->fb of a single CRTC to be consistent during steady state).
    std::vector<uint64_t> chosenList = { chosenModifier_ };
    for (size_t i = 1; i < kSlotCount; ++i) {
        uint64_t rejected = 0;
        if (tryAllocateSlot(drmFd_, gbm_, device, width_, height_, fourcc_,
                            chosenList, slots_[i], &rejected) != AllocResult::Ok) {
            std::fprintf(stderr, "[kms] failed to allocate scanout slot %zu\n", i);
            // Tear down what we built so the dtor doesn't see half-state.
            for (size_t j = 0; j <= i; ++j) releaseSlot(slots_[j]);
            return false;
        }
    }
    std::printf("[kms] scanout ring: %zu slots, %ux%u fourcc=0x%08x modifier=0x%lx\n",
                kSlotCount, width_, height_, fourcc_,
                static_cast<unsigned long>(chosenModifier_));
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
