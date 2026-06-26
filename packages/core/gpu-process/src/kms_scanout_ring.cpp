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
    for (auto& s : slots_) releaseKmsSlot(s);
    drmFd_ = -1;
    gbm_ = nullptr;
    width_ = 0;
    height_ = 0;
    fourcc_ = 0;
    chosenModifier_ = 0;
}

void KmsScanoutRing::releaseKmsSlot(Slot& s) {
    // Drop the KMS framebuffer first so the kernel no longer references the
    // BO; the shared release then drops Dawn imports + closes the fd + bo.
    if (s.fbId != 0 && drmFd_ >= 0) {
        drmModeRmFB(drmFd_, s.fbId);
        s.fbId = 0;
    }
    releaseSlot(s);
}

namespace {

// Run drmModeAddFB2WithModifiers for a freshly-imported slot. Returns true
// and writes fbId on success; false (and logs) on kernel rejection.
bool addFB2(int drmFd, uint32_t width, uint32_t height, uint32_t fourcc,
            DmabufScanoutSlot& s, uint32_t& fbIdOut) {
    uint32_t handles[4] = { gbm_bo_get_handle(s.bo).u32, 0, 0, 0 };
    uint32_t pitches[4] = { s.stride, 0, 0, 0 };
    uint32_t offsets[4] = { s.offset, 0, 0, 0 };
    uint64_t fbModifiers[4] = { s.modifier, 0, 0, 0 };
    const uint32_t flags = (s.modifier && s.modifier != DRM_FORMAT_MOD_LINEAR)
                            ? DRM_MODE_FB_MODIFIERS : 0;
    if (drmModeAddFB2WithModifiers(drmFd, width, height, fourcc,
                                   handles, pitches, offsets, fbModifiers,
                                   &fbIdOut, flags) != 0) {
        std::fprintf(stderr, "[kms] drmModeAddFB2WithModifiers failed: %s\n",
                     std::strerror(errno));
        return false;
    }
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

    // Build the candidate modifier list: every modifier the plane advertises
    // for this fourcc, with LINEAR appended last as a guaranteed-single-plane
    // fallback. The full list is passed to GBM in one call; GBM picks the
    // best intersection of allocatable + renderable. Multi-plane modifiers
    // that our single-plane import path can't use are dropped via the retry
    // loop below.
    std::vector<uint64_t> candidates;
    for (const auto& pm : planeModifiers) {
        if (pm.fourcc != fourcc) continue;
        if (pm.modifier == DRM_FORMAT_MOD_LINEAR) continue;  // LINEAR added last
        candidates.push_back(pm.modifier);
    }
    candidates.push_back(DRM_FORMAT_MOD_LINEAR);

    // Allocate slot 0 with the full candidate list. On RejectedModifier
    // (multi-plane / unimportable) drop and retry. On AddFB2 failure also
    // drop and retry -- some modifiers GBM picks are renderable but not
    // accepted for KMS AddFB2; reject them too.
    for (;;) {
        uint64_t rejected = 0;
        AllocSlotResult r = allocateSlot(gbm_, device, width_, height_, fourcc_,
                                         candidates, slots_[0], &rejected);
        if (r == AllocSlotResult::Failed) {
            std::fprintf(stderr,
                "[kms] no usable modifier for scanout (%u advertised + LINEAR fallback)\n",
                static_cast<uint32_t>(planeModifiers.size()));
            return false;
        }
        if (r == AllocSlotResult::Ok) {
            if (addFB2(drmFd_, width_, height_, fourcc_, slots_[0], slots_[0].fbId)) {
                break;
            }
            rejected = slots_[0].modifier;
            releaseSlot(slots_[0]);
        }
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
        AllocSlotResult r = allocateSlot(gbm_, device, width_, height_, fourcc_,
                                         chosenList, slots_[i], &rejected);
        if (r != AllocSlotResult::Ok ||
            !addFB2(drmFd_, width_, height_, fourcc_, slots_[i], slots_[i].fbId)) {
            std::fprintf(stderr, "[kms] failed to allocate scanout slot %zu\n", i);
            if (r == AllocSlotResult::Ok) releaseSlot(slots_[i]);
            for (size_t j = 0; j <= i; ++j) releaseKmsSlot(slots_[j]);
            return false;
        }
    }
    std::printf("[kms] scanout ring: %zu slots, %ux%u fourcc=0x%08x modifier=0x%lx\n",
                kSlotCount, width_, height_, fourcc_,
                static_cast<unsigned long>(chosenModifier_));
    return true;
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
