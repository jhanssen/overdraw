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
struct wl_seat;
struct wl_pointer;
struct wl_keyboard;
struct xdg_wm_base;
struct xdg_surface;
struct xdg_toplevel;

namespace overdraw::gpu {

class HostWindow {
  public:
    // `inputFd` is the GPU-side end of the input socket to the core; host
    // pointer/keyboard events are forwarded there. -1 disables forwarding.
    explicit HostWindow(int inputFd = -1) : inputFd_(inputFd) {}
    ~HostWindow();

    HostWindow(const HostWindow&) = delete;
    HostWindow& operator=(const HostWindow&) = delete;

    // Connects to the host, creates an xdg_toplevel, and blocks until the
    // first configure. Returns false on failure.
    bool open(const char* title);

    // Pumps queued Wayland events without blocking, then flushes.
    void pump();
    // The host wl_display fd, for adding to an external event loop (wake on host
    // events; pump() then does the prepare_read/read_events dance).
    int displayFd() const;

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

    // Seat handling: bind on registry, then (re)create pointer/keyboard as the
    // seat advertises capabilities. Public for the C listener trampolines.
    void bindSeat(wl_seat* s);
    void onSeatCapabilities(uint32_t caps);

    // Input forwarding (called from pointer/keyboard listener trampolines).
    // No-op when inputFd_ < 0. `surface` identifies the event target; events on
    // surfaces other than the output surface are ignored.
    int inputFd() const { return inputFd_; }
    wl_surface* surface_raw() const { return surface_; }
    void sendPointerEnter(uint32_t serial, wl_surface* s, int32_t sx, int32_t sy);
    void sendPointerLeave(uint32_t serial, wl_surface* s);
    void sendPointerMotion(uint32_t time, int32_t sx, int32_t sy);
    void sendPointerButton(uint32_t serial, uint32_t time, uint32_t button, uint32_t state);
    void sendPointerAxis(uint32_t time, uint32_t axis, int32_t value, int32_t discrete);
    void sendPointerFrame();
    void sendKeyboardEnter(uint32_t serial, wl_surface* s);
    void sendKeyboardLeave(uint32_t serial, wl_surface* s);
    void sendKeyboardKey(uint32_t serial, uint32_t time, uint32_t key, uint32_t state);
    void sendKeyboardMods(uint32_t serial, uint32_t depressed, uint32_t latched,
                          uint32_t locked, uint32_t group);

  private:
    int inputFd_ = -1;

    wl_display* display_ = nullptr;
    wl_compositor* compositor_ = nullptr;
    xdg_wm_base* wmBase_ = nullptr;
    wl_surface* surface_ = nullptr;
    xdg_surface* xdgSurface_ = nullptr;
    xdg_toplevel* toplevel_ = nullptr;

    wl_seat* seat_ = nullptr;
    wl_pointer* pointer_ = nullptr;
    wl_keyboard* keyboard_ = nullptr;

    bool configured_ = false;
    bool shouldClose_ = false;
    uint32_t width_ = 800;
    uint32_t height_ = 600;
};

}  // namespace overdraw::gpu

#endif  // OVERDRAW_GPU_HOST_WINDOW_H_
