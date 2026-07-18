#include "wayland_scanout_ring.h"

#include <algorithm>

#include <wayland-client.h>

extern "C" {
#include <drm_fourcc.h>
}

#include "host_window.h"
#include "log/log.h"

namespace overdraw::gpu {

WaylandScanoutRing::~WaylandScanoutRing() {
    clear();
}

void WaylandScanoutRing::clear() {
    for (auto& s : slots_) releaseHostSlot(s);
    gbm_ = nullptr;
    width_ = 0;
    height_ = 0;
    fourcc_ = 0;
    chosenModifier_ = 0;
}

void WaylandScanoutRing::releaseHostSlot(Slot& s) {
    // Destroy the host wl_buffer first so the host knows we are abandoning
    // it; then the shared release path drops the Dawn imports + closes the
    // fd + bo. (A wl_buffer that outlives its dmabuf would still be valid
    // on the host side until destroyed, but it could no longer be sampled.)
    if (s.hostBuffer) {
        wl_buffer_destroy(s.hostBuffer);
        s.hostBuffer = nullptr;
    }
    releaseSlot(s);
}

bool WaylandScanoutRing::init(gbm_device* gbm, const wgpu::Device& device,
                              HostWindow& window,
                              uint32_t width, uint32_t height, uint32_t fourcc,
                              const std::vector<uint64_t>& hostModifiers) {
    gbm_    = gbm;
    width_  = width;
    height_ = height;
    fourcc_ = fourcc;

    // Candidate list: every host-advertised modifier for `fourcc`, with
    // LINEAR appended last as a guaranteed-single-plane fallback (the host
    // may not have advertised LINEAR but LINEAR is always single-plane and
    // any host that supports dmabuf import at all is overwhelmingly likely
    // to accept it; if not, the wl_buffer create reports a protocol error
    // on the next dispatch).
    std::vector<uint64_t> candidates;
    for (uint64_t mod : hostModifiers) {
        if (mod == DRM_FORMAT_MOD_LINEAR) continue;  // LINEAR added last
        candidates.push_back(mod);
    }
    candidates.push_back(DRM_FORMAT_MOD_LINEAR);

    // Allocate slot 0 with the full candidate list. On RejectedModifier
    // (multi-plane / unimportable) drop and retry. The wl_buffer wrap
    // itself does not signal modifier rejection synchronously; if the host
    // rejects the params, that surfaces as a wl_buffer.destroy event the
    // wl_buffer.release listener also catches -- but if it happens here at
    // ring init, we have no recourse for that specific modifier without
    // round-tripping per slot, which would be slow. Settle for: GBM-picked
    // + Dawn-imported modifier, then trust the host advertised it.
    for (;;) {
        uint64_t rejected = 0;
        AllocSlotResult r = allocateSlot(gbm_, device, width_, height_, fourcc_,
                                         candidates, slots_[0], &rejected);
        if (r == AllocSlotResult::Failed) {
            LOG_ERR(Gpu,
                "wayland scanout: no usable modifier ({} host-advertised + LINEAR fallback)",
                hostModifiers.size());
            return false;
        }
        if (r == AllocSlotResult::Ok) {
            slots_[0].hostBuffer = window.createWlBufferFromDmabuf(
                slots_[0].dmabufFd, width_, height_, fourcc_, slots_[0].modifier,
                slots_[0].offset, slots_[0].stride);
            if (slots_[0].hostBuffer) break;
            LOG_WARN(Gpu,
                "wayland scanout: host wl_buffer wrap failed for modifier 0x{:x}",
                slots_[0].modifier);
            rejected = slots_[0].modifier;
            releaseSlot(slots_[0]);
        }
        candidates.erase(std::remove(candidates.begin(), candidates.end(), rejected),
                         candidates.end());
        if (candidates.empty()) {
            LOG_ERR(Gpu, "wayland scanout: no single-plane host-acceptable modifier");
            return false;
        }
    }
    chosenModifier_ = slots_[0].modifier;

    // Remaining slots use the SAME modifier. The host may not require this
    // (each wl_buffer is independent), but mirroring KMS keeps allocation
    // deterministic and avoids per-slot modifier-selection drift.
    std::vector<uint64_t> chosenList = { chosenModifier_ };
    for (size_t i = 1; i < kSlotCount; ++i) {
        uint64_t rejected = 0;
        AllocSlotResult r = allocateSlot(gbm_, device, width_, height_, fourcc_,
                                         chosenList, slots_[i], &rejected);
        if (r != AllocSlotResult::Ok) {
            LOG_ERR(Gpu, "wayland scanout: failed to allocate slot {}", i);
            for (size_t j = 0; j <= i; ++j) releaseHostSlot(slots_[j]);
            return false;
        }
        slots_[i].hostBuffer = window.createWlBufferFromDmabuf(
            slots_[i].dmabufFd, width_, height_, fourcc_, slots_[i].modifier,
            slots_[i].offset, slots_[i].stride);
        if (!slots_[i].hostBuffer) {
            LOG_ERR(Gpu, "wayland scanout: host wl_buffer wrap failed for slot {}", i);
            for (size_t j = 0; j <= i; ++j) releaseHostSlot(slots_[j]);
            return false;
        }
    }
    LOG_INFO(Gpu, "wayland scanout: {} slots, {}x{} fourcc=0x{:08x} modifier=0x{:x}",
             kSlotCount, width_, height_, fourcc_, chosenModifier_);
    return true;
}

void WaylandScanoutRing::markPendingFlip(int idx) {
    if (idx < 0 || static_cast<size_t>(idx) >= kSlotCount) return;
    slots_[idx].state = SlotState::PENDING_FLIP;
}

void WaylandScanoutRing::markFree(int idx) {
    if (idx < 0 || static_cast<size_t>(idx) >= kSlotCount) return;
    slots_[idx].state = SlotState::FREE;
}

void WaylandScanoutRing::resetAllSlotsToFree() {
    for (auto& s : slots_) s.state = SlotState::FREE;
}

int WaylandScanoutRing::slotIndexForHostBuffer(wl_buffer* b) const {
    if (!b) return -1;
    for (size_t i = 0; i < kSlotCount; ++i) {
        if (slots_[i].hostBuffer == b) return static_cast<int>(i);
    }
    return -1;
}

}  // namespace overdraw::gpu
