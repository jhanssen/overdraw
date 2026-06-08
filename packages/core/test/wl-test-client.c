// Minimal Wayland client for trampoline testing: connect to a given socket,
// get the registry, bind wl_compositor, call create_surface, roundtrip, exit.
// Proves the server registered the global and dispatched a real request.
//
// Usage: wl-test-client <socket-name>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <wayland-client.h>

static struct wl_compositor* compositor = NULL;
static int got_scale = 0;

static void surfEnter(void* d, struct wl_surface* s, struct wl_output* o) { (void)d;(void)s;(void)o; }
static void surfLeave(void* d, struct wl_surface* s, struct wl_output* o) { (void)d;(void)s;(void)o; }
static void surfPreferredScale(void* d, struct wl_surface* s, int32_t factor) {
    (void)d; (void)s;
    printf("[client] got preferred_buffer_scale = %d\n", factor);
    got_scale = factor;
}
static void surfPreferredTransform(void* d, struct wl_surface* s, uint32_t t) { (void)d;(void)s;(void)t; }
static const struct wl_surface_listener surfListener = {
    surfEnter, surfLeave, surfPreferredScale, surfPreferredTransform
};

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data;
    printf("[client] global: %s v%u\n", iface, version);
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
    printf("[client] connected to %s\n", argv[1]);

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // receive globals

    if (!compositor) { fprintf(stderr, "[client] no wl_compositor\n"); return 1; }
    printf("[client] bound wl_compositor; calling create_surface\n");

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    if (!surface) { fprintf(stderr, "[client] create_surface returned null\n"); return 1; }
    wl_surface_add_listener(surface, &surfListener, NULL);
    wl_display_roundtrip(display);  // flush request; receive the event back
    printf("[client] create_surface OK%s\n", got_scale ? " (event received)" : "");

    wl_surface_destroy(surface);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    printf("[client] done\n");
    return 0;
}
