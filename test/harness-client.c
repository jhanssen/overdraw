// Controllable shm Wayland client for the integration harness.
//
// Maps a single xdg_toplevel backed by a solid-color shm buffer, prints a
// "[harness-client] mapped" line on stdout once the window is up, then holds the
// surface alive until SIGTERM (the harness controls the lifetime; no sleeps).
//
// Usage: harness-client --socket NAME [--size WxH] [--color AARRGGBB]
//                       [--title T] [--app-id ID]
//   defaults: size 200x150, color 0xFF0000FF (opaque blue), title/app-id "harness"
//
// Color is ARGB8888 (the wl_shm format), stored little-endian, matching the
// server's BGRA8Unorm upload byte-for-byte on LE.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <signal.h>
#include <time.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static int surface_configured = 0;
static volatile sig_atomic_t running = 1;

static void onTerm(int sig) { (void)sig; running = 0; }

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) { (void)d;(void)t;(void)w;(void)h;(void)s; }
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; running = 0; }
static void tlConfigureBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlWmCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlConfigureBounds, tlWmCaps };

static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; surface_configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsListener = { xsConfigure };

static void shmFormat(void* d, struct wl_shm* s, uint32_t fmt) { (void)d;(void)s;(void)fmt; }
static const struct wl_shm_listener shmListener = { shmFormat };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name, const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_compositor") == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "wl_shm") == 0) {
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
        wl_shm_add_listener(shm, &shmListener, NULL);
    } else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    const char* socket = NULL;
    const char* title = "harness";
    const char* app_id = "harness";
    int W = 200, H = 150;
    uint32_t color = 0xFF0000FFu;  // opaque blue (ARGB)

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) { sscanf(argv[++i], "%dx%d", &W, &H); }
        else if (strcmp(argv[i], "--color") == 0 && i + 1 < argc) { color = (uint32_t)strtoul(argv[++i], NULL, 16); }
        else if (strcmp(argv[i], "--title") == 0 && i + 1 < argc) title = argv[++i];
        else if (strcmp(argv[i], "--app-id") == 0 && i + 1 < argc) app_id = argv[++i];
    }
    if (!socket) { fprintf(stderr, "usage: %s --socket NAME [--size WxH] [--color AARRGGBB] [--title T] [--app-id ID]\n", argv[0]); return 2; }
    if (W <= 0 || H <= 0) { fprintf(stderr, "[harness-client] bad size\n"); return 2; }

    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[harness-client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // globals
    wl_display_roundtrip(display);  // shm format events

    if (!compositor || !shm || !wm_base) {
        fprintf(stderr, "[harness-client] missing globals (compositor=%p shm=%p wm=%p)\n",
                (void*)compositor, (void*)shm, (void*)wm_base);
        return 1;
    }

    const int stride = W * 4;
    const size_t poolSize = (size_t)stride * H;
    int fd = memfd_create("overdraw-harness", 0);
    if (fd < 0 || ftruncate(fd, poolSize) != 0) { perror("memfd"); return 1; }
    uint32_t* px = mmap(NULL, poolSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); return 1; }
    for (int i = 0; i < W * H; ++i) px[i] = color;
    munmap(px, poolSize);

    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, poolSize);
    struct wl_buffer* buffer = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, title);
    xdg_toplevel_set_app_id(toplevel, app_id);

    wl_surface_commit(surface);        // map: triggers configure
    wl_display_roundtrip(display);     // receive configure, ack sent

    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);        // upload happens server-side here
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    // Signal readiness to the harness (which waits on the window via query()).
    printf("[harness-client] mapped %dx%d title=%s app_id=%s configured=%d\n",
           W, H, title, app_id, surface_configured);
    fflush(stdout);

    // Hold the surface alive, servicing the display, until the harness kills us.
    while (running) {
        if (wl_display_dispatch_pending(display) < 0) break;
        wl_display_flush(display);
        struct timespec ts = { 0, 10 * 1000 * 1000 };  // 10ms
        nanosleep(&ts, NULL);
    }

    close(fd);
    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(buffer);
    wl_shm_pool_destroy(pool);
    wl_surface_destroy(surface);
    wl_display_roundtrip(display);
    xdg_wm_base_destroy(wm_base);
    wl_shm_destroy(shm);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    return 0;
}
