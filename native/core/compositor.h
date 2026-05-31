// The core compositor: owns the wire link, the wgpu objects, and the
// presentation logic. Brings up the device/surface over the wire, then renders
// the textured-quad compositing pass per frame, sampling client-surface
// textures uploaded via commitSurfaceShm.
//
// This class holds no libuv/N-API concerns; the addon drives renderFrame() and
// drainWire() from libuv handles and owns the GPU-process lifecycle handoff.

#ifndef OVERDRAW_CORE_COMPOSITOR_H_
#define OVERDRAW_CORE_COMPOSITOR_H_

#include <sys/types.h>  // dev_t, pid_t

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "dawn/webgpu_cpp.h"

#include "wire_link.h"

namespace overdraw::core {

class Compositor {
  public:
    // `headless` (with a fixed width/height) brings up with NO swapchain: the
    // compositing pass renders into an owned offscreen texture (read back via
    // readbackFrame) instead of a surface, and nothing is presented. Used by
    // tests; the GPU process must also be spawned with matching --headless WxH.
    Compositor(int wireFd, int ctrlFd, pid_t gpuPid,
               bool headless = false, uint32_t headlessW = 0, uint32_t headlessH = 0);
    ~Compositor();

    Compositor(const Compositor&) = delete;
    Compositor& operator=(const Compositor&) = delete;

    // Hello handshake + bring-up (adapter, device, surface, compositing
    // pipeline). Blocking, one-shot. Returns false and sets error() on failure.
    bool bringUp();
    const std::string& error() const { return error_; }

    uint32_t windowWidth() const { return windowWidth_; }
    uint32_t windowHeight() const { return windowHeight_; }
    uint64_t presented() const { return presented_; }

    // Raw wire-client handles for the core's compositing instance + device, so a
    // JS WebGPU binding (wire-retargeted dawn.node) can wrap them and issue
    // WebGPU commands over the same wire connection. Valid only after bringUp().
    WGPUInstance instanceHandle() const { return instance_.Get(); }
    WGPUDevice deviceHandle() const { return device_.Get(); }

    // Declare that the wire client is now shared with a JS WebGPU binding so its
    // wgpu objects (whose finalizers run at process exit) outlive the client.
    void markWireSharedWithJs() { link_->markSharedWithExternal(); }

    // Import a client dmabuf as a wire texture FOR THE JS COMPOSITOR: reserve a
    // texture handle, send ImportClientTex (fd via SCM_RIGHTS), and return an
    // importId. Unlike commitSurfaceDmabuf, this builds NO native compositing
    // state -- on completion the injected texture's wire HANDLE is reported via
    // takeCompletedJsImports() for JS to wrap (dawn.node wrapTexture). Returns 0
    // if the request could not be sent.
    uint32_t importDmabufForJs(int fd, uint32_t width, uint32_t height,
                               uint32_t drmFourcc, uint64_t modifier,
                               uint32_t offset, uint32_t stride);

    // A completed JS dmabuf import. `tex` owns one ref to the injected texture;
    // the caller hands `tex.Get()` to JS (which AddRefs via wrapTexture) and then
    // lets `tex` drop, leaving JS as the owner. `ok=false` => import failed.
    struct JsImportDone { uint32_t importId; uint32_t width; uint32_t height;
                          wgpu::Texture tex; bool ok; };
    void takeCompletedJsImports(std::vector<JsImportDone>& out);

    // Release a JS dmabuf import: tells the GPU process to drop the imported STM +
    // dmabuf fd for this importId (generation-matched, so a recycled handle id is
    // not freed by mistake). Called when the JS compositor frees the buffer (its
    // last sampling frame completed) or the surface is removed. No-op if unknown.
    void releaseDmabufImport(uint32_t importId);

    // linux-dmabuf-v1 default-feedback data captured from the GPU process during
    // bring-up. `formatTableFd` is an owned read-only memfd of 16-byte
    // {format,pad,modifier} records (mmap by the client); -1 if none was sent.
    // `mainDevice` is the DRM device dev_t; `entryCount`/`formatTableSize`
    // describe the table. The fd ownership transfers to the caller of
    // takeDmabufFormatTableFd(); other fields are copyable accessors.
    struct DmabufFeedback {
        int formatTableFd = -1;
        uint64_t mainDevice = 0;
        uint32_t entryCount = 0;
        uint32_t formatTableSize = 0;
    };
    const DmabufFeedback& dmabufFeedback() const { return dmabufFeedback_; }
    // A fresh dup of the format_table memfd (caller owns/closes). -1 if none.
    int dupDmabufFormatTableFd() const;

    int wireFd() const { return link_->wireFd(); }
    int ctrlFd() const { return ctrlFd_; }

    // --- Plugin wire connections (C-M2) ---------------------------------------
    // Create a new plugin wire connection: socketpair, send the GPU-end fd to the
    // GPU process over the side channel (AddWireConn, SCM_RIGHTS), and return the
    // CLIENT-end fd (owned by the caller -> handed to the plugin's Worker) plus
    // an opaque connId. The GPU-process registration completes asynchronously;
    // poll wireConnAdded(connId). Returns clientFd=-1 on failure.
    struct PluginConnHandle { uint32_t connId; int clientFd; };
    PluginConnHandle addWireConnection();
    // Relay the instance handle the plugin's wire client reserved so the GPU
    // process injects its native instance at that handle. Completion is async;
    // poll pluginInstanceInjected(connId).
    void injectPluginInstance(uint32_t connId, uint32_t instanceId, uint32_t instanceGen);
    // Tell the GPU process the plugin's device handle so it DeviceTick's it each
    // pump (the plugin device's queue must advance for map/work-done to resolve).
    void setPluginTickDevice(uint32_t connId, uint32_t deviceId, uint32_t deviceGen);
    // Async-completion polls (driven by drainCtrl): 0=pending, 1=ok, 2=failed.
    int wireConnAdded(uint32_t connId) const;
    int pluginInstanceInjected(uint32_t connId) const;

    // --- Plugin producer/consumer surface buffer (C-M4 step 2) ----------------
    // Reserve a CORE-device texture (the consumer side: TextureBinding|CopySrc)
    // for a plugin surface buffer, returning its wire handle + the surfaceBufId
    // to use. Holds the reservation alive (keyed by surfaceBufId). The plugin
    // (producer) reserves its own texture on its wire client; the caller then
    // calls sendAllocSurfaceBuf with both handles.
    struct ReservedHandle { uint32_t id; uint32_t generation; };
    struct CoreSurfaceReservation {
        uint32_t surfaceBufId;
        ReservedHandle texture;   // core reserved texture handle
        ReservedHandle device;    // core device wire handle
    };
    CoreSurfaceReservation reserveCoreSurfaceTexture(uint32_t width, uint32_t height);
    // Send AllocSurfaceBuf (one GBM dmabuf imported into plugin+core devices,
    // injected at both reserved handles). Completion async; poll
    // surfaceBufAllocated(surfaceBufId).
    void sendAllocSurfaceBuf(uint32_t surfaceBufId, uint32_t connId,
                             uint32_t width, uint32_t height,
                             ReservedHandle pluginDevice, ReservedHandle pluginTexture,
                             ReservedHandle coreDevice, ReservedHandle coreTexture);
    int surfaceBufAllocated(uint32_t surfaceBufId) const;
    // The core's wrapped texture handle for a successfully-allocated surface buf
    // (the consumer texture the JS compositor wraps + samples). 0 if unknown.
    WGPUTexture coreSurfaceTexture(uint32_t surfaceBufId) const;

    // --- Per-frame producer/consumer fence dance (C-M4 step 3) ----------------
    // Send a surface access bracket message. Begin ops (ProducerBegin/
    // ConsumerBegin) complete async (poll surfaceBeginDone); End ops are
    // fire-and-forget (ordering preserved by the next Begin's fence wait).
    void sendProducerBegin(uint32_t surfaceBufId);
    // `pluginWireSerial` is the plugin wire's bytesQueued after flushing the
    // plugin's render: the GPU process defers the producer EndAccess until its
    // plugin-conn reader has consumed that many bytes (render-before-EndAccess).
    void sendProducerEnd(uint32_t surfaceBufId, uint64_t pluginWireSerial);
    void sendConsumerBegin(uint32_t surfaceBufId);
    void sendConsumerEnd(uint32_t surfaceBufId);
    // Begin-done poll, keyed by surfaceBufId: 0=pending, 1=producer-begin-done,
    // 2=consumer-begin-done, 3=failed. Cleared to 0 when the matching Begin is
    // sent so the next poll waits afresh.
    int surfaceBeginDone(uint32_t surfaceBufId) const;

    // The JS compositor drives every frame: it acquires the output texture,
    // renders into it over the wire, and presents. The C++ Compositor no longer
    // has a compositing pass -- it provides WSI (surface/acquire/present), dmabuf
    // import, and the wire link.
    //
    // Acquire the host swapchain's current texture (nested only). Holds a ref
    // until presentOutput(); returns the wire texture handle (or null headless /
    // no surface). JS wraps it (dawn.node wrapTexture) as the render target.
    WGPUTexture acquireOutputTextureHandle();
    // Present the previously-acquired output texture (Present over the wire) and
    // drop the held ref. No-op headless.
    void presentOutput();
    // The swapchain's texture format (the JS pipeline's color-target format must
    // match). Valid after bringUp().
    wgpu::TextureFormat outputFormat() const { return renderFormat_; }

    // Steady-state hooks (called from libuv handles in the addon).
    void drainWire() { link_->drainInbound(); }
    // Drain the outbound wire queue when the wire fd is writable.
    void wirePumpOut() { link_->pumpOut(); }
    // True if wire bytes are queued awaiting a writable socket (the addon then
    // arms UV_WRITABLE on the wire poll).
    bool wireHasPendingOut() const { return link_->hasPendingOut(); }
    // Per-frame hook from the addon's frame timer: flush queued wire output. The
    // JS compositor records + presents the frame; this just drains the wire.
    void renderFrame();

    // Steady-state hook: drain and dispatch any pending side-channel control
    // messages (ClientTexImported, finishing async JS dmabuf imports).
    // Non-blocking. Driven from a libuv poll on the ctrl fd in the addon.
    void drainCtrl();

    // True if running headless (no host window/surface; the JS compositor renders
    // into its own offscreen target).
    bool headless() const { return headless_; }

    // Stop presenting and release GPU/wire resources; signal + reap the GPU
    // process. Idempotent.
    void shutdown();

  private:
    bool handshake();

    std::unique_ptr<WireLink> link_;
    pid_t gpuPid_ = -1;
    int wireFd_ = -1;  // owned by Compositor; closed in shutdown()
    int ctrlFd_ = -1;  // owned by Compositor; closed in shutdown()
    bool shutdownDone_ = false;

    // Plugin wire connections: async-completion status keyed by connId
    // (0=pending, 1=ok, 2=failed), updated by drainCtrl.
    uint32_t nextConnId_ = 1;
    std::unordered_map<uint32_t, int> wireConnAdded_;
    std::unordered_map<uint32_t, int> pluginInstanceInjected_;

    // Plugin surface buffers: the core-side reservation (held alive) + alloc
    // status, keyed by surfaceBufId.
    uint32_t nextSurfaceBufId_ = 1;
    std::unordered_map<uint32_t, dawn::wire::ReservedTexture> coreSurfaceReservations_;
    std::unordered_map<uint32_t, int> surfaceBufAllocated_;
    // Per-surface Begin-done status (0=pending,1=producer,2=consumer,3=failed).
    std::unordered_map<uint32_t, int> surfaceBeginDone_;

    bool headless_ = false;
    wgpu::Texture currentOutputTexture_;  // held between acquire + present
    wgpu::Instance instance_;
    wgpu::Device device_;
    wgpu::Surface surface_;            // nested only
    wgpu::TextureFormat renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;

    // JS-compositor dmabuf imports (importDmabufForJs): reserve a texture, send
    // ImportClientTex, hold the reservation until the GPU replies, then hand the
    // injected handle to JS. Completion reports the texture handle to JS instead
    // of building native compositing state.
    struct PendingJsImport {
        uint32_t importId;
        uint32_t width;
        uint32_t height;
        dawn::wire::ReservedTexture reservation;  // held until reply
    };
    std::vector<PendingJsImport> pendingJsImports_;
    std::vector<JsImportDone> completedJsImports_;
    uint32_t nextJsImportId_ = 1;
    // importId -> the injected texture's wire handle {id,generation}, kept so a
    // later releaseDmabufImport can address the GPU-side entry. Erased on release.
    struct WireHandleId { uint32_t id; uint32_t generation; };
    std::unordered_map<uint32_t, WireHandleId> jsImportHandles_;

    uint32_t windowWidth_ = 0;
    uint32_t windowHeight_ = 0;
    uint64_t presented_ = 0;
    DmabufFeedback dmabufFeedback_;  // formatTableFd owned; closed in shutdown()
    std::string error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_COMPOSITOR_H_
