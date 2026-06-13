#include "output_host_window.h"

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

}  // namespace overdraw::gpu
