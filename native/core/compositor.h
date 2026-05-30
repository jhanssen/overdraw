// The core compositor: owns the wire link, the wgpu objects, and the
// presentation logic. Brings up the device/surface and the dmabuf interop path
// over the wire, then renders the textured-quad compositing pass per frame.
//
// This class holds no libuv/N-API concerns; the addon drives renderFrame() and
// drainWire() from libuv handles and owns the GPU-process lifecycle handoff.

#ifndef OVERDRAW_CORE_COMPOSITOR_H_
#define OVERDRAW_CORE_COMPOSITOR_H_

#include <cstdint>
#include <memory>
#include <string>

#include "dawn/webgpu_cpp.h"

#include "wire_link.h"

namespace overdraw::core {

class Compositor {
  public:
    Compositor(int wireFd, int ctrlFd, pid_t gpuPid);
    ~Compositor();

    Compositor(const Compositor&) = delete;
    Compositor& operator=(const Compositor&) = delete;

    // Hello handshake + full bring-up (adapter, device, surface, dmabuf
    // reserve/inject + access brackets, compositing pipeline). Blocking,
    // one-shot. Returns false and sets error() on failure.
    bool bringUp();
    const std::string& error() const { return error_; }

    uint32_t windowWidth() const { return windowWidth_; }
    uint32_t windowHeight() const { return windowHeight_; }
    uint64_t presented() const { return presented_; }

    int wireFd() const { return link_->wireFd(); }

    // Steady-state hooks (called from libuv handles in the addon).
    void drainWire() { link_->drainInbound(); }
    void renderFrame();

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
    wgpu::Texture dmaTexture_;
    wgpu::RenderPipeline pipeline_;
    wgpu::BindGroup bindGroup_;

    uint32_t windowWidth_ = 0;
    uint32_t windowHeight_ = 0;
    uint64_t presented_ = 0;
    bool readBracketHeld_ = false;
    std::string error_;
};

}  // namespace overdraw::core

#endif  // OVERDRAW_CORE_COMPOSITOR_H_
