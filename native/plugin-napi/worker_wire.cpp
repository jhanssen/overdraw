#include "worker_wire.h"

#include <cstdio>
#include <fcntl.h>
#include <unistd.h>

#include "transport.h"

namespace overdraw::plugin {

WorkerWireClient::WorkerWireClient(int fd) : fd_(fd) {
    ipc::setNonBlocking(fd_);
    // WireLink owns the wire client over this fd. ctrlFd is unused here (the core
    // owns the side channel); pass -1. WireLink sets the process-global wire-client
    // proc table (idempotent if already set in this isolate).
    link_ = std::make_unique<core::WireLink>(fd_, -1);
}

WorkerWireClient::~WorkerWireClient() {
    link_.reset();
    if (fd_ >= 0) ::close(fd_);
}

WorkerWireClient::Handle WorkerWireClient::reserveInstance() {
    auto ri = link_->client().ReserveInstance();
    instance_ = wgpu::Instance::Acquire(ri.instance);
    link_->setInstance(instance_.Get());
    link_->flush();
    return {ri.handle.id, ri.handle.generation};
}

void WorkerWireClient::startDevice() {
    // Request the adapter; the device follows in pump() once the adapter resolves.
    if (adapterRequested_) return;
    adapterRequested_ = true;
    wgpu::RequestAdapterOptions ao{};
    ao.featureLevel = wgpu::FeatureLevel::Core;
    instance_.RequestAdapter(&ao, wgpu::CallbackMode::AllowProcessEvents,
        [this](wgpu::RequestAdapterStatus s, wgpu::Adapter a, wgpu::StringView) {
            if (s == wgpu::RequestAdapterStatus::Success) adapter_ = std::move(a);
            else { failed_ = true; error_ = "plugin: no adapter over wire"; }
        });
    link_->flush();
}

void WorkerWireClient::pump() {
    // flush() (NOT just pumpOut) commits dawn.node-issued commands into the wire
    // out-queue; drainInbound reads replies + pumps the instance to resolve
    // AllowProcessEvents callbacks.
    link_->flush();
    link_->drainInbound();
    if (failed_ || device_) return;
    if (adapter_ && !deviceRequested_) {
        deviceRequested_ = true;
        wgpu::FeatureName feats[] = {wgpu::FeatureName::SharedTextureMemoryDmaBuf,
                                     wgpu::FeatureName::SharedFenceSyncFD};
        wgpu::DeviceDescriptor dd{};
        dd.requiredFeatureCount = 2;
        dd.requiredFeatures = feats;
        dd.SetUncapturedErrorCallback(
            [](const wgpu::Device&, wgpu::ErrorType t, wgpu::StringView m) {
                std::fprintf(stderr, "[worker-wire][dawn err %d] %.*s\n",
                             static_cast<int>(t), static_cast<int>(m.length), m.data);
            });
        adapter_.RequestDevice(&dd, wgpu::CallbackMode::AllowProcessEvents,
            [this](wgpu::RequestDeviceStatus s, wgpu::Device d, wgpu::StringView) {
                if (s == wgpu::RequestDeviceStatus::Success) device_ = std::move(d);
                else { failed_ = true; error_ = "plugin: no device over wire"; }
            });
        link_->flush();
    }
}

WorkerWireClient::SurfaceReservation WorkerWireClient::reserveProducerTexture(
        uint32_t surfaceBufId, uint32_t w, uint32_t h) {
    SurfaceReservation out{{0, 0}, {0, 0}, false};
    if (!device_) return out;
    wgpu::TextureDescriptor td{};
    td.size = {w, h, 1};
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

WGPUTexture WorkerWireClient::producerTexture(uint32_t surfaceBufId) const {
    auto it = producerReservations_.find(surfaceBufId);
    return it == producerReservations_.end() ? nullptr : it->second.texture;
}

}  // namespace overdraw::plugin
