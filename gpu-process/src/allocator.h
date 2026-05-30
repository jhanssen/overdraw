// GBM dmabuf allocator + Dawn DRM format/modifier probe (GPU process only).
//
// Naive GBM allocation yields modifiers Dawn rejects on import (notably on
// NVIDIA). The importable set must come from Dawn's GetFormatCapabilities +
// DawnDrmFormatCapabilities on a native server-side adapter, intersected with
// what GBM will actually allocate. This lives GPU-process-side because
// DawnDrmFormatCapabilities is not exposed over the wire.

#ifndef OVERDRAW_GPU_ALLOCATOR_H_
#define OVERDRAW_GPU_ALLOCATOR_H_

#include <cstdint>
#include <vector>

#include "dawn/webgpu_cpp.h"

struct gbm_device;
struct gbm_bo;

namespace overdraw::gpu {

// A dmabuf-backed buffer allocated via GBM with a Dawn-importable modifier.
// Single-plane only for the slice (the modifiers we probe are single-plane).
struct DmabufBuffer {
    int fd = -1;            // owning dmabuf fd (caller closes)
    uint64_t modifier = 0;
    uint32_t stride = 0;
    uint32_t offset = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    gbm_bo* bo = nullptr;   // kept alive until release
};

class Allocator {
  public:
    Allocator() = default;
    ~Allocator();

    Allocator(const Allocator&) = delete;
    Allocator& operator=(const Allocator&) = delete;

    // Opens a DRM render node and creates the GBM device.
    bool open();

    // Probes Dawn for the importable modifier list for `format` on `adapter`,
    // intersects with GBM, and stores the usable modifiers. Returns false if
    // no modifier is both Dawn-importable and GBM-allocatable.
    bool probe(const wgpu::Adapter& adapter, wgpu::TextureFormat format);

    // Allocates one dmabuf-backed buffer at size using a probed modifier.
    bool allocate(uint32_t width, uint32_t height, DmabufBuffer& out);

    void release(DmabufBuffer& buf);

    const std::vector<uint64_t>& usableModifiers() const { return modifiers_; }

    // DRM fourcc for the probed format (valid after a successful probe()).
    uint32_t fourcc() const { return fourcc_; }

    // Imports a dmabuf-backed buffer into `device` as SharedTextureMemory and
    // creates a wgpu::Texture from it. The dmabuf fd is dup'd by Dawn on import;
    // `buf.fd` remains owned by the caller. Returns false on failure.
    static bool importTexture(const wgpu::Device& device, uint32_t fourcc,
                              const DmabufBuffer& buf,
                              wgpu::SharedTextureMemory& outMem,
                              wgpu::Texture& outTex);

  private:
    int drmFd_ = -1;
    gbm_device* gbm_ = nullptr;
    uint32_t fourcc_ = 0;             // GBM/DRM fourcc for the probed format
    std::vector<uint64_t> modifiers_; // Dawn-importable ∩ GBM-allocatable
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_ALLOCATOR_H_
