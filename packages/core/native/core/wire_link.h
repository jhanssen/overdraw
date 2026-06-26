// The core's Dawn wire client transport: owns the FdSerializer and WireClient
// over the wire socket, and provides the pump/flush/request-reply helpers the
// bring-up and steady-state paths need.

#ifndef OVERDRAW_CORE_WIRE_LINK_H_
#define OVERDRAW_CORE_WIRE_LINK_H_

#include <functional>

#include "dawn/wire/WireClient.h"
#include "dawn/webgpu_cpp.h"

#include "side_channel.h"
#include "transport.h"

namespace overdraw::core {

class WireLink {
  public:
    // Takes the core-side wire + side-channel fds (ownership stays with the
    // caller / Compositor; WireLink does not close them).
    WireLink(int wireFd, int ctrlFd);
    ~WireLink();

    WireLink(const WireLink&) = delete;
    WireLink& operator=(const WireLink&) = delete;

    dawn::wire::WireClient& client() { return *client_; }
    int wireFd() const { return wireFd_; }
    int ctrlFd() const { return ctrlFd_; }

    // Mark the wire client as shared with an external JS WebGPU binding
    // (dawn.node) that holds wgpu objects routed through this client. Those
    // objects' finalizers run at process exit and call into the client; if the
    // client were freed first that is a use-after-free. When shared, the
    // destructor disconnects but intentionally leaks the client so late
    // finalizers are safe (process is ending anyway).
    void markSharedWithExternal() { sharedWithExternal_ = true; }

    // The wire instance must be set once reserved so event processing can pump
    // it (wgpuInstanceProcessEvents).
    void setInstance(WGPUInstance inst) { instance_ = inst; }

    // Queue+try-write any pending wire bytes (non-blocking). Returns false on a
    // fatal socket error.
    bool flush() { return serializer_->Flush(); }

    // Emit an in-band control frame (kind != 0) on the wire socket. Flushes any
    // staged Dawn (kind=0) bytes first so the kind switch is a clean FIFO
    // boundary (see FdSerializer::appendFrame). Non-blocking.
    bool appendFrame(ipc::FrameKind kind, const void* payload, size_t len) {
        return serializer_->appendFrame(kind, payload, len);
    }

    // Same, but attaches SCM_RIGHTS fds to the frame (for ImportClientTex,
    // whose dmabuf fd rides in-band so the slot allocation is FIFO-ordered
    // with surrounding wire commands). The caller still owns its fds and may
    // close them once this returns; the serializer dup's them into the queue.
    bool appendFrameWithFds(ipc::FrameKind kind, const void* payload, size_t len,
                            const int* fds, int nfds) {
        return serializer_->appendFrameWithFds(kind, payload, len, fds, nfds);
    }

    // Drain the outbound wire queue as far as the socket accepts. Call when the
    // wire fd is writable. Returns false on fatal error.
    bool pumpOut() { return serializer_->pumpOut(); }
    bool hasPendingOut() const { return serializer_->hasPendingOut(); }

    // Cumulative framed wire bytes queued so far (the cross-channel ordering
    // serial). Sample after flush(); send in a ctrl message so the peer defers
    // acting until its wire reader has consumed at least this many bytes.
    uint64_t wireBytesQueued() const { return serializer_->bytesQueued(); }

    // Read and dispatch all currently-available inbound wire frames, then
    // process wire-client events. Non-blocking. For the libuv steady state.
    // Returns false if the peer closed the wire.
    bool drainInbound();

    // Install a handler for inbound non-Dawn frames (kind != WireBytes).
    // Today the only inbound non-Dawn frame is ClientTexImported (kind=4),
    // the reply to a kind=3 ImportClientTex. The dispatcher decodes payload
    // bytes (no fds on inbound, today).
    using InboundFrameHandler =
        std::function<void(ipc::FrameKind, const std::vector<uint8_t>&)>;
    void setInboundFrameHandler(InboundFrameHandler h) {
        inboundHandler_ = std::move(h);
    }
    // For bringUp's transient handler stacking: capture the current handler so
    // a wrapper can chain to it for frame kinds it does not handle itself.
    // Returns the prior handler (possibly empty).
    InboundFrameHandler takeInboundFrameHandler() {
        return std::move(inboundHandler_);
    }

    // Spin (flush + drain one frame + process events) until `done()` or a bound
    // is hit. One-shot bring-up only. Returns done().
    bool pumpUntil(const std::function<bool()>& done);

  private:
    int wireFd_;
    int ctrlFd_;
    ipc::FdSerializer* serializer_ = nullptr;
    ipc::FrameReader* reader_ = nullptr;
    dawn::wire::WireClient* client_ = nullptr;
    WGPUInstance instance_ = nullptr;
    bool sharedWithExternal_ = false;
    InboundFrameHandler inboundHandler_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_WIRE_LINK_H_
