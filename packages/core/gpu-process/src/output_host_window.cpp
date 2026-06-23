#include "output_host_window.h"

#include <cstdio>
#include <cstring>

#include <wayland-client.h>

namespace overdraw::gpu {

HostWindowOutputBackend::~HostWindowOutputBackend() {
    // The ring's dtor destroys its slot wl_buffers; do this BEFORE the
    // HostWindow inside `window_` disconnects from the host display.
    ring_.clear();
}

namespace {

// Per-slot wl_buffer.release trampoline. The listener's userdata is the
// HostWindowOutputBackend (set in installListenersOnRing); the buffer
// pointer in the callback args identifies which slot retired.
void hostBufferRelease(void* data, wl_buffer* buf) {
    static_cast<HostWindowOutputBackend*>(data)->onBufferRelease(buf);
}
const wl_buffer_listener kHostBufferListener = { &hostBufferRelease };

}  // namespace

bool HostWindowOutputBackend::initScanout(gbm_device* gbm,
                                          const wgpu::Device& device,
                                          uint32_t fourcc) {
    // Idempotent: tear down any prior ring first (e.g. host-window resize
    // rebuilds at the new dimensions).
    if (scanoutBuilt_) {
        ring_.clear();
        scanoutBuilt_ = false;
    }
    // Build the candidate modifier list from the host's per-fourcc
    // advertisements: just the modifiers for THIS fourcc, in the order the
    // host advertised them.
    std::vector<uint64_t> hostMods;
    for (const auto& f : window_.hostDmabufFormats()) {
        if (f.fourcc == fourcc) hostMods.push_back(f.modifier);
    }
    if (!ring_.init(gbm, device, window_, window_.width(), window_.height(),
                    fourcc, hostMods)) {
        return false;
    }
    // Install the per-slot wl_buffer.release listener so slot retirement
    // drives the flip-complete callback. The host owns the listener
    // dispatch; we dispatch back to the configured BufferReleaseListener
    // inside onBufferRelease.
    for (size_t i = 0; i < WaylandScanoutRing::kSlotCount; ++i) {
        wl_buffer* b = ring_.slot(static_cast<int>(i)).hostBuffer;
        if (b) wl_buffer_add_listener(b, &kHostBufferListener, this);
    }
    scanoutBuilt_ = true;
    return true;
}

wgpu::Texture HostWindowOutputBackend::acquireScanout(int& outSlotIdx) {
    outSlotIdx = -1;
    if (!scanoutBuilt_) return {};
    const int idx = ring_.acquireFree();
    if (idx < 0) return {};
    outSlotIdx = idx;
    return ring_.slot(idx).tex;
}

void HostWindowOutputBackend::presentScanout(int slotIdx) {
    if (!scanoutBuilt_ || slotIdx < 0) return;
    auto* surface = window_.surface();
    if (!surface) return;
    auto& s = ring_.slot(slotIdx);
    if (!s.hostBuffer) return;

    wl_surface_attach(surface, s.hostBuffer, 0, 0);
    // For now: full-surface damage. A follow-on can forward the per-frame
    // damage region from the JS compositor for the host-side optimization
    // wlroots/Hyprland's wayland backends pass on.
    wl_surface_damage_buffer(surface, 0, 0,
                             static_cast<int32_t>(window_.width()),
                             static_cast<int32_t>(window_.height()));
    wl_surface_commit(surface);
    // Flush so the request actually leaves our outbox; pump() also flushes
    // but on the next loop iteration, which would delay the host's vsync
    // callback chain.
    if (auto* d = window_.display()) wl_display_flush(d);

    ring_.markPendingFlip(slotIdx);
}

void HostWindowOutputBackend::onBufferRelease(wl_buffer* buf) {
    if (!scanoutBuilt_) return;
    const int idx = ring_.slotIndexForHostBuffer(buf);
    if (idx < 0) return;  // stale release for a torn-down ring's buffer
    // The host is no longer using this slot's buffer: the slot is now
    // eligible for the next acquire. Fire the configured callback so the
    // main loop can drive any per-frame-cadence work that gated on a free
    // slot (analogous to KMS's flip-complete dispatch).
    ring_.markFree(idx);
    if (bufferReleaseListener_) bufferReleaseListener_(idx);
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
