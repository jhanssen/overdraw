// Wayland client for the Layer C per-frame BeginAccess regression test
// (docs/client-buffer-lifecycle.md). Allocates ONE dmabuf, fills it red, and
// commits the SAME wl_buffer many times in sequence -- the cursor-blink /
// focus-change shape. Under the prior (broken) model the compositor sampled
// the same wl_buffer without re-acquiring per frame, producing intermittent
// black frames; the fix is the per-frame Begin/End bracket with a fresh
// dmabuf sync_file acquire fence each Begin. This client drives that path.
//
// Usage: dmabuf-recommit-client <socket> [recommits]   (default recommits=20)

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
static int releases_received = 0;

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
static void bufRelease(void* d, struct wl_buffer* b) { (void)d;(void)b; releases_received++; }
static const struct wl_buffer_listener bufListener = { bufRelease };

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
    if (argc < 2) { fprintf(stderr, "usage: %s <socket> [recommits]\n", argv[0]); return 2; }
    int recommits = argc >= 3 ? atoi(argv[2]) : 20;
    if (recommits < 1) recommits = 1;

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[recommit] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
    if (!compositor || !wm_base || !dmabuf) {
        fprintf(stderr, "[recommit] missing globals\n");
        return 1;
    }

    const char* rnode = getenv("OVERDRAW_RENDER_NODE"); if (!rnode || !*rnode) rnode = "/dev/dri/renderD128";
    int drm = open(rnode, O_RDWR | O_CLOEXEC);
    if (drm < 0) { perror("open render node"); return 1; }
    struct gbm_device* gbm = gbm_create_device(drm);
    if (!gbm) { fprintf(stderr, "[recommit] gbm_create_device failed\n"); return 1; }

    // Allocate ONE dmabuf, filled red, and wrap as a wl_buffer.
    uint64_t mod = DRM_FORMAT_MOD_LINEAR;
    struct gbm_bo* bo = gbm_bo_create_with_modifiers(gbm, W, H, DRM_FORMAT_ARGB8888, &mod, 1);
    if (!bo) bo = gbm_bo_create(gbm, W, H, DRM_FORMAT_ARGB8888, GBM_BO_USE_LINEAR | GBM_BO_USE_RENDERING);
    if (!bo) { fprintf(stderr, "[recommit] gbm_bo_create failed\n"); return 1; }
    uint32_t stride = 0; void* md = NULL;
    void* ptr = gbm_bo_map(bo, 0, 0, W, H, GBM_BO_TRANSFER_WRITE, &stride, &md);
    if (!ptr || ptr == MAP_FAILED) { fprintf(stderr, "[recommit] gbm_bo_map failed\n"); return 1; }
    for (uint32_t y = 0; y < H; ++y) {
        uint32_t* row = (uint32_t*)((uint8_t*)ptr + (size_t)y * stride);
        for (uint32_t x = 0; x < W; ++x) row[x] = 0xFFFF0000u;  // ARGB red
    }
    gbm_bo_unmap(bo, md);
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
    wl_buffer_add_listener(buf, &bufListener, NULL);

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "overdraw-dmabuf-recommit");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);

    // Initial attach+commit: maps the surface.
    wl_surface_attach(surface, buf, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    // Re-commit the SAME wl_buffer `recommits` times. This is the cursor-blink
    // / focus-change shape: the surface's content didn't change but the client
    // is signalling activity. Each commit must trigger a fresh per-frame
    // BeginAccess in the compositor (with a freshly-exported dmabuf sync_file)
    // so the compositor reads the current pixels, not a stale snapshot.
    //
    // Without re-attaching, just commit() on its own does NOT trigger
    // wl_surface_apply_state. We need to keep attach+damage+commit (the
    // protocol does require an attach to count as a new buffer commit).
    for (int i = 0; i < recommits; ++i) {
        wl_surface_attach(surface, buf, 0, 0);
        wl_surface_damage(surface, 0, 0, W, H);
        wl_surface_commit(surface);
        wl_display_roundtrip(display);
        usleep(25 * 1000);
    }
    printf("[recommit] committed same buffer %d times, releases=%d\n",
           recommits, releases_received);
    fflush(stdout);
    // Give the harness time to capture the final state.
    usleep(200 * 1000);

    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(buf);
    wl_surface_destroy(surface);
    gbm_bo_destroy(bo);
    gbm_device_destroy(gbm);
    close(drm);
    zwp_linux_dmabuf_v1_destroy(dmabuf);
    xdg_wm_base_destroy(wm_base);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    return surface_configured ? 0 : 1;
}
