// Output backend seam (GPU-process side).
//
// The GPU process drives one display target per run: either a KMS-backed
// DRM connector + atomic modeset + GBM scanout ring (bare-metal mode), or
// a host wl_surface bound to a GBM-allocated dmabuf scanout ring attached
// via the host's zwp_linux_dmabuf_v1 (nested mode). Both implement the
// same interface so main.cpp's pump loop, bring-up flow, and shutdown
// sequence are output-backend-agnostic.
//
// What the interface exposes:
//   - open / close: bring-up + teardown of the display target.
//   - size: current output dimensions, used to size the scanout ring.
//   - describeOutput: identity (refresh / scale / transform / phys-dims /
//     make / model / EDID) shipped to the core via OutputDescriptor.
//   - eventFd / pump: integrate with the GPU process's epoll loop. The
//     backend has a pollable fd; pump() drains pending events on readable.
//   - shouldClose: an exit signal from the backend (the host user closed
//     the window in nested; not used in KMS today).
//   - setResizeListener: notified when the output dimensions change. In
//     nested this is the host's xdg_toplevel.configure(w,h); in KMS this
//     is a future runtime mode-switch hook.
//   - setFrameDoneListener / armFrameCallback: the nested-mode vblank
//     edge driving the present loop (the host's wl_surface.frame.done).
//     KMS leaves these as no-ops; its page-flip path drives the same
//     role via setFlipCompleteListener on the KMS subclass.
//
// Headless mode is NOT an OutputBackend -- there is no output target at
// all. The GPU process branches on `headless` separately and never
// constructs an OutputBackend in that case.

#ifndef OVERDRAW_GPU_OUTPUT_BACKEND_H_
#define OVERDRAW_GPU_OUTPUT_BACKEND_H_

#include <cstdint>
#include <functional>

namespace overdraw::gpu {

struct OutputSize { uint32_t width; uint32_t height; };

// What the GPU process sends to the core over the side channel to describe
// the output. The host-window backend synthesizes this from host wl_output
// state + the nested window size; the KMS backend will fill it from the DRM
// connector. See docs/drm-design.md "Output configuration".
struct OutputDescriptorInfo {
    uint32_t width            = 0;     // logical pixel width  of the scanout target
    uint32_t height           = 0;     // logical pixel height of the scanout target
    uint32_t refreshMhz       = 0;     // Hz * 1000; 0 = unknown
    uint32_t scale            = 1;     // integer wl_output scale (HiDPI multiplier)
    uint32_t transform        = 0;     // wl_output.transform enum value
    uint32_t physicalWidthMm  = 0;     // 0 = unknown
    uint32_t physicalHeightMm = 0;     // 0 = unknown
    char name [64]  = {};               // short identifier (e.g. "DP-1" / "overdraw-0")
    char make [64]  = {};               // monitor make (or "overdraw" in nested mode)
    char model[64]  = {};               // monitor model (or a nested description)
    // Stable durable identifier derived from EDID (manufacturer PNP id +
    // product code + serial). Empty when the connector has no usable EDID
    // (e.g. nested-host backend, or a KMS connector that exposes none).
    // Format: "<MFR>-<PRODUCT_HEX>-<SERIAL_HEX>" (matches the workspace
    // plugin's stable-key shape). See multi-output-design §3.
    char edidId[64] = {};
};

class OutputBackend {
  public:
    virtual ~OutputBackend() = default;

    // Bring up the display target. `title` is the window title for backends
    // that show one (host-window backend); ignored otherwise. Returns false
    // on failure; the GPU process aborts startup.
    virtual bool open(const char* title) = 0;

    // Tear down. Idempotent.
    virtual void close() = 0;

    // Current output dimensions. Stable until a future reconfiguration
    // (slice 3+). Valid only after open().
    virtual OutputSize size() const = 0;

    // Build a fresh OutputDescriptorInfo from the backend's current state.
    // Called once after surface bring-up to seed the core's state.outputs,
    // and again whenever the backend detects a change worth re-emitting.
    // Valid only after open(). The core re-emits wl_output / xdg_output on
    // any change.
    virtual void describeOutput(OutputDescriptorInfo& out) const = 0;

    // Pollable fd for the GPU process's event loop, or -1 if the backend
    // does not have one. The KMS backend's eventFd is the DRM device fd
    // (drm events come in on that); the host-window backend's is the host
    // wl_display fd. The loop calls pump() on UV_READABLE.
    virtual int eventFd() const = 0;

    // Drain queued events. Non-blocking. Called from the epoll callback on
    // readable, plus once per loop iteration as a safety net (mirrors how
    // the existing main loop calls window.pump() unconditionally).
    virtual void pump() = 0;

    // The user has signaled exit through the backend (e.g. closed the host
    // window). The pump loop checks this each iteration.
    virtual bool shouldClose() const = 0;

    // Register a callback fired when the backend's output dimensions change
    // (host-window resize in nested mode; future KMS mode change). The
    // callback receives the NEW width/height. Set once during bring-up;
    // calling again replaces the prior listener. The backend invokes the
    // callback from its pump() (i.e. on the GPU process's event-loop
    // thread), so the listener can synchronously perform GPU work like
    // wgpu::Surface::Configure.
    using ResizeListener = std::function<void(uint32_t, uint32_t)>;
    virtual void setResizeListener(ResizeListener cb) = 0;

    // Frame-done signal (the nested-mode equivalent of KMS's flip-complete).
    // The host-window backend wires this to a `wl_surface.frame` callback on
    // its host wl_surface; the KMS backend has its own page-flip path
    // (KmsOutputBackend::setFlipCompleteListener) and leaves this as a
    // no-op. Both ultimately drive the core's wake/render state machine
    // through ctrl messages (FrameComplete from nested, ScanoutFlipComplete
    // from KMS).
    // Carries the host-frame timestamp (CLOCK_MONOTONIC components) for
    // wp_presentation; the KMS backend's flip-complete listener has its own
    // signature with the kernel vsync sequence included.
    using FrameDoneListener = std::function<void(uint64_t tvSec, uint32_t tvNsec)>;
    virtual void setFrameDoneListener(FrameDoneListener /*cb*/) {}

    // Ensure the backend has a frame-done callback armed (i.e. the host
    // compositor will fire FrameDoneListener at the next vsync). Called from
    // the GPU process pump after open() and after each FrameDoneListener
    // fires. KMS leaves this as a no-op (page-flip events arm themselves on
    // each atomic commit).
    virtual void armFrameCallback() {}
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_OUTPUT_BACKEND_H_
