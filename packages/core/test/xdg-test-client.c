// Wayland client for the xdg-shell first-light path: connect, bind wl_compositor
// + xdg_wm_base, create a surface, get_xdg_surface + get_toplevel, set a title,
// then complete the configure handshake (ack the xdg_surface.configure serial).
// Proves the server dispatches the full toplevel-creation chain and that the
// xdg_toplevel.configure event (carrying a wl_array of states) encodes on the
// wire. No buffer is attached (no buffer path yet).
//
// Usage: xdg-test-client <socket-name>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct xdg_wm_base* wm_base = NULL;

static int toplevel_configured = 0;
static int surface_configured = 0;
static int last_toplevel_w = -1, last_toplevel_h = -1;
static size_t last_states_bytes = 0;
static int saw_activated = 0;

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) {
    (void)d;
    xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h,
                        struct wl_array* states) {
    (void)d; (void)t;
    last_toplevel_w = w;
    last_toplevel_h = h;
    toplevel_configured = 1;
    last_states_bytes = states->size;
    // states is a wl_array of uint32 state values; scan for ACTIVATED (4).
    uint32_t* p;
    wl_array_for_each(p, states) {
        if (*p == XDG_TOPLEVEL_STATE_ACTIVATED) saw_activated = 1;
    }
    printf("[client] xdg_toplevel.configure %dx%d states=%zu bytes activated=%d\n",
           w, h, states->size, saw_activated);
}
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d; (void)t; }
static void tlConfigureBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) {
    (void)d; (void)t; (void)w; (void)h;
}
static void tlWmCapabilities(void* d, struct xdg_toplevel* t, struct wl_array* c) {
    (void)d; (void)t; (void)c;
}
static const struct xdg_toplevel_listener tlListener = {
    tlConfigure, tlClose, tlConfigureBounds, tlWmCapabilities
};

static struct xdg_surface* g_xdg_surface = NULL;
static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) {
    (void)d;
    surface_configured = 1;
    printf("[client] xdg_surface.configure serial=%u; ack\n", serial);
    xdg_surface_ack_configure(xs, serial);
}
static const struct xdg_surface_listener xsListener = { xsConfigure };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data;
    printf("[client] global: %s v%u\n", iface, version);
    if (strcmp(iface, "wl_compositor") == 0) {
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                      version < 4 ? version : 4);
    } else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface,
                                   version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) {
    (void)data; (void)reg; (void)name;
}
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <socket>\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }
    printf("[client] connected to %s\n", argv[1]);

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // receive globals

    if (!compositor) { fprintf(stderr, "[client] no wl_compositor\n"); return 1; }
    if (!wm_base) { fprintf(stderr, "[client] no xdg_wm_base\n"); return 1; }

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    g_xdg_surface = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(g_xdg_surface, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(g_xdg_surface);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "overdraw-test");
    xdg_toplevel_set_app_id(toplevel, "dev.overdraw.test");

    // Per xdg-shell: commit the surface (no buffer) to map the role and start
    // the configure handshake; then roundtrip to receive both configures.
    wl_surface_commit(surface);
    wl_display_roundtrip(display);  // receive configures, send ack
    wl_display_roundtrip(display);  // flush ack

    int ok = toplevel_configured && surface_configured
             && last_states_bytes == 4 && saw_activated;
    printf("[client] handshake: toplevel_configured=%d surface_configured=%d "
           "states_bytes=%zu activated=%d\n",
           toplevel_configured, surface_configured, last_states_bytes, saw_activated);

    // Idiomatic disconnect: a final wl_display_roundtrip forces the
    // server to acknowledge every queued client request (in particular
    // the ack_configure flushed by the previous roundtrip) before we
    // close the socket. Without it, the server's epoll can see
    // EPOLLIN | EPOLLHUP together after the client exits; libwayland's
    // wl_client_connection_data (wayland-server.c) checks HANGUP first
    // and destroys the client without reading the pending bytes -- the
    // last ack_configure gets dropped ~30-40% of the time on this
    // hardware. (See weston tests/harness/weston-test-client-helper.c
    // line ~1335 for the same pattern in weston's test harness.)
    //
    // We DO NOT call xdg_toplevel_destroy / wl_surface_destroy / ...
    // before disconnect: those destroy requests would delete the
    // server-side state the test asserts on. Real clients usually don't
    // destroy these proactively either; libwayland tears them down on
    // socket close.
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
    (void)toplevel; (void)surface;  // resources are reaped by libwayland on disconnect
    printf("[client] done\n");
    return ok ? 0 : 1;
}
