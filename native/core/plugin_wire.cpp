#include "plugin_wire.h"

#include <cstdio>

#include <fcntl.h>
#include <unistd.h>

#include "compositor.h"
#include "transport.h"

namespace overdraw::core {

PluginWireClient::PluginWireClient(int clientFd, uint32_t connId, Compositor* comp)
    : clientFd_(clientFd), connId_(connId), comp_(comp) {
    // The buffered FrameReader/FdSerializer require a non-blocking fd (else
    // readAvailable() blocks). The socketpair from addWireConnection is blocking
    // by default.
    ipc::setNonBlocking(clientFd_);
    // WireLink sets the process-global wire-client proc table (already set by the
    // core's own WireLink; idempotent). Its own WireClient has a separate handle
    // id-space; wgpu objects route to their owning client per-object, so multiple
    // clients coexist under the one global proc table.
    link_ = std::make_unique<WireLink>(clientFd_, comp->ctrlFd());
}

PluginWireClient::~PluginWireClient() {
    link_.reset();
    if (clientFd_ >= 0) ::close(clientFd_);
}

void PluginWireClient::markSharedWithJs() { link_->markSharedWithExternal(); }

PluginWireClient::SurfaceReservation PluginWireClient::reserveProducerTexture(
        uint32_t surfaceBufId, uint32_t width, uint32_t height) {
    SurfaceReservation out{{0, 0}, {0, 0}, false};
    if (!device_) return out;
    wgpu::TextureDescriptor td{};
    td.size = {width, height, 1};
    td.format = wgpu::TextureFormat::BGRA8Unorm;
    td.usage = wgpu::TextureUsage::RenderAttachment | wgpu::TextureUsage::TextureBinding;
    auto rt = link_->client().ReserveTexture(
        device_.Get(), reinterpret_cast<const WGPUTextureDescriptor*>(&td));
    producerReservations_[surfaceBufId] = rt;
    out.texture = {rt.handle.id, rt.handle.generation};
    out.device = {rt.deviceHandle.id, rt.deviceHandle.generation};
    out.ok = true;
    return out;
}

WGPUTexture PluginWireClient::producerTexture(uint32_t surfaceBufId) const {
    auto it = producerReservations_.find(surfaceBufId);
    return it == producerReservations_.end() ? nullptr : it->second.texture;
}

bool PluginWireClient::bringUp() {
    // Reserve the plugin instance on this wire client; relay the handle so the
    // GPU process injects its native instance at it (InjectPluginInstance).
    auto ri = link_->client().ReserveInstance();
    instance_ = wgpu::Instance::Acquire(ri.instance);
    link_->setInstance(instance_.Get());
    comp_->injectPluginInstance(connId_, ri.handle.id, ri.handle.generation);

    // Pump the wire + the compositor's ctrl drain until the injection completes.
    // (On the main thread libuv is not turning during this synchronous call, so
    // we drive both here.) 1=ok, 2=failed.
    bool injected = link_->pumpUntilTimeout([&] {
        comp_->drainCtrl();
        return comp_->pluginInstanceInjected(connId_) != 0;
    }, 5000);
    if (!injected || comp_->pluginInstanceInjected(connId_) != 1) {
        error_ = "plugin instance injection failed/timed out";
        return false;
    }

    // Adapter.
    wgpu::Adapter adapter;
    {
        wgpu::RequestAdapterOptions ao{};
        ao.featureLevel = wgpu::FeatureLevel::Core;
        bool ready = false;
        instance_.RequestAdapter(&ao, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                if (s == wgpu::RequestAdapterStatus::Success) adapter = std::move(a);
                ready = true;
            });
        link_->flush();
        link_->pumpUntil([&] { return ready; });
    }
    if (!adapter) { error_ = "plugin: no adapter over wire"; return false; }

    // Device with dmabuf + sync-fd features (the producer/consumer primitive).
    {
        wgpu::FeatureName feats[] = {wgpu::FeatureName::SharedTextureMemoryDmaBuf,
                                     wgpu::FeatureName::SharedFenceSyncFD};
        wgpu::DeviceDescriptor dd{};
        dd.requiredFeatureCount = 2;
        dd.requiredFeatures = feats;
        dd.SetUncapturedErrorCallback(
            [](const wgpu::Device&, wgpu::ErrorType t, wgpu::StringView m) {
                std::fprintf(stderr, "[plugin-wire][dawn err %d] %.*s\n",
                             static_cast<int>(t), static_cast<int>(m.length), m.data);
            });
        bool ready = false;
        adapter.RequestDevice(&dd, wgpu::CallbackMode::AllowProcessEvents,
            [&](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                if (s == wgpu::RequestDeviceStatus::Success) device_ = std::move(d);
                ready = true;
            });
        link_->flush();
        link_->pumpUntil([&] { return ready; });
    }
    if (!device_) { error_ = "plugin: no device over wire"; return false; }
    return true;
}

}  // namespace overdraw::core
