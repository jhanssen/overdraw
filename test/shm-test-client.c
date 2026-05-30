// Wayland client for the shm buffer path: bind wl_compositor + wl_shm +
// xdg_wm_base, create an shm pool/buffer filled with a known solid color, map an
// xdg_toplevel, attach the buffer, and commit. The server uploads the pixels to
// a GPU texture; the test harness reads them back to verify.
//
// Pixel: ARGB8888 value 0xFF0000FF -> little-endian memory [B=FF,G=00,R=00,A=FF]
// = solid blue, which matches WGPU BGRA8Unorm memory order byte-for-byte.
//
// Usage: shm-test-client <socket-name>

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static int surface_configured = 0;

#define W 64
#define H 64
#define STRIDE (W * 4)
#define POOL_SIZE (STRIDE * H)
#define PIXEL 0xFF0000FFu  /* ARGB8888 solid blue */

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) {
    (void)d; xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) {
    (void)d;(void)t;(void)w;(void)h;(void)s;
}
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; }
static void tlConfigureBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlWmCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlConfigureBounds, tlWmCaps };

static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) {
    (void)d; surface_configured = 1; xdg_surface_ack_configure(xs, serial);
}
static const struct xdg_surface_listener xsListener = { xsConfigure };

static void shmFormat(void* d, struct wl_shm* s, uint32_t fmt) { (void)d;(void)s;(void)fmt; }
static const struct wl_shm_listener shmListener = { shmFormat };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
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
    if (argc < 2) { fprintf(stderr, "usage: %s <socket>\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // globals
    wl_display_roundtrip(display);  // shm format events

    if (!compositor || !shm || !wm_base) {
        fprintf(stderr, "[client] missing globals (compositor=%p shm=%p wm=%p)\n",
                (void*)compositor, (void*)shm, (void*)wm_base);
        return 1;
    }

    // Backing memfd filled with the known pixel.
    int fd = memfd_create("overdraw-shm-test", 0);
    if (fd < 0 || ftruncate(fd, POOL_SIZE) != 0) { perror("memfd"); return 1; }
    uint32_t* px = mmap(NULL, POOL_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); return 1; }
    for (int i = 0; i < W * H; ++i) px[i] = PIXEL;
    munmap(px, POOL_SIZE);

    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, POOL_SIZE);
    struct wl_buffer* buffer = wl_shm_pool_create_buffer(pool, 0, W, H, STRIDE, WL_SHM_FORMAT_ARGB8888);

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "overdraw-shm-test");

    wl_surface_commit(surface);        // map: triggers configure
    wl_display_roundtrip(display);     // receive configure, ack sent

    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);        // upload happens server-side here
    wl_display_roundtrip(display);     // flush commit
    wl_display_roundtrip(display);     // let server process + release

    printf("[client] mapped %dx%d, committed shm buffer (configured=%d)\n", W, H, surface_configured);

    close(fd);
    // Hold the surface alive so the harness can read the uploaded texture back
    // before wl_surface.destroy drops it. The harness reads back during this
    // window (keyed on the committed surface id it observed).
    usleep(400 * 1000);

    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(buffer);
    wl_shm_pool_destroy(pool);
    wl_surface_destroy(surface);
    xdg_wm_base_destroy(wm_base);
    wl_shm_destroy(shm);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    printf("[client] done\n");
    return surface_configured ? 0 : 1;
}
