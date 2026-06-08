// Wayland client for the linux-dmabuf-v1 ASYNC create path: identical to
// dmabuf-test-client but uses zwp_linux_buffer_params_v1.create (async) instead
// of create_immed. The server must mint the wl_buffer and deliver it via the
// params `created` event; this client waits for that event, then attaches +
// commits. Covers the path real EGL clients (e.g. kitty/Mesa) take.
//
// Red ARGB8888 0xFFFF0000 -> LE memory [B=0,G=0,R=255,A=255] = WGPU BGRA8Unorm
// readback [0,0,255,255].
//
// Usage: dmabuf-async-client <socket-name>
// Exit: 0 only if the `created` event delivered a buffer AND the surface mapped.

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
#define DRM_FORMAT_ARGB8888 0x34325241  /* 'AR24' */
#define DRM_FORMAT_MOD_LINEAR 0ULL

static struct wl_compositor* compositor = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct zwp_linux_dmabuf_v1* dmabuf = NULL;
static int surface_configured = 0;
static struct wl_buffer* the_buffer = NULL;
static int params_failed = 0;

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) { (void)d;(void)t;(void)w;(void)h;(void)s; }
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; }
static void tlConfigureBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlWmCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlConfigureBounds, tlWmCaps };

static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; surface_configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsListener = { xsConfigure };

static void dmaFormat(void* d, struct zwp_linux_dmabuf_v1* z, uint32_t fmt) { (void)d;(void)z;(void)fmt; }
static void dmaModifier(void* d, struct zwp_linux_dmabuf_v1* z, uint32_t fmt, uint32_t hi, uint32_t lo) { (void)d;(void)z;(void)fmt;(void)hi;(void)lo; }
static const struct zwp_linux_dmabuf_v1_listener dmaListener = { dmaFormat, dmaModifier };

// The async create path: `created` delivers the server-minted wl_buffer.
static void paramsCreated(void* d, struct zwp_linux_buffer_params_v1* p, struct wl_buffer* buf) {
    (void)d;(void)p;
    the_buffer = buf;
    printf("[client] params.created delivered wl_buffer=%p\n", (void*)buf);
}
static void paramsFailed(void* d, struct zwp_linux_buffer_params_v1* p) {
    (void)d;(void)p;
    params_failed = 1;
    fprintf(stderr, "[client] params.failed\n");
}
static const struct zwp_linux_buffer_params_v1_listener paramsListener = { paramsCreated, paramsFailed };

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

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <socket>\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // globals
    wl_display_roundtrip(display);  // dmabuf format/modifier events

    if (!compositor || !wm_base || !dmabuf) {
        fprintf(stderr, "[client] missing globals (compositor=%p wm=%p dmabuf=%p)\n",
                (void*)compositor, (void*)wm_base, (void*)dmabuf);
        return 1;
    }

    int drm = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (drm < 0) { perror("open renderD128"); return 1; }
    struct gbm_device* gbm = gbm_create_device(drm);
    if (!gbm) { fprintf(stderr, "[client] gbm_create_device failed\n"); return 1; }
    uint64_t mod = DRM_FORMAT_MOD_LINEAR;
    struct gbm_bo* bo = gbm_bo_create_with_modifiers(gbm, W, H, DRM_FORMAT_ARGB8888, &mod, 1);
    if (!bo) bo = gbm_bo_create(gbm, W, H, DRM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING);
    if (!bo) { fprintf(stderr, "[client] gbm_bo_create failed\n"); return 1; }

    uint32_t stride = 0;
    void* map_data = NULL;
    void* ptr = gbm_bo_map(bo, 0, 0, W, H, GBM_BO_TRANSFER_WRITE, &stride, &map_data);
    if (!ptr || ptr == MAP_FAILED) { fprintf(stderr, "[client] gbm_bo_map failed\n"); return 1; }
    for (uint32_t y = 0; y < H; ++y) {
        uint32_t* row = (uint32_t*)((uint8_t*)ptr + (size_t)y * stride);
        for (uint32_t x = 0; x < W; ++x) row[x] = 0xFFFF0000u;  /* ARGB red */
    }
    gbm_bo_unmap(bo, map_data);

    int fd = gbm_bo_get_fd(bo);
    uint32_t offset = gbm_bo_get_offset(bo, 0);
    stride = gbm_bo_get_stride(bo);
    uint64_t modifier = gbm_bo_get_modifier(bo);

    struct zwp_linux_buffer_params_v1* params = zwp_linux_dmabuf_v1_create_params(dmabuf);
    zwp_linux_buffer_params_v1_add_listener(params, &paramsListener, NULL);
    zwp_linux_buffer_params_v1_add(params, fd, 0, offset, stride,
                                   (uint32_t)(modifier >> 32), (uint32_t)(modifier & 0xffffffff));
    // ASYNC create: server mints the wl_buffer, delivered via `created`.
    zwp_linux_buffer_params_v1_create(params, W, H, DRM_FORMAT_ARGB8888, 0);

    // Pump until the server answers (created or failed).
    for (int i = 0; i < 200 && !the_buffer && !params_failed; ++i)
        wl_display_roundtrip(display);
    zwp_linux_buffer_params_v1_destroy(params);

    if (params_failed || !the_buffer) {
        fprintf(stderr, "[client] async create did not yield a buffer\n");
        return 1;
    }

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "overdraw-dmabuf-async-test");

    wl_surface_commit(surface);     // map -> configure
    wl_display_roundtrip(display);

    wl_surface_attach(surface, the_buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);     // import happens server-side here
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    printf("[client] committed async dmabuf buffer (configured=%d)\n", surface_configured);

    close(fd);
    usleep(400 * 1000);  // hold for the harness readback

    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(the_buffer);
    wl_surface_destroy(surface);
    gbm_bo_destroy(bo);
    gbm_device_destroy(gbm);
    close(drm);
    zwp_linux_dmabuf_v1_destroy(dmabuf);
    xdg_wm_base_destroy(wm_base);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    printf("[client] done\n");
    return surface_configured ? 0 : 1;
}
