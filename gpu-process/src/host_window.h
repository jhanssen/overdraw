// Host Wayland output window owned by the GPU process (phase 1 nested mode).
//
// A wl_surface is a client-side proxy bound to one wl_display connection and
// is not shareable across processes; since the wgpu::Surface and compositing
// device live in the GPU process, this connection lives here too.

#ifndef OVERDRAW_GPU_HOST_WINDOW_H_
#define OVERDRAW_GPU_HOST_WINDOW_H_

#include <cstdint>

struct wl_display;
struct wl_compositor;
struct wl_surface;
struct xdg_wm_base;
struct xdg_surface;
struct xdg_toplevel;

namespace overdraw::gpu {

class HostWindow {
  public:
    HostWindow() = default;
    ~HostWindow();

    HostWindow(const HostWindow&) = delete;
    HostWindow& operator=(const HostWindow&) = delete;

    // Connects to the host, creates an xdg_toplevel, and blocks until the
    // first configure. Returns false on failure.
    bool open(const char* title);

    // Pumps queued Wayland events without blocking, then flushes.
    void pump();

    wl_display* display() const { return display_; }
    wl_surface* surface() const { return surface_; }
    uint32_t width() const { return width_; }
    uint32_t height() const { return height_; }
    bool shouldClose() const { return shouldClose_; }

    // Listener trampolines need access; kept public for the C callbacks.
    void onConfigured() { configured_ = true; }
    void onClose() { shouldClose_ = true; }
    void onSize(uint32_t w, uint32_t h) { if (w && h) { width_ = w; height_ = h; } }
    void bindCompositor(wl_compositor* c) { compositor_ = c; }
    void bindWmBase(xdg_wm_base* b) { wmBase_ = b; }

  private:
    wl_display* display_ = nullptr;
    wl_compositor* compositor_ = nullptr;
    xdg_wm_base* wmBase_ = nullptr;
    wl_surface* surface_ = nullptr;
    xdg_surface* xdgSurface_ = nullptr;
    xdg_toplevel* toplevel_ = nullptr;

    bool configured_ = false;
    bool shouldClose_ = false;
    uint32_t width_ = 800;
    uint32_t height_ = 600;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_HOST_WINDOW_H_
