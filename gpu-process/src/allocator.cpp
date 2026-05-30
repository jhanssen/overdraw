#include "allocator.h"

#include <cstdio>
#include <fcntl.h>
#include <unistd.h>

#include <gbm.h>
#include <drm_fourcc.h>

namespace overdraw::gpu {
namespace {

// Map a Dawn texture format to its DRM fourcc. The byte/channel order
// convention: WGPU BGRA8Unorm stores B,G,R,A in memory -> DRM ARGB8888 (which
// is little-endian B,G,R,A). RGBA8Unorm -> DRM ABGR8888.
bool fourccFor(wgpu::TextureFormat fmt, uint32_t& out) {
    switch (fmt) {
        case wgpu::TextureFormat::BGRA8Unorm: out = DRM_FORMAT_ARGB8888; return true;
        case wgpu::TextureFormat::RGBA8Unorm: out = DRM_FORMAT_ABGR8888; return true;
        default: return false;
    }
}

}  // namespace

Allocator::~Allocator() {
    if (gbm_) gbm_device_destroy(gbm_);
    if (drmFd_ >= 0) ::close(drmFd_);
}

bool Allocator::open() {
    drmFd_ = ::open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (drmFd_ < 0) {
        std::perror("[gpu] open renderD128");
        return false;
    }
    gbm_ = gbm_create_device(drmFd_);
    if (!gbm_) {
        std::fprintf(stderr, "[gpu] gbm_create_device failed\n");
        return false;
    }
    return true;
}

bool Allocator::probe(const wgpu::Adapter& adapter, wgpu::TextureFormat format) {
    if (!fourccFor(format, fourcc_)) {
        std::fprintf(stderr, "[gpu] no fourcc for format %u\n",
                     static_cast<uint32_t>(format));
        return false;
    }

    // Dawn-importable modifier list for this format (server-side only).
    wgpu::DawnDrmFormatCapabilities drmCaps{};
    wgpu::DawnFormatCapabilities caps{};
    caps.nextInChain = &drmCaps;
    if (adapter.GetFormatCapabilities(format, &caps) != wgpu::Status::Success) {
        std::fprintf(stderr, "[gpu] GetFormatCapabilities failed\n");
        return false;
    }

    // Intersect with what GBM will actually allocate for this fourcc: GBM
    // rejects a create_with_modifiers call constrained to a single modifier it
    // cannot honor, so probe each candidate by a trial allocation.
    modifiers_.clear();
    for (size_t i = 0; i < drmCaps.propertiesCount; ++i) {
        uint64_t mod = drmCaps.properties[i].modifier;
        if (drmCaps.properties[i].modifierPlaneCount != 1) continue;  // slice: single-plane
        gbm_bo* bo = gbm_bo_create_with_modifiers2(
            gbm_, 64, 64, fourcc_, &mod, 1, GBM_BO_USE_RENDERING);
        if (bo) {
            modifiers_.push_back(mod);
            gbm_bo_destroy(bo);
        }
    }

    std::printf("[gpu] probe: format=%u fourcc=0x%08x dawn-modifiers=%zu usable=%zu\n",
                static_cast<uint32_t>(format), fourcc_,
                static_cast<size_t>(drmCaps.propertiesCount), modifiers_.size());

    return !modifiers_.empty();
}

bool Allocator::allocate(uint32_t width, uint32_t height, DmabufBuffer& out) {
    if (modifiers_.empty()) return false;

    // Constrain to the full usable set; GBM picks the best it supports.
    gbm_bo* bo = gbm_bo_create_with_modifiers2(
        gbm_, width, height, fourcc_, modifiers_.data(), modifiers_.size(),
        GBM_BO_USE_RENDERING);
    if (!bo) {
        std::fprintf(stderr, "[gpu] gbm_bo_create_with_modifiers2 %ux%u failed\n",
                     width, height);
        return false;
    }
    if (gbm_bo_get_plane_count(bo) != 1) {
        std::fprintf(stderr, "[gpu] multi-plane bo not supported in slice\n");
        gbm_bo_destroy(bo);
        return false;
    }

    int fd = gbm_bo_get_fd_for_plane(bo, 0);
    if (fd < 0) {
        std::fprintf(stderr, "[gpu] gbm_bo_get_fd_for_plane failed\n");
        gbm_bo_destroy(bo);
        return false;
    }

    out.bo = bo;
    out.fd = fd;
    out.modifier = gbm_bo_get_modifier(bo);
    out.stride = gbm_bo_get_stride_for_plane(bo, 0);
    out.offset = gbm_bo_get_offset(bo, 0);
    out.width = width;
    out.height = height;

    std::printf("[gpu] allocated dmabuf %ux%u fd=%d modifier=0x%016llx stride=%u offset=%u\n",
                width, height, fd,
                static_cast<unsigned long long>(out.modifier),
                out.stride, out.offset);
    return true;
}

bool Allocator::importTexture(const wgpu::Device& device, uint32_t fourcc,
                              const DmabufBuffer& buf,
                              wgpu::SharedTextureMemory& outMem,
                              wgpu::Texture& outTex) {
    wgpu::SharedTextureMemoryDmaBufPlane plane{};
    plane.fd = buf.fd;
    plane.offset = buf.offset;
    plane.stride = buf.stride;

    wgpu::SharedTextureMemoryDmaBufDescriptor dmaDesc{};
    dmaDesc.size = {buf.width, buf.height, 1};
    dmaDesc.drmFormat = fourcc;
    dmaDesc.drmModifier = buf.modifier;
    dmaDesc.planeCount = 1;
    dmaDesc.planes = &plane;

    wgpu::SharedTextureMemoryDescriptor stmDesc{};
    stmDesc.nextInChain = &dmaDesc;
    outMem = device.ImportSharedTextureMemory(&stmDesc);
    if (!outMem) {
        std::fprintf(stderr, "[gpu] ImportSharedTextureMemory failed\n");
        return false;
    }

    wgpu::SharedTextureMemoryProperties props{};
    outMem.GetProperties(&props);
    std::printf("[gpu] STM props: %ux%u format=%u usage=0x%x\n",
                props.size.width, props.size.height,
                static_cast<uint32_t>(props.format),
                static_cast<uint32_t>(props.usage));

    outTex = outMem.CreateTexture();
    if (!outTex) {
        std::fprintf(stderr, "[gpu] SharedTextureMemory.CreateTexture failed\n");
        return false;
    }
    return true;
}

void Allocator::release(DmabufBuffer& buf) {
    if (buf.fd >= 0) { ::close(buf.fd); buf.fd = -1; }
    if (buf.bo) { gbm_bo_destroy(buf.bo); buf.bo = nullptr; }
}

}  // namespace overdraw::gpu
