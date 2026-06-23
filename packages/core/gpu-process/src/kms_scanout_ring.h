// 3-slot KMS scanout ring.
//
// Each slot owns: a dmabuf-backed scanout buffer (see DmabufScanoutSlot) plus
// the KMS framebuffer id (fb_id) created via drmModeAddFB2WithModifiers. A
// slot is in one of three states:
//
//   FREE          - the JS compositor may acquire it. The texture is not
//                   currently being read by the display engine and is not
//                   queued for flip.
//   PENDING_FLIP  - the slot has been atomic-committed with PAGE_FLIP_EVENT;
//                   the kernel is going to flip to it at the next vblank.
//                   The TEXTURE is being read by the display engine. Will
//                   transition to SCANOUT on flip-complete.
//   SCANOUT       - the slot is the one currently being scanned out. Stays
//                   here until ANOTHER slot's flip completes, at which point
//                   this slot transitions to FREE.
//
// Invariants:
//   - At most ONE slot is in PENDING_FLIP at any time (one frame in flight).
//   - At most ONE slot is in SCANOUT at any time (only one can be displayed).
//   - On flip-complete: the slot that was PENDING_FLIP becomes SCANOUT, the
//     prior SCANOUT slot becomes FREE.
//
// The ring is constructed in `init()` (allocates + imports + AddFB2 for each
// slot) and torn down in the destructor. acquire() returns the next FREE
// slot (or nullptr if none); markPendingFlip() transitions FREE -> PENDING_
// FLIP; onFlipComplete() does the PENDING_FLIP -> SCANOUT, prior SCANOUT
// -> FREE transition.

#ifndef OVERDRAW_GPU_KMS_SCANOUT_RING_H_
#define OVERDRAW_GPU_KMS_SCANOUT_RING_H_

#include <array>
#include <cstdint>
#include <vector>

#include "dawn/webgpu_cpp.h"

#include "dmabuf_scanout_slot.h"

struct gbm_bo;
struct gbm_device;

namespace overdraw::gpu {

struct PlaneFormatModifier;  // drm_utils.h

class KmsScanoutRing {
  public:
    static constexpr size_t kSlotCount = kScanoutSlotCount;

    using SlotState = ScanoutSlotState;

    // KMS slot = the shared dmabuf scanout slot plus the KMS framebuffer id.
    struct Slot : public DmabufScanoutSlot {
        uint32_t fbId = 0;  // KMS framebuffer id (drmModeAddFB2WithModifiers)
    };

    KmsScanoutRing() = default;
    ~KmsScanoutRing();

    KmsScanoutRing(const KmsScanoutRing&) = delete;
    KmsScanoutRing& operator=(const KmsScanoutRing&) = delete;

    // Tear down every slot's resources and reset to the default-constructed
    // state. Idempotent. Called by the dtor and by KmsOutputBackend::close()
    // (which may run before the backend itself is destroyed, e.g. on a
    // graceful shutdown path).
    void clear();

    // Allocate, import, and AddFB2 every slot. `drmFd` owns the card; `gbm`
    // is its GBM device. `width`/`height`/`fourcc` describe the scanout
    // surface. `planeModifiers` is the IN_FORMATS list intersected with what
    // we'd like to use; the ring picks a modifier from it that GBM will
    // allocate + Dawn will import + KMS will accept for AddFB2 (probing each
    // in order). If the list is empty (older driver without IN_FORMATS),
    // falls back to DRM_FORMAT_MOD_LINEAR. Returns false on failure (and
    // tears down any partially-allocated slots).
    bool init(int drmFd, gbm_device* gbm,
              const wgpu::Device& device,
              uint32_t width, uint32_t height, uint32_t fourcc,
              const std::vector<PlaneFormatModifier>& planeModifiers);

    // Returns the index of the next FREE slot, or -1 if none are free. Pure
    // query; does not change state. The caller calls markPendingFlip(idx)
    // after the atomic commit has been queued for this slot.
    int acquireFree() const;

    // Atomic state transitions. `onFlipComplete` returns the (now-FREE) slot
    // index that just exited SCANOUT, or -1 if no prior SCANOUT existed
    // (first flip).
    void markPendingFlip(int idx);
    int  onFlipComplete(int flippedIdx);

    // VT-switch resume helper: force every slot back to FREE. The kernel
    // revoked DRM master across the switch so any in-flight flip will never
    // arrive; without this, slots stuck in PENDING_FLIP / SCANOUT can never
    // be acquired again. Called by KmsOutputBackend::pause(). Idempotent.
    void resetAllSlotsToFree();

    SlotState state(int idx) const { return slots_[idx].state; }
    const Slot& slot(int idx) const { return slots_[idx]; }
    uint32_t width()  const { return width_; }
    uint32_t height() const { return height_; }
    uint32_t fourcc() const { return fourcc_; }
    uint64_t chosenModifier() const { return chosenModifier_; }

  private:
    int drmFd_ = -1;
    gbm_device* gbm_ = nullptr;
    uint32_t width_ = 0, height_ = 0, fourcc_ = 0;
    uint64_t chosenModifier_ = 0;
    std::array<Slot, kSlotCount> slots_{};

    void releaseKmsSlot(Slot& s);
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_KMS_SCANOUT_RING_H_
