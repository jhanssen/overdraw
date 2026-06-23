// 3-slot host-Wayland scanout ring (nested mode).
//
// Each slot owns: a dmabuf-backed scanout buffer (see DmabufScanoutSlot) plus
// a host wl_buffer wrapping that dmabuf via the host's zwp_linux_dmabuf_v1.
// The state machine is the same FREE/PENDING_FLIP/SCANOUT triple KMS uses;
// the only differences from KmsScanoutRing are:
//
//   - the per-slot "display sink token" is a wl_buffer*, not an fbId;
//   - the "slot free" event is the host's wl_buffer.release, not a
//     DRM page-flip event;
//   - the SCANOUT slot is the one whose wl_buffer is currently latched on
//     the host wl_surface, which only the host knows; we discover it via
//     the next slot's wl_buffer.release.
//
// Allocation strategy mirrors KmsScanoutRing: probe the host-advertised
// (fourcc, modifier) list intersected with our GPU's importable set,
// allocate the first slot to pick a modifier the host accepts, then bind
// the remaining slots to the same modifier.

#ifndef OVERDRAW_GPU_WAYLAND_SCANOUT_RING_H_
#define OVERDRAW_GPU_WAYLAND_SCANOUT_RING_H_

#include <array>
#include <cstdint>
#include <functional>
#include <vector>

#include "dawn/webgpu_cpp.h"

#include "dmabuf_scanout_slot.h"

struct gbm_device;
struct wl_buffer;

namespace overdraw::gpu {

class HostWindow;

class WaylandScanoutRing {
  public:
    static constexpr size_t kSlotCount = kScanoutSlotCount;

    using SlotState = ScanoutSlotState;

    // Host-Wayland slot = the shared dmabuf scanout slot plus the host
    // wl_buffer proxy that wraps it.
    struct Slot : public DmabufScanoutSlot {
        wl_buffer* hostBuffer = nullptr;  // owned; destroyed by clear()
    };

    WaylandScanoutRing() = default;
    ~WaylandScanoutRing();

    WaylandScanoutRing(const WaylandScanoutRing&) = delete;
    WaylandScanoutRing& operator=(const WaylandScanoutRing&) = delete;

    // Tear down every slot's resources and reset to the default-constructed
    // state. Idempotent. Called by the dtor and on output resize (the ring
    // is rebuilt at the new dimensions).
    void clear();

    // Allocate, import, and wl_buffer-wrap every slot. `gbm` is the GBM
    // device the GPU process opened on its render node (borrowed; not
    // closed here). `window` owns the host wl_display connection used for
    // wrapping each dmabuf as a host wl_buffer.
    //
    // The (fourcc, modifier) candidate set is the intersection of:
    //   - host-advertised modifiers via the host's zwp_linux_dmabuf_v1
    //     (passed in as `hostFormats`),
    //   - the modifiers our GPU can both allocate AND import.
    //
    // Returns false on failure (and tears down any partially-allocated
    // slots).
    bool init(gbm_device* gbm, const wgpu::Device& device, HostWindow& window,
              uint32_t width, uint32_t height, uint32_t fourcc,
              const std::vector<uint64_t>& hostModifiers);

    // The next FREE slot, or -1 if none free. Pure query.
    int acquireFree() const;

    // FREE -> PENDING_FLIP (we have attached the slot's wl_buffer and
    // committed the host surface; the slot is unavailable until the host
    // releases its wl_buffer).
    void markPendingFlip(int idx);

    // PENDING_FLIP / SCANOUT -> FREE. Driven by the host's wl_buffer.release
    // event: the slot just retired is exactly the one identified by the
    // wl_buffer the host released. Idempotent.
    void markFree(int idx);

    // Force every slot back to FREE. Used on resize before a clear() +
    // re-init (the prior ring's buffers are about to be destroyed).
    void resetAllSlotsToFree();

    SlotState state(int idx) const { return slots_[idx].state; }
    const Slot& slot(int idx) const { return slots_[idx]; }
    Slot& slot(int idx) { return slots_[idx]; }
    uint32_t width()  const { return width_; }
    uint32_t height() const { return height_; }
    uint32_t fourcc() const { return fourcc_; }
    uint64_t chosenModifier() const { return chosenModifier_; }

    // Map a host wl_buffer back to its slot index. Used by the
    // wl_buffer.release listener trampoline to drive onFlipComplete.
    // Returns -1 if the buffer is not one of ours (e.g. a stale release
    // for a buffer from a prior ring that was torn down during a resize).
    int slotIndexForHostBuffer(wl_buffer* b) const;

  private:
    gbm_device* gbm_ = nullptr;   // borrowed; not closed
    uint32_t width_ = 0, height_ = 0, fourcc_ = 0;
    uint64_t chosenModifier_ = 0;
    std::array<Slot, kSlotCount> slots_{};

    void releaseHostSlot(Slot& s);
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_WAYLAND_SCANOUT_RING_H_
