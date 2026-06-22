// Protocol-error test client. Connects, creates a wl_surface, then issues an
// illegal wl_surface.set_buffer_scale(0). The server rejects it with a fatal
// protocol error (wl_resource_post_error / wl_surface invalid_scale). This
// client verifies it observes the disconnect AND the correct error code +
// interface -- the end-to-end proof that postError reaches the client.
//
// Uses only core protocol (wl_compositor / wl_surface from wayland-client.h),
// so it needs no generated client glue.
//
// Usage: wl-error-client <socket-name>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <wayland-client.h>

static struct wl_compositor* compositor = NULL;

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data; (void)version;
    if (strcmp(iface, "wl_compositor") == 0) {
        // v6: set_buffer_scale exists and invalid_scale is defined.
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, 6);
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

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    if (!compositor) { fprintf(stderr, "[client] no wl_compositor v6\n"); return 1; }

    struct wl_surface* s = wl_compositor_create_surface(compositor);
    if (!s) { fprintf(stderr, "[client] create_surface failed\n"); return 1; }

    // Illegal: buffer scale must be positive. The server posts invalid_scale.
    wl_surface_set_buffer_scale(s, 0);

    // The roundtrip must fail: the server disconnects us with a protocol error.
    int rc = wl_display_roundtrip(display);
    int err = wl_display_get_error(display);
    if (rc != -1 || err == 0) {
        fprintf(stderr, "[client] expected a protocol error, got rc=%d err=%d\n", rc, err);
        return 1;
    }
    if (err != EPROTO) {
        fprintf(stderr, "[client] error %d is not EPROTO\n", err);
        return 1;
    }

    const struct wl_interface* iface = NULL;
    uint32_t id = 0;
    uint32_t code = wl_display_get_protocol_error(display, &iface, &id);
    printf("[client] protocol error: code=%u interface=%s\n", code,
           iface ? iface->name : "(null)");
    // wl_surface.invalid_scale == 0.
    if (code != 0 || iface != &wl_surface_interface) {
        fprintf(stderr, "[client] wrong error: code=%u iface=%s\n", code,
                iface ? iface->name : "(null)");
        return 1;
    }

    wl_display_disconnect(display);
    return 0;
}
