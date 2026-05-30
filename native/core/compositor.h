// The core compositor: owns the wire link, the wgpu objects, and the
// presentation logic. Brings up the device/surface over the wire, then renders
// the textured-quad compositing pass per frame, sampling client-surface
// textures uploaded via commitSurfaceShm.
//
// This class holds no libuv/N-API concerns; the addon drives renderFrame() and
// drainWire() from libuv handles and owns the GPU-process lifecycle handoff.

#ifndef OVERDRAW_CORE_COMPOSITOR_H_
#define OVERDRAW_CORE_COMPOSITOR_H_

#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "dawn/webgpu_cpp.h"

#include "wire_link.h"

namespace overdraw::core {

class Compositor {
  public:
    Compositor(int wireFd, int ctrlFd, pid_t gpuPid);
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

    int wireFd() const { return link_->wireFd(); }

    // Steady-state hooks (called from libuv handles in the addon).
    void drainWire() { link_->drainInbound(); }
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
    // Returns false if the reserve/import/inject round-trip fails (e.g. the
    // driver rejects the client's modifier). Blocking (one side-channel
    // round-trip + wire pump).
    bool commitSurfaceDmabuf(uint32_t id, int fd, uint32_t width, uint32_t height,
                             uint32_t drmFourcc, uint64_t modifier,
                             uint32_t offset, uint32_t stride);

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

    // Test hook: read the surface's uploaded texture back to CPU. Fills `out`
    // with width*height*4 BGRA bytes. Returns false if the surface is unknown
    // or readback fails. Blocking (pumps the wire until the map completes).
    bool readbackSurface(uint32_t id, std::vector<uint8_t>& out);

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

    wgpu::Instance instance_;
    wgpu::Device device_;
    wgpu::Surface surface_;
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
    };
    std::unordered_map<uint32_t, ClientSurface> clientSurfaces_;

    // Back-to-front draw order (surface ids). Surfaces not in the stack are not
    // drawn. JS owns this via setStack; ids not yet committed are tolerated.
    std::vector<uint32_t> stack_;

    // Write a surface's placement uniform from its layout rect + output size.
    void updatePlacement(ClientSurface& cs);

    uint32_t windowWidth_ = 0;
    uint32_t windowHeight_ = 0;
    uint64_t presented_ = 0;
    std::string error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_COMPOSITOR_H_
