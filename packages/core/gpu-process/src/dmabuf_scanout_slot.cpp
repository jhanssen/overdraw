#include "dmabuf_scanout_slot.h"

#include <cerrno>
#include <cstdio>
#include <cstring>

#include <unistd.h>

extern "C" {
#include <gbm.h>
#include <drm_fourcc.h>
}

#include "allocator.h"

namespace overdraw::gpu {

AllocSlotResult allocateSlot(gbm_device* gbm, const wgpu::Device& device,
                             uint32_t width, uint32_t height, uint32_t fourcc,
                             const std::vector<uint64_t>& candidates,
                             DmabufScanoutSlot& s, uint64_t* rejected) {
    // Pass the full candidate set in one call and let GBM pick. The flagless
    // gbm_bo_create_with_modifiers implies GBM_BO_USE_SCANOUT|GBM_BO_USE_RENDERING,
    // so GBM intersects across both: the chosen modifier is allocatable AND
    // renderable. Trying modifiers one at a time would pick the first
    // ALLOCATABLE one, which may not be renderable -- the GPU writes bytes
    // in one tile layout while the display engine reads another, and the
    // result is periodic black/garbage frames whenever the slot is shown.
    s.bo = gbm_bo_create_with_modifiers(gbm, width, height, fourcc,
                                        candidates.data(), candidates.size());
    if (!s.bo) {
        return AllocSlotResult::Failed;
    }
    s.modifier = gbm_bo_get_modifier(s.bo);
    // Reject multi-plane BOs: the import path is single-plane (the STM
    // descriptor takes one plane). A modifier that requires auxiliary
    // planes (e.g. compression metadata) silently breaks the import or
    // the display sink, so retry without it.
    const int planeCount = gbm_bo_get_plane_count(s.bo);
    if (planeCount > 1) {
        if (rejected) *rejected = s.modifier;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return AllocSlotResult::RejectedModifier;
    }
    s.stride   = gbm_bo_get_stride_for_plane(s.bo, 0);
    s.offset   = gbm_bo_get_offset(s.bo, 0);
    s.dmabufFd = gbm_bo_get_fd_for_plane(s.bo, 0);
    if (s.dmabufFd < 0) {
        std::fprintf(stderr, "[gpu] gbm_bo_get_fd_for_plane failed: %s\n",
                     std::strerror(errno));
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        return AllocSlotResult::Failed;
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
        // surfaces here as "plane count (N) does not match provided (1)".
        // Drop and let the caller retry without this modifier.
        if (rejected) *rejected = s.modifier;
        ::close(s.dmabufFd); s.dmabufFd = -1;
        gbm_bo_destroy(s.bo); s.bo = nullptr;
        s.mem = nullptr; s.tex = nullptr;
        return AllocSlotResult::RejectedModifier;
    }

    s.state = ScanoutSlotState::FREE;
    return AllocSlotResult::Ok;
}

void releaseSlot(DmabufScanoutSlot& s) {
    // Order matters: drop Dawn references first (so the dmabuf isn't still
    // imported when the fd closes), then close the fd, then destroy the bo.
    s.tex = nullptr;
    s.mem = nullptr;
    if (s.dmabufFd >= 0) {
        ::close(s.dmabufFd);
        s.dmabufFd = -1;
    }
    if (s.bo) {
        gbm_bo_destroy(s.bo);
        s.bo = nullptr;
    }
    s.state = ScanoutSlotState::FREE;
}

}  // namespace overdraw::gpu
