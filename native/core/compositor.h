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

    // Steady-state hooks (called from libuv handles in the addon).
    void drainWire() { link_->drainInbound(); }
    // Drain the outbound wire queue when the wire fd is writable.
    void wirePumpOut() { link_->pumpOut(); }
    // True if wire bytes are queued awaiting a writable socket (the addon then
    // arms UV_WRITABLE on the wire poll).
    bool wireHasPendingOut() const { return link_->hasPendingOut(); }
    void renderFrame();

    // Upload a client surface's CPU pixels (BGRA8Unorm-equivalent, e.g. shm
    // ARGB8888/XRGB8888) into a sampled wgpu texture over the wire, creating or
    // recreating it if size changed, and mark the surface for compositing. The
    // pixels are tightly read row by row using `stride`. `id` is an opaque
    // per-surface key chosen by the caller.
    void commitSurfaceShm(uint32_t id, uint32_t width, uint32_t height,
                          uint32_t stride, const uint8_t* pixels);

    // Import a client-provided dmabuf (linux-dmabuf-v1) as a sampled texture and
    // mark the surface for compositing. The dmabuf `fd` is owned by the caller
    // and dup'd as needed (passed to the GPU process via SCM_RIGHTS). `drmFourcc`
    // is the client's declared DRM fourcc; `modifier` the client's modifier.
    // NON-BLOCKING: reserves a texture handle, sends the import request over the
    // side channel, records a pending import, and returns immediately. The import
    // completes asynchronously when the ClientTexImported reply is dispatched by
    // drainCtrl() (driven from a libuv poll on the ctrl fd). Returns false only if
    // the request could not be sent. Completed imports surface as "imported"
    // surfaces via takeImportedSurfaces().
    bool commitSurfaceDmabuf(uint32_t id, int fd, uint32_t width, uint32_t height,
                             uint32_t drmFourcc, uint64_t modifier,
                             uint32_t offset, uint32_t stride, uint64_t bufferId);

    // Steady-state hook: drain and dispatch any pending side-channel control
    // messages (currently ClientTexImported, finishing async dmabuf imports).
    // Non-blocking. Driven from a libuv poll on the ctrl fd in the addon.
    void drainCtrl();

    // Drain the set of surface ids that gained presentable content since the last
    // call (first or subsequent commit completed). Both shm and dmabuf commits
    // report here, giving JS a single map-on-first-content signal. Each entry
    // carries the content size for hit-testing. Empties the internal list.
    struct ImportedSurface { uint32_t id; uint32_t width; uint32_t height; };
    void takeImportedSurfaces(std::vector<ImportedSurface>& out);

    // Drain the set of dmabuf bufferIds whose last sampling frame has completed
    // on the GPU (so the client may reuse them). The caller (JS) sends
    // wl_buffer.release for each. Empties the internal freed list.
    void takeFreedBuffers(std::vector<uint64_t>& out);

    // Set a surface's layout rect in output pixels (top-left origin). w/h of 0
    // means "use the surface's content size". Placement is owned by JS; the
    // compositor only stores + applies it. Unknown ids are created lazily so
    // layout can be set before the first buffer commit.
    void setSurfaceLayout(uint32_t id, int32_t x, int32_t y, uint32_t w, uint32_t h);

    // Set the back-to-front draw order. Ids not (yet) committed are tolerated
    // (skipped at draw time). Surfaces absent from the stack are not drawn.
    void setStack(const std::vector<uint32_t>& ids);

    // Stop compositing a surface and release its texture.
    void removeSurface(uint32_t id);

    // True if running headless (offscreen render target, no swapchain/present).
    bool headless() const { return headless_; }

    // Callback for async readbacks: ok + width*height*4 BGRA bytes (empty on fail).
    using ReadbackCb = std::function<void(bool ok, std::vector<uint8_t>&& px)>;

    // Async readback of the COMPOSITED frame (the offscreen capture texture in
    // headless mode). Renders nothing itself -- reads whatever renderFrame() last
    // composited. `cb` is invoked on the Node thread when the GPU map completes,
    // with ok + width*height*4 BGRA bytes. Returns false if no capture texture
    // exists (e.g. not headless). Non-blocking. The staging buffer is held until
    // the map resolves.
    bool readbackFrame(ReadbackCb cb);

    // Test hook: read the surface's uploaded texture back to CPU. ASYNCHRONOUS
    // and non-blocking: kicks off a CopyTextureToBuffer + MapAsync and returns
    // immediately. `cb` is invoked later (on the Node thread, from the wire pump
    // that processes the map completion) with ok + the width*height*4 BGRA bytes.
    // Returns false synchronously only if the surface is unknown / has no texture
    // (in which case `cb` is not called). The in-flight buffer is held internally
    // until the map resolves.
    bool readbackSurface(uint32_t id, ReadbackCb cb);

    // Stop presenting and release GPU/wire resources; signal + reap the GPU
    // process. Idempotent.
    void shutdown();

  private:
    bool handshake();
    // Shared async texture->CPU readback (CopyTextureToBuffer + MapAsync). The
    // staging buffer is held in the map callback until it fires; `cb` gets
    // width*height*4 BGRA bytes. Used by readbackSurface + readbackFrame.
    bool readbackTexture(const wgpu::Texture& tex, uint32_t width, uint32_t height,
                         ReadbackCb cb);

    std::unique_ptr<WireLink> link_;
    pid_t gpuPid_ = -1;
    int wireFd_ = -1;  // owned by Compositor; closed in shutdown()
    int ctrlFd_ = -1;  // owned by Compositor; closed in shutdown()
    bool shutdownDone_ = false;

    bool headless_ = false;
    wgpu::Instance instance_;
    wgpu::Device device_;
    wgpu::Surface surface_;            // nested only
    wgpu::Texture captureTex_;         // headless only: offscreen render target
    wgpu::TextureFormat renderFormat_ = wgpu::TextureFormat::BGRA8Unorm;
    wgpu::RenderPipeline pipeline_;
    wgpu::Sampler sampler_;

    // Client surfaces composited over the wire. Each is drawn as a textured
    // quad placed into its layout rect, in stack order, with alpha blending.
    // Placement and stack order are owned by JS and pushed via setSurfaceLayout
    // / setStack; the compositor only consumes them.
    struct ClientSurface {
        wgpu::Texture texture;
        wgpu::Buffer placementBuf;  // uniform: normalized output rect (vec4)
        wgpu::BindGroup bindGroup;
        uint32_t width = 0;   // content (texture) size
        uint32_t height = 0;
        int32_t x = 0;        // layout position in output pixels (top-left)
        int32_t y = 0;
        uint32_t layoutW = 0; // layout size in output pixels (0 => use content size)
        uint32_t layoutH = 0;
        bool present = false;
        uint64_t currentBufferId = 0;  // dmabuf bufferId backing `texture` (0 = none/shm)
    };
    std::unordered_map<uint32_t, ClientSurface> clientSurfaces_;

    // Dmabuf buffer-release lifecycle. A client dmabuf buffer is held (sampled
    // directly, zero-copy) until the LAST frame that sampled it completes on the
    // GPU. When a new buffer supersedes the current one, the old buffer "retires"
    // tagged with the latest submit serial; its OnSubmittedWorkDone frees it.
    uint64_t submitSerial_ = 0;                  // increments per composited frame
    uint64_t completedSerial_ = 0;               // highest serial whose work is done
    struct RetiringBuffer { uint64_t bufferId; uint64_t retireSerial;
                            wgpu::Texture texture; };  // texture kept alive until freed
    std::vector<RetiringBuffer> retiring_;       // awaiting GPU completion
    std::vector<uint64_t> freed_;                // completed; JS drains via takeFreedBuffers
    void reapRetiredBuffers();                   // move retiring_ -> freed_ by completedSerial_

    // Async dmabuf import: commitSurfaceDmabuf sends ImportClientTex and records
    // the in-flight reservation here, keyed by the reserved texture handle id
    // (which the ClientTexImported reply echoes). The reservation is held -- not
    // Acquire'd or Reclaim'd -- until the reply, which both keeps the handle id
    // from being recycled while in flight and lets drainCtrl finish the import.
    // Per surface these complete in send order (the GPU processes ctrl messages
    // in order; the wire-serial gate only delays, never reorders).
    struct PendingImport {
        uint32_t surfaceId;
        uint64_t bufferId;
        uint32_t width;
        uint32_t height;
        dawn::wire::ReservedTexture reservation;  // held until reply
    };
    std::vector<PendingImport> pendingImports_;  // keyed by reservation.handle.id
    // Finish a completed import (success path): retire the superseded buffer,
    // adopt the injected texture, (re)build the bind group, mark present, and
    // report the surface as imported.
    void finishImport(const PendingImport& pi);
    // Surfaces that gained presentable content since the last drain. Both shm and
    // dmabuf report here for a single JS map-on-first-content path.
    std::vector<ImportedSurface> importedSurfaces_;
    void reportImported(uint32_t id, uint32_t width, uint32_t height);

    // Back-to-front draw order (surface ids). Surfaces not in the stack are not
    // drawn. JS owns this via setStack; ids not yet committed are tolerated.
    std::vector<uint32_t> stack_;

    // Write a surface's placement uniform from its layout rect + output size.
    void updatePlacement(ClientSurface& cs);

    uint32_t windowWidth_ = 0;
    uint32_t windowHeight_ = 0;
    uint64_t presented_ = 0;
    DmabufFeedback dmabufFeedback_;  // formatTableFd owned; closed in shutdown()
    std::string error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_COMPOSITOR_H_
