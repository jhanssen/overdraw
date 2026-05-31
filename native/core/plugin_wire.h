// A plugin's Dawn wire client: a second wire connection to the GPU process
// (created via Compositor::addWireConnection), with its own WireClient + device.
// Each plugin gets its own connection + device (architecture.md "IPC": one
// dawn::wire::Server per client). The connection's client-end fd is owned here.
//
// C-M4 step 1: brought up on the MAIN thread (reusing the core's already-loaded
// dawn.node + the global wire proc table) to runtime-prove the C-M2 plumbing and
// establish the wire-client-on-fd + device bring-up. Moving the client into the
// plugin's Worker isolate is a later step (gated on the Worker-addon question).

#ifndef OVERDRAW_CORE_PLUGIN_WIRE_H_
#define OVERDRAW_CORE_PLUGIN_WIRE_H_

#include <string>

#include "dawn/wire/WireClient.h"
#include "dawn/webgpu_cpp.h"

#include "wire_link.h"

namespace overdraw::core {

class Compositor;

class PluginWireClient {
  public:
    // `clientFd` is the connection's client end (owned here). `connId` names the
    // connection on the side channel. `comp` is used to relay the reserved
    // instance handle (injectPluginInstance) and drain its reply.
    PluginWireClient(int clientFd, uint32_t connId, Compositor* comp);
    ~PluginWireClient();

    PluginWireClient(const PluginWireClient&) = delete;
    PluginWireClient& operator=(const PluginWireClient&) = delete;

    // Reserve instance -> relay to the GPU process (injectPluginInstance) -> wait
    // its injection -> RequestAdapter -> RequestDevice (dmabuf + sync-fd
    // features). Returns false (with error()) on failure. Synchronous; pumps the
    // wire + the compositor ctrl drain meanwhile. Main-thread bring-up only.
    bool bringUp();

    const std::string& error() const { return error_; }
    uint32_t connId() const { return connId_; }

    // Wire handles for the plugin's instance + device, for dawn.node wrapDevice
    // (same shape as Compositor::gpuHandles). Valid after bringUp().
    WGPUInstance instanceHandle() const { return instance_.Get(); }
    WGPUDevice deviceHandle() const { return device_.Get(); }

    // Mark the wire client shared with JS (dawn.node) so it outlives JS objects.
    void markSharedWithJs();

    // Steady-state pump hooks (driven from the addon's libuv loop, C-M4 later).
    void drainInbound() { link_->drainInbound(); }
    void pumpOut() { link_->pumpOut(); }
    bool hasPendingOut() const { return link_->hasPendingOut(); }
    int wireFd() const { return clientFd_; }

  private:
    int clientFd_;
    uint32_t connId_;
    Compositor* comp_;
    std::unique_ptr<WireLink> link_;
    wgpu::Instance instance_;
    wgpu::Device device_;
    std::string error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_PLUGIN_WIRE_H_
