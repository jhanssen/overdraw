// Destructor-request test client. Connects, binds wl_compositor, creates two
// surfaces, destroys the first, then creates a region (a separate request on
// the same wl_compositor). After roundtrip, sleeps so the server can observe
// the destruction state while the client is STILL connected -- the trampoline
// must drop surface1's libwayland resource on the destructor request, not on
// client disconnect.
//
// Usage: wl-destructor-client <socket-name>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <wayland-client.h>

static struct wl_compositor* compositor = NULL;

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_compositor") == 0) {
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                      version < 4 ? version : 4);
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
    if (!compositor) { fprintf(stderr, "[client] no wl_compositor\n"); return 1; }

    struct wl_surface* s1 = wl_compositor_create_surface(compositor);
    struct wl_surface* s2 = wl_compositor_create_surface(compositor);
    if (!s1 || !s2) { fprintf(stderr, "[client] create_surface failed\n"); return 1; }
    wl_display_roundtrip(display);
    printf("[client] created two surfaces\n");

    // Destructor request. The trampoline must release the libwayland resource
    // NOW, not on disconnect.
    wl_surface_destroy(s1);
    wl_display_flush(display);

    // Trigger: a fresh request the server can hook to verify s1 is already
    // destroyed while the client is still connected.
    struct wl_region* r = wl_compositor_create_region(compositor);
    if (!r) { fprintf(stderr, "[client] create_region failed\n"); return 1; }
    wl_display_roundtrip(display);

    // Sleep so the server has time to observe state before we disconnect.
    usleep(200000);

    wl_region_destroy(r);
    wl_surface_destroy(s2);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    printf("[client] done\n");
    return 0;
}
