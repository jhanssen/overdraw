#include "allocator.h"

#include <cstdio>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <gbm.h>
#include <drm_fourcc.h>

namespace overdraw::gpu {
namespace {

// Map a Dawn texture format to its DRM fourcc(s). The byte/channel order
// convention: WGPU BGRA8Unorm stores B,G,R,A in memory -> DRM ARGB8888 (which
// is little-endian B,G,R,A). RGBA8Unorm -> DRM ABGR8888.
//
// Each format yields BOTH the alpha and the opaque DRM fourcc where one exists
// (e.g. ARGB8888 + XRGB8888), with identical modifiers. This matters: a Vulkan
// WSI configuring a BGRA8Unorm swapchain selects the OPAQUE fourcc (XRGB8888)
// for an opaque surface and the alpha one for alpha, and rejects the surface if
// its chosen fourcc is absent. Advertising only the alpha variant is why a
// swapchain Configure() previously failed.
struct FourccPair { uint32_t alpha; uint32_t opaque; };  // opaque==0 if none
bool fourccsFor(wgpu::TextureFormat fmt, FourccPair& out) {
    switch (fmt) {
        case wgpu::TextureFormat::BGRA8Unorm:    out = {DRM_FORMAT_ARGB8888, DRM_FORMAT_XRGB8888}; return true;
        case wgpu::TextureFormat::RGBA8Unorm:    out = {DRM_FORMAT_ABGR8888, DRM_FORMAT_XBGR8888}; return true;
        case wgpu::TextureFormat::RGB10A2Unorm:  out = {DRM_FORMAT_ABGR2101010, DRM_FORMAT_XBGR2101010}; return true;
        case wgpu::TextureFormat::RGBA16Float:   out = {DRM_FORMAT_ABGR16161616F, 0}; return true;
        default: return false;
    }
}

// The texture formats we probe for dmabuf import. Mirrors a GL compositor
// enumerating every renderer-importable format; for Dawn this is the set of
// render/sample formats with a DRM fourcc analog. BGRA8Unorm is primary (the
// preferred swapchain format on Linux); the rest broaden client choice.
constexpr wgpu::TextureFormat kProbeFormats[] = {
    wgpu::TextureFormat::BGRA8Unorm,
    wgpu::TextureFormat::RGBA8Unorm,
    wgpu::TextureFormat::RGB10A2Unorm,
    wgpu::TextureFormat::RGBA16Float,
};

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
    // Capture the device's dev_t for dmabuf-feedback main_device. Non-fatal if
    // it fails; feedback main_device would then be 0 (clients tolerate it).
    struct stat st{};
    if (::fstat(drmFd_, &st) == 0) deviceId_ = st.st_rdev;
    else std::perror("[gpu] fstat render node");
    return true;
}

bool Allocator::probe(const wgpu::Adapter& adapter) {
    table_.clear();
    modifiers_.clear();
    fourcc_ = DRM_FORMAT_ARGB8888;  // BGRA8Unorm; set definitively below

    // Enumerate every probe format, query its Dawn-importable modifiers, and add
    // each (fourcc, modifier) to the feedback table. Each Dawn format yields both
    // its alpha and opaque DRM fourcc (e.g. ARGB8888 + XRGB8888) with the same
    // modifiers -- a WSI configuring a BGRA8 swapchain needs the OPAQUE fourcc
    // present too. Append DRM_FORMAT_MOD_INVALID per fourcc (implicit-modifier
    // import; the legacy-compatible entry clients/WSIs expect).
    for (wgpu::TextureFormat fmt : kProbeFormats) {
        FourccPair fcc;
        if (!fourccsFor(fmt, fcc)) continue;

        wgpu::DawnDrmFormatCapabilities drmCaps{};
        wgpu::DawnFormatCapabilities caps{};
        caps.nextInChain = &drmCaps;
        if (adapter.GetFormatCapabilities(fmt, &caps) != wgpu::Status::Success) {
            std::fprintf(stderr, "[gpu] GetFormatCapabilities failed for fourcc=0x%08x\n", fcc.alpha);
            continue;
        }

        // The DRM fourccs this format contributes (alpha + opaque if present).
        uint32_t fourccs[2] = {fcc.alpha, fcc.opaque};
        int nfourccs = fcc.opaque ? 2 : 1;

        for (int fi = 0; fi < nfourccs; ++fi) {
            uint32_t fourcc = fourccs[fi];
            size_t before = table_.size();
            for (size_t i = 0; i < drmCaps.propertiesCount; ++i) {
                if (drmCaps.properties[i].modifierPlaneCount != 1) continue;  // single-plane only
                uint64_t mod = drmCaps.properties[i].modifier;
                table_.push_back(FormatTableEntry{fourcc, 0, mod});

                // For the primary fourcc (ARGB8888), record the GBM-allocatable
                // subset, used when WE allocate server-side buffers.
                if (fourcc == DRM_FORMAT_ARGB8888) {
                    gbm_bo* bo = gbm_bo_create_with_modifiers2(
                        gbm_, 64, 64, fourcc, &mod, 1, GBM_BO_USE_RENDERING);
                    if (bo) { modifiers_.push_back(mod); gbm_bo_destroy(bo); }
                }
            }
            table_.push_back(FormatTableEntry{fourcc, 0, DRM_FORMAT_MOD_INVALID});
            std::printf("[gpu] probe fourcc=0x%08x modifiers=%zu (+INVALID)\n",
                        fourcc, table_.size() - before);
        }
    }

    std::printf("[gpu] probe: %zu total format-table entries; primary gbm-usable=%zu\n",
                table_.size(), modifiers_.size());

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
