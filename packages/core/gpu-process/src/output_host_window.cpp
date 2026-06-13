#include "output_host_window.h"

#include <cstring>

#include <webgpu/webgpu_cpp.h>

namespace overdraw::gpu {

wgpu::Surface HostWindowOutputBackend::createWgpuSurface(wgpu::Instance& instance) {
    wgpu::SurfaceSourceWaylandSurface src{};
    src.display = window_.display();
    src.surface = window_.surface();
    wgpu::SurfaceDescriptor sd{};
    sd.nextInChain = &src;
    return instance.CreateSurface(&sd);
}

namespace {
// Copy a std::string into a fixed-size char buffer, NUL-terminating and
// truncating as needed.
void copyBounded(char* dst, size_t cap, const std::string& src) {
    if (cap == 0) return;
    const size_t n = src.size() < cap - 1 ? src.size() : cap - 1;
    std::memcpy(dst, src.data(), n);
    dst[n] = '\0';
}
}

void HostWindowOutputBackend::describeOutput(OutputDescriptorInfo& out) const {
    // Width/height: the nested window's size, NOT the host monitor's size.
    // Overdraw clients should size themselves to the surface they actually
    // have, which is our nested window.
    out.width  = window_.width();
    out.height = window_.height();

    // Refresh / scale / transform / physical dims: from the host's wl_output
    // when known. These do reflect the underlying display and are correct
    // signals to propagate (refresh affects frame pacing; scale affects
    // physical pixel density; physical dims are useful to DPI-aware clients).
    // Fall back to sensible defaults if the host's events haven't arrived
    // yet (60 Hz, scale 1, transform normal, unknown physical).
    out.refreshMhz       = window_.hostOutputRefreshMhz() ? window_.hostOutputRefreshMhz() : 60000;
    out.scale            = window_.hostOutputScale() ? window_.hostOutputScale() : 1;
    out.transform        = window_.hostOutputTransform();
    out.physicalWidthMm  = window_.hostOutputPhysicalWidthMm();
    out.physicalHeightMm = window_.hostOutputPhysicalHeightMm();

    // Identity: synthesize overdraw's own values. We deliberately do NOT
    // forward the host's make/model/name -- (a) they describe the host's
    // monitor, not our nested window; (b) we'd leak host hardware metadata
    // to overdraw clients.
    copyBounded(out.name,  sizeof(out.name),  std::string{"overdraw-0"});
    copyBounded(out.make,  sizeof(out.make),  std::string{"overdraw"});
    copyBounded(out.model, sizeof(out.model), std::string{"overdraw nested output"});
}

}  // namespace overdraw::gpu
