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

void PluginWireClient::startBringUp() {
    // Reserve the plugin instance on this wire client; relay the handle so the
    // GPU process injects its native instance at it (InjectPluginInstance). The
    // rest is driven by pump() as the injection reply + wire events arrive.
    auto ri = link_->client().ReserveInstance();
    instance_ = wgpu::Instance::Acquire(ri.instance);
    link_->setInstance(instance_.Get());
    comp_->injectPluginInstance(connId_, ri.handle.id, ri.handle.generation);
    state_ = State::kInjecting;
    link_->flush();
}

void PluginWireClient::pump() {
    // Steady-state + bring-up wire I/O: drain inbound (resolves RequestAdapter/
    // RequestDevice callbacks via the instance event pump in drainInbound) and
    // flush outbound. Non-blocking.
    link_->pumpOut();
    link_->drainInbound();

    switch (state_) {
        case State::kInjecting: {
            int st = comp_->pluginInstanceInjected(connId_);
            if (st == 2) { error_ = "plugin instance injection failed"; state_ = State::kFailed; return; }
            if (st != 1) return;  // still pending
            // Injected -> request the adapter (once).
            if (!adapterRequested_) {
                adapterRequested_ = true;
                wgpu::RequestAdapterOptions ao{};
                ao.featureLevel = wgpu::FeatureLevel::Core;
                instance_.RequestAdapter(&ao, wgpu::CallbackMode::AllowProcessEvents,
                    [this](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
                        if (s == wgpu::RequestAdapterStatus::Success) adapter_ = std::move(a);
                    });
                link_->flush();
                state_ = State::kAdapter;
            }
            return;
        }
        case State::kAdapter: {
            if (!adapter_) return;  // adapter callback not yet fired
            if (!deviceRequested_) {
                deviceRequested_ = true;
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
                adapter_.RequestDevice(&dd, wgpu::CallbackMode::AllowProcessEvents,
                    [this](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                        if (s == wgpu::RequestDeviceStatus::Success) device_ = std::move(d);
                    });
                link_->flush();
                state_ = State::kDevice;
            }
            return;
        }
        case State::kDevice: {
            if (device_) state_ = State::kDone;
            return;
        }
        case State::kDone:
        case State::kFailed:
            return;
    }
}

}  // namespace overdraw::core
