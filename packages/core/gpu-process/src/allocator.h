// GBM dmabuf allocator + Dawn DRM format/modifier probe (GPU process only).
//
// Naive GBM allocation yields modifiers Dawn rejects on import (notably on
// NVIDIA). The importable set must come from Dawn's GetFormatCapabilities +
// DawnDrmFormatCapabilities on a native server-side adapter, intersected with
// what GBM will actually allocate. This lives GPU-process-side because
// DawnDrmFormatCapabilities is not exposed over the wire.

#ifndef OVERDRAW_GPU_ALLOCATOR_H_
#define OVERDRAW_GPU_ALLOCATOR_H_

#include <sys/types.h>  // dev_t

#include <cstdint>
#include <vector>

#include "dawn/webgpu_cpp.h"

struct gbm_device;
struct gbm_bo;

namespace overdraw::gpu {

// One entry of a linux-dmabuf-v1 feedback format_table. Layout is fixed by the
// protocol: 16 bytes, {format u32, padding u32 (unused), modifier u64}.
struct FormatTableEntry {
    uint32_t format;
    uint32_t padding;
    uint64_t modifier;
};
static_assert(sizeof(FormatTableEntry) == 16, "format_table entry must be 16 bytes");

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

    // Opens a DRM render node and creates the GBM device. The caller passes
    // the node matching the device GPU so allocation and import stay on one
    // GPU; the default is a fallback for diagnostics only.
    bool open(const char* renderNode = "/dev/dri/renderD128");

    // Probes Dawn for the full importable (format, modifier) set on `adapter`,
    // building the dmabuf-feedback format table. Mirrors a GL compositor's
    // enumeration (enumerate every importable format, query its modifiers,
    // append DRM_FORMAT_MOD_INVALID): here the renderer is Dawn, so the source
    // is GetFormatCapabilities + DawnDrmFormatCapabilities per format. Also
    // records the GBM-allocatable modifier subset for the primary format
    // (BGRA8Unorm) used when WE allocate server-side buffers. Returns false if
    // the primary format has no Dawn-importable + GBM-allocatable modifier.
    bool probe(const wgpu::Adapter& adapter);

    // Allocates one dmabuf-backed buffer at size using a probed modifier.
    bool allocate(uint32_t width, uint32_t height, DmabufBuffer& out);

    void release(DmabufBuffer& buf);

    const std::vector<uint64_t>& usableModifiers() const { return modifiers_; }

    // DRM fourcc for the probed format (valid after a successful probe()).
    uint32_t fourcc() const { return fourcc_; }

    // The GBM device opened by open() (borrowed; lifetime tied to this
    // Allocator). Used by the host-window scanout ring to allocate its own
    // dmabufs on the same render device as the wgpu adapter.
    gbm_device* gbm() const { return gbm_; }

    // The DRM device's dev_t (st_rdev of the opened render node), for the
    // linux-dmabuf-v1 feedback main_device / tranche_target_device events.
    // Valid after open(); 0 if unavailable.
    dev_t deviceId() const { return deviceId_; }

    // The linux-dmabuf-v1 feedback format_table built by probe(): every
    // (format, modifier) the renderer can import, across all probed formats,
    // with DRM_FORMAT_MOD_INVALID appended per format. Valid after probe().
    const std::vector<FormatTableEntry>& formatTable() const { return table_; }

    // Imports a dmabuf-backed buffer into `device` as SharedTextureMemory and
    // creates a wgpu::Texture from it. The dmabuf fd is dup'd by Dawn on import;
    // `buf.fd` remains owned by the caller. Returns false on failure.
    static bool importTexture(const wgpu::Device& device, uint32_t fourcc,
                              const DmabufBuffer& buf,
                              wgpu::SharedTextureMemory& outMem,
                              wgpu::Texture& outTex);

  private:
    int drmFd_ = -1;
    dev_t deviceId_ = 0;              // st_rdev of the opened render node
    gbm_device* gbm_ = nullptr;
    uint32_t fourcc_ = 0;             // DRM fourcc of the primary format (BGRA8Unorm)
    std::vector<uint64_t> modifiers_; // primary format: Dawn-importable ∩ GBM-allocatable (we allocate)
    std::vector<FormatTableEntry> table_;  // full importable set across all formats (for feedback)
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_ALLOCATOR_H_
