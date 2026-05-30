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

    // The wire instance must be set once reserved so event processing can pump
    // it (wgpuInstanceProcessEvents).
    void setInstance(WGPUInstance inst) { instance_ = inst; }

    void flush() { serializer_->Flush(); }

    // Read and dispatch all currently-available inbound wire frames, then
    // process wire-client events. Non-blocking. For the libuv steady state.
    void drainInbound();

    // Spin (flush + drain one frame + process events) until `done()` or a bound
    // is hit. One-shot bring-up only. Returns done().
    bool pumpUntil(const std::function<bool()>& done);

    // Like pumpUntil but bounded to ~maxMs milliseconds. Returns done().
    bool pumpUntilTimeout(const std::function<bool()>& done, int maxMs);

    // Side-channel request -> wait for `replyTag`, pumping the wire meanwhile.
    // One-shot bring-up only. Returns false on timeout.
    bool sendAndWait(const ipc::Message& req, ipc::Tag replyTag, ipc::Message& reply);

  private:
    int wireFd_;
    int ctrlFd_;
    ipc::FdSerializer* serializer_ = nullptr;
    dawn::wire::WireClient* client_ = nullptr;
    WGPUInstance instance_ = nullptr;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_WIRE_LINK_H_
