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
    // sends AllocSurfaceBuf). Returns the texture + device wire handles + the
    // PLUGIN-wire ordering serial sampled AFTER the flush that committed any
    // pending wire-client traffic into the FdSerializer. Callers MUST pass the
    // `wireSerial` to AllocSurfaceBuf so the GPU process can gate its plugin-
    // side InjectTexture on the plugin wire reader catching up past it.
    //
    // OWNERSHIP / DEFERRED-RECLAIM POLICY. The reservation is stored internally
    // keyed by `surfaceBufId`; ownership stays with the WorkerWireClient. The
    // worker-side API has exactly ONE termination call:
    //
    //   forgetProducerReservation(surfaceBufId): drop the bookkeeping for the
    //   slot, BUT do NOT call ReclaimTextureReservation on the wire client.
    //   Per the deferred-reclaim policy (see ipc::WireBarrier / Compositor::
    //   TaggedReservation for the full reasoning): once the wire id has been
    //   published to the GPU process via AllocSurfaceBuf, the wire-server's
    //   WireServer object table holds an entry there. Recycling the id would
    //   let a future reserveProducerTexture pick the same id at gen+1 and the
    //   subsequent InjectTexture would CONFLICT with the still-registered
    //   object. So forget without reclaiming; the wire client's id pool will
    //   allocate fresh ids for the next ring. Cost: a few {id, generation}
    //   client-side reservation entries leak per resize, bounded by total
    //   resizes (32-bit ids).
    //
    // RECYCLED-HANDLE HAZARD. Wire object handles are {id,generation}; ids
    // would be recycled by Reclaim. The risk is that the GPU process's
    // `InjectTexture` at the new (recycled) id runs BEFORE all wire traffic
    // that references the OLD object at that id has been drained by the wire
    // server -- so the InjectTexture races a still-pending command, and
    // either fails or installs over state that is still being read. The
    // barrier on the receiving side gates InjectTexture on
    // `bytesConsumed() >= wireSerial`. The serial captured here, AFTER a
    // flush, encompasses all bytes the FdSerializer has been handed up to
    // this moment (which includes the OLD-handle-referencing commands).
    //
    // EMPIRICAL CAVEAT. In this Dawn build, `ReserveTexture` itself does NOT
    // emit wire bytes; `ReclaimTextureReservation` does NOT emit
    // UnregisterObjectCmd. Reclaim is pure client-side id-pool; the wire
    // server is never told. That is precisely why "Reclaim after publish" is
    // unsafe: the server still believes the slot is in use. The deferred-
    // reclaim policy (above) encodes that.
    //
    // The flush + bytesQueued sample happens inside this function so the serial
    // cannot be captured too early: folding the reserve, flush, and sample into
    // one call keeps them from being split across separate calls.
    struct SurfaceReservation { Handle texture; Handle device; uint64_t wireSerial; bool ok; };
    SurfaceReservation reserveProducerTexture(uint32_t surfaceBufId, uint32_t w, uint32_t h);
    WGPUTexture producerTexture(uint32_t surfaceBufId) const;
    // Reserve a consumer-side texture on this plugin wire. The
    // plugin is the CONSUMER for a compose buffer (the core produces, the
    // plugin samples). Same reserve-and-flush-and-sample-serial pattern as
    // reserveProducerTexture; usage is TextureBinding|CopySrc (sample +
    // optional readback). Stored separately from producerReservations_ so
    // the same surfaceBufId space can be used for both directions.
    SurfaceReservation reserveConsumerTexture(uint32_t surfaceBufId, uint32_t w, uint32_t h);
    WGPUTexture consumerTexture(uint32_t surfaceBufId) const;
    // Forget a producer-texture reservation slot WITHOUT reclaiming the wire id
    // (deferred-reclaim policy; see above). The id stays allocated on the wire
    // client's id pool until process exit; the WireServer's bookkeeping at
    // that id is preserved (and the GPU process will free its native resources
    // via ReleaseSurfaceBuf, which acts on STM/textures/dmabuf, not the wire-
    // handle id). No-op if the id is unknown.
    void forgetProducerReservation(uint32_t surfaceBufId);
    void forgetConsumerReservation(uint32_t surfaceBufId);

    // In-band producer Begin/End on THIS plugin wire: write a kind=1/kind=2
    // Surface frame (producer=true) for `surfaceBufId`. Begin's FIFO position
    // before the Worker's render commands opens the producer bracket in time;
    // End's position after the render submit closes it after the GPU process
    // decodes those commands.
    // appendFrame flushes staged Dawn bytes first, so the caller does NOT flush.
    void writeBeginAccess(uint32_t surfaceBufId) {
        ipc::SurfaceAccessPayload p{surfaceBufId, /*producer=*/true};
        uint8_t buf[ipc::SurfaceAccessPayload::kSize];
        p.encode(buf);
        link_->appendFrame(ipc::FrameKind::BeginAccess, buf, sizeof(buf));
    }
    void writeEndAccess(uint32_t surfaceBufId) {
        ipc::SurfaceAccessPayload p{surfaceBufId, /*producer=*/true};
        uint8_t buf[ipc::SurfaceAccessPayload::kSize];
        p.encode(buf);
        link_->appendFrame(ipc::FrameKind::EndAccess, buf, sizeof(buf));
    }
    // In-band consumer Begin/End on THIS plugin wire. The plugin
    // is the consumer for compose buffers, so consumer Begin/End ride the
    // plugin wire (inverted from sdk.gpu where consumer = core).
    void writeConsumerBeginAccess(uint32_t surfaceBufId) {
        ipc::SurfaceAccessPayload p{surfaceBufId, /*producer=*/false};
        uint8_t buf[ipc::SurfaceAccessPayload::kSize];
        p.encode(buf);
        link_->appendFrame(ipc::FrameKind::BeginAccess, buf, sizeof(buf));
    }
    void writeConsumerEndAccess(uint32_t surfaceBufId) {
        ipc::SurfaceAccessPayload p{surfaceBufId, /*producer=*/false};
        uint8_t buf[ipc::SurfaceAccessPayload::kSize];
        p.encode(buf);
        link_->appendFrame(ipc::FrameKind::EndAccess, buf, sizeof(buf));
    }

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
    std::unordered_map<uint32_t, dawn::wire::ReservedTexture> consumerReservations_;
};

}  // namespace overdraw::plugin

#endif  // OVERDRAW_PLUGIN_WORKER_WIRE_H_
