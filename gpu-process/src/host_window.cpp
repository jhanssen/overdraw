#include "host_window.h"

#include <cstring>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

namespace overdraw::gpu {
namespace {

void wmPing(void*, xdg_wm_base* b, uint32_t serial) { xdg_wm_base_pong(b, serial); }
const xdg_wm_base_listener kWmListener = {wmPing};

void regGlobal(void* data, wl_registry* reg, uint32_t name,
               const char* iface, uint32_t version) {
    auto* w = static_cast<HostWindow*>(data);
    if (!std::strcmp(iface, wl_compositor_interface.name)) {
        w->bindCompositor(static_cast<wl_compositor*>(
            wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4)));
    } else if (!std::strcmp(iface, xdg_wm_base_interface.name)) {
        auto* b = static_cast<xdg_wm_base*>(
            wl_registry_bind(reg, name, &xdg_wm_base_interface, 1));
        xdg_wm_base_add_listener(b, &kWmListener, nullptr);
        w->bindWmBase(b);
    }
}
void regRemove(void*, wl_registry*, uint32_t) {}
const wl_registry_listener kRegListener = {regGlobal, regRemove};

void xdgSurfConfigure(void* data, xdg_surface* xs, uint32_t serial) {
    xdg_surface_ack_configure(xs, serial);
    static_cast<HostWindow*>(data)->onConfigured();
}
const xdg_surface_listener kXdgSurfListener = {xdgSurfConfigure};

void tlConfigure(void* data, xdg_toplevel*, int32_t w, int32_t h, wl_array*) {
    static_cast<HostWindow*>(data)->onSize(static_cast<uint32_t>(w), static_cast<uint32_t>(h));
}
void tlClose(void* data, xdg_toplevel*) { static_cast<HostWindow*>(data)->onClose(); }
const xdg_toplevel_listener kTlListener = {tlConfigure, tlClose, nullptr, nullptr};

}  // namespace

HostWindow::~HostWindow() {
    if (toplevel_) xdg_toplevel_destroy(toplevel_);
    if (xdgSurface_) xdg_surface_destroy(xdgSurface_);
    if (surface_) wl_surface_destroy(surface_);
    if (display_) wl_display_disconnect(display_);
}

bool HostWindow::open(const char* title) {
    display_ = wl_display_connect(nullptr);
    if (!display_) return false;

    wl_registry* reg = wl_display_get_registry(display_);
    wl_registry_add_listener(reg, &kRegListener, this);
    wl_display_roundtrip(display_);
    if (!compositor_ || !wmBase_) return false;

    surface_ = wl_compositor_create_surface(compositor_);
    xdgSurface_ = xdg_wm_base_get_xdg_surface(wmBase_, surface_);
    xdg_surface_add_listener(xdgSurface_, &kXdgSurfListener, this);
    toplevel_ = xdg_surface_get_toplevel(xdgSurface_);
    xdg_toplevel_add_listener(toplevel_, &kTlListener, this);
    xdg_toplevel_set_title(toplevel_, title);
    xdg_toplevel_set_app_id(toplevel_, "overdraw");
    wl_surface_commit(surface_);

    while (!configured_ && wl_display_dispatch(display_) != -1) {}
    return configured_;
}

void HostWindow::pump() {
    wl_display_dispatch_pending(display_);
    wl_display_flush(display_);
}

}  // namespace overdraw::gpu
