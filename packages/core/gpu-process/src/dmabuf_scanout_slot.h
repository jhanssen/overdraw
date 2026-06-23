// Backend-neutral GBM-allocated dmabuf scanout slot.
//
// A scanout RING is N slots (typically 3) the JS compositor renders into
// in rotation: at most one PENDING_FLIP (queued for display), one SCANOUT
// (currently displayed), the rest FREE. Each slot owns:
//
//   - a GBM bo allocated in single-plane mode with a modifier the chosen
//     display sink can consume,
//   - the exported dmabuf fd (kept open for the slot's lifetime so the
//     display sink can re-import it without re-exporting),
//   - the imported wgpu::SharedTextureMemory + wgpu::Texture for the GPU
//     compositor to render into.
//
// What the backend ADDS per slot (an `fbId` for KMS, a `wl_buffer*` for the
// nested host-window backend) lives in a per-backend slot struct that
// embeds DmabufScanoutSlot by composition; the ring state machine itself
// runs on the embedded base. The helpers in this header are the
// backend-agnostic operations: allocate + import + close + destroy.

#ifndef OVERDRAW_GPU_DMABUF_SCANOUT_SLOT_H_
#define OVERDRAW_GPU_DMABUF_SCANOUT_SLOT_H_

#include <cstdint>
#include <vector>

#include "dawn/webgpu_cpp.h"

struct gbm_bo;
struct gbm_device;

namespace overdraw::gpu {

enum class ScanoutSlotState : uint8_t { FREE, PENDING_FLIP, SCANOUT };

struct DmabufScanoutSlot {
    gbm_bo*   bo       = nullptr;
    int       dmabufFd = -1;   // owning fd; closed by release()
    uint64_t  modifier = 0;
    uint32_t  stride   = 0;
    uint32_t  offset   = 0;
    wgpu::SharedTextureMemory mem;
    wgpu::Texture             tex;
    ScanoutSlotState          state = ScanoutSlotState::FREE;
};

// One candidate (fourcc, modifier) pair the display sink can consume. Mirrors
// the shape of both the KMS plane IN_FORMATS list and the host's linux-dmabuf
// modifier advertisements so the ring init code does not depend on either.
struct DmabufModifierCandidate {
    uint32_t fourcc;
    uint64_t modifier;
};

enum class AllocSlotResult {
    Ok,
    Failed,           // hard error; no modifier in the list was usable
    RejectedModifier, // multi-plane / unimportable; *rejected set, retry without it
};

// Allocate + import one slot using `candidates` as the modifier set; GBM
// picks the best intersection of allocatable + renderable + usable across
// all candidates. Multi-plane modifiers (compression / aux planes) are
// dropped automatically -- the single-plane import path can't use them; the
// caller is expected to drop the modifier reported in *rejected and retry.
// Backend-specific acceptance checks (e.g. AddFB2 for KMS, host
// linux-dmabuf advertisement for the host-window backend) run separately
// after this returns Ok.
AllocSlotResult allocateSlot(gbm_device* gbm, const wgpu::Device& device,
                             uint32_t width, uint32_t height, uint32_t fourcc,
                             const std::vector<uint64_t>& candidates,
                             DmabufScanoutSlot& out, uint64_t* rejected);

// Tear down the shared resources of a slot. Backend-specific resources
// (KMS fbId, wl_buffer*) must be released by the backend BEFORE calling
// this -- the order matters because Dawn imports must drop before the fd
// closes, and the backend resource (which may reference the bo or fbId)
// must drop before the dmabuf fd closes.
void releaseSlot(DmabufScanoutSlot& s);

// FREE/PENDING_FLIP/SCANOUT state machine for an N-slot ring. The ring
// always uses kSlotCount = 3 today.
constexpr size_t kScanoutSlotCount = 3;

// Pick the next FREE slot (or -1 if none free). Pure query.
int acquireFreeSlot(const DmabufScanoutSlot* slots);

// Atomic transitions. Returns the index of the slot that just exited
// SCANOUT (and is now FREE), or -1 if no prior SCANOUT existed.
void markPendingFlipSlot(DmabufScanoutSlot* slots, int idx);
int  onFlipCompleteSlot(DmabufScanoutSlot* slots, int flippedIdx);

// Forced reset of every slot to FREE. Used by KMS on VT-switch (DRM master
// revoked; in-flight flip events will never arrive) and is also the right
// thing to do after a host-window reconfigure that rebuilds the ring.
void resetSlotsToFree(DmabufScanoutSlot* slots);

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_DMABUF_SCANOUT_SLOT_H_
