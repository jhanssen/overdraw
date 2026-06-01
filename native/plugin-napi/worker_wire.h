// WorkerWireClient: a plugin's Dawn wire client, owned by the PLUGIN WORKER
// isolate (architecture.md "IPC": each Worker has its own wire client talking to
// the GPU process directly). Unlike core::PluginWireClient, this has NO
// Compositor / side-channel dependency: the CORE brokers the connection +
// instance injection + surface allocation + fence brackets over the side channel
// (it owns the trusted side channel), and relays results to the Worker via
// postMessage. This class only owns the wire client + device + producer textures
// and runs the plugin's rendering.
//
// Bring-up is interleaved with core round-trips, so it is exposed as discrete
// steps the Worker JS drives as postMessages resolve:
//   open(fd) -> reserveInstance() -> [core injects the instance] ->
//   requestDevice() (pump until ready) -> [core sets tickDevice] -> live.

#ifndef OVERDRAW_PLUGIN_WORKER_WIRE_H_
#define OVERDRAW_PLUGIN_WORKER_WIRE_H_

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>

#include "dawn/wire/WireClient.h"
#include "dawn/webgpu_cpp.h"

#include "core/wire_link.h"

namespace overdraw::plugin {

class WorkerWireClient {
  public:
    struct Handle { uint32_t id; uint32_t generation; };

    // Open the wire client on the connection's client-end fd (handed by the core;
    // a plain integer -- same process/fd table, no SCM_RIGHTS). Sets the fd
    // non-blocking. The core has already done AddWireConn for this fd.
    explicit WorkerWireClient(int fd);
    ~WorkerWireClient();
    WorkerWireClient(const WorkerWireClient&) = delete;
    WorkerWireClient& operator=(const WorkerWireClient&) = delete;

    // Reserve the plugin instance; the returned handle is relayed to the core,
    // which InjectPluginInstance's its native instance at it. Call once.
    Handle reserveInstance();

    // After the core reports the instance injected: request adapter + device
    // (dmabuf + sync-fd features). Async, driven by pump(); poll deviceReady().
    void startDevice();
    void pump();             // drive wire I/O + advance device bring-up
    bool deviceReady() const { return device_ != nullptr; }
    bool failed() const { return failed_; }
    const std::string& error() const { return error_; }

    // Handles for dawn.node wrapDevice(instance, device).
    WGPUInstance instanceHandle() const { return instance_.Get(); }
    WGPUDevice deviceHandle() const { return device_.Get(); }
    Handle deviceWireHandle() const {
        auto h = link_->client().GetWireHandle(device_.Get());
        return {h.id, h.generation};
    }

    // Reserve a producer texture (RenderAttachment|TextureBinding) for a surface
    // buffer; the GPU process injects the dmabuf texture at this handle (the core
    // sends AllocSurfaceBuf). Returns the texture + device wire handles.
    struct SurfaceReservation { Handle texture; Handle device; bool ok; };
    SurfaceReservation reserveProducerTexture(uint32_t surfaceBufId, uint32_t w, uint32_t h);
    WGPUTexture producerTexture(uint32_t surfaceBufId) const;
    // Release a producer-texture reservation (surface teardown): reclaim the wire
    // handle + drop the map entry so it does not leak.
    void releaseProducerTexture(uint32_t surfaceBufId);

    void markSharedWithJs() { link_->markSharedWithExternal(); }
    void flush() { link_->flush(); }
    uint64_t wireBytesQueued() const { return link_->wireBytesQueued(); }
    int fd() const { return fd_; }
    bool hasPendingOut() const { return link_->hasPendingOut(); }
    void pumpOut() { link_->pumpOut(); }

  private:
    int fd_;
    std::unique_ptr<core::WireLink> link_;
    wgpu::Instance instance_;
    wgpu::Adapter adapter_;
    wgpu::Device device_;
    bool adapterRequested_ = false;
    bool deviceRequested_ = false;
    bool failed_ = false;
    std::string error_;
    std::unordered_map<uint32_t, dawn::wire::ReservedTexture> producerReservations_;
};

}  // namespace overdraw::plugin

#endif  // OVERDRAW_PLUGIN_WORKER_WIRE_H_
