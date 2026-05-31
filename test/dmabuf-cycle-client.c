// Buffer-cycling dmabuf client for the JS-compositor release-lifecycle leak test.
// Allocates N distinct LINEAR ARGB8888 dmabufs via GBM and commits them in
// sequence on ONE xdg_toplevel (each commit supersedes the prior buffer). This
// drives the compositor's per-buffer import + retire + release path N times, so
// a monitor can confirm the GPU process's imported STM/fd count stays bounded
// (releases happen) rather than growing ~N (leak).
//
// Usage: dmabuf-cycle-client <socket> [frames]   (default frames=40)

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <fcntl.h>
#include <sys/mman.h>

#include <gbm.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "linux-dmabuf-v1-client-protocol.h"

#define W 64
#define H 64
#define DRM_FORMAT_ARGB8888 0x34325241
#define DRM_FORMAT_MOD_LINEAR 0ULL

static struct wl_compositor* compositor = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct zwp_linux_dmabuf_v1* dmabuf = NULL;
static int surface_configured = 0;

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t s) { (void)d; xdg_wm_base_pong(b, s); }
static const struct xdg_wm_base_listener wmListener = { wmPing };
static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) { (void)d;(void)t;(void)w;(void)h;(void)s; }
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; }
static void tlCfgB(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlWmCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlCfgB, tlWmCaps };
static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; surface_configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsListener = { xsConfigure };
static void dmaFormat(void* d, struct zwp_linux_dmabuf_v1* z, uint32_t f) { (void)d;(void)z;(void)f; }
static void dmaModifier(void* d, struct zwp_linux_dmabuf_v1* z, uint32_t f, uint32_t hi, uint32_t lo) { (void)d;(void)z;(void)f;(void)hi;(void)lo; }
static const struct zwp_linux_dmabuf_v1_listener dmaListener = { dmaFormat, dmaModifier };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name, const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_compositor") == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    } else if (strcmp(iface, "zwp_linux_dmabuf_v1") == 0) {
        dmabuf = wl_registry_bind(reg, name, &zwp_linux_dmabuf_v1_interface, version < 3 ? version : 3);
        zwp_linux_dmabuf_v1_add_listener(dmabuf, &dmaListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

// Allocate one filled red dmabuf and wrap it as a wl_buffer.
static struct wl_buffer* makeBuffer(struct gbm_device* gbm) {
    uint64_t mod = DRM_FORMAT_MOD_LINEAR;
    struct gbm_bo* bo = gbm_bo_create_with_modifiers(gbm, W, H, DRM_FORMAT_ARGB8888, &mod, 1);
    if (!bo) bo = gbm_bo_create(gbm, W, H, DRM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING);
    if (!bo) return NULL;
    uint32_t stride = 0; void* md = NULL;
    void* ptr = gbm_bo_map(bo, 0, 0, W, H, GBM_BO_TRANSFER_WRITE, &stride, &md);
    if (ptr && ptr != MAP_FAILED) {
        for (uint32_t y = 0; y < H; ++y) {
            uint32_t* row = (uint32_t*)((uint8_t*)ptr + (size_t)y * stride);
            for (uint32_t x = 0; x < W; ++x) row[x] = 0xFFFF0000u;
        }
        gbm_bo_unmap(bo, md);
    }
    int fd = gbm_bo_get_fd(bo);
    uint32_t offset = gbm_bo_get_offset(bo, 0);
    stride = gbm_bo_get_stride(bo);
    uint64_t modifier = gbm_bo_get_modifier(bo);
    struct zwp_linux_buffer_params_v1* params = zwp_linux_dmabuf_v1_create_params(dmabuf);
    zwp_linux_buffer_params_v1_add(params, fd, 0, offset, stride,
                                   (uint32_t)(modifier >> 32), (uint32_t)(modifier & 0xffffffff));
    struct wl_buffer* buf = zwp_linux_buffer_params_v1_create_immed(params, W, H, DRM_FORMAT_ARGB8888, 0);
    zwp_linux_buffer_params_v1_destroy(params);
    close(fd);
    // bo intentionally leaked for process lifetime (one-shot test client).
    return buf;
}

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <socket> [frames]\n", argv[0]); return 2; }
    int frames = argc >= 3 ? atoi(argv[2]) : 40;
    if (frames < 1) frames = 1;

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[cycle] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
    if (!compositor || !wm_base || !dmabuf) { fprintf(stderr, "[cycle] missing globals\n"); return 1; }

    int drm = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (drm < 0) { perror("open renderD128"); return 1; }
    struct gbm_device* gbm = gbm_create_device(drm);
    if (!gbm) { fprintf(stderr, "[cycle] gbm_create_device failed\n"); return 1; }

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "overdraw-dmabuf-cycle");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);

    // Commit `frames` DISTINCT dmabufs in sequence; each supersedes the prior so
    // the compositor imports + retires + releases per commit.
    for (int i = 0; i < frames; ++i) {
        struct wl_buffer* buf = makeBuffer(gbm);
        if (!buf) { fprintf(stderr, "[cycle] makeBuffer failed at %d\n", i); return 1; }
        wl_surface_attach(surface, buf, 0, 0);
        wl_surface_damage(surface, 0, 0, W, H);
        wl_surface_commit(surface);
        wl_display_roundtrip(display);
        usleep(25 * 1000);  // let a compositor frame sample + complete
    }
    printf("[cycle] committed %d buffers\n", frames);
    fflush(stdout);
    usleep(300 * 1000);  // settle: let final releases drain
    printf("[cycle] done\n");
    return surface_configured ? 0 : 1;
}
