// Subsurface test client: map a parent xdg_toplevel (solid color), then create a
// child wl_surface, make it a wl_subsurface of the parent at a given offset,
// fill it a different solid color, and commit. Holds until SIGTERM so the
// harness can read back the composited frame and verify the child appears at
// parent + offset (above the parent), and the parent shows elsewhere.
//
// Usage: subsurface-test-client --socket NAME [--parent WxH] [--child WxH]
//        [--offset XxY] [--parent-color AARRGGBB] [--child-color AARRGGBB]

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <signal.h>
#include <poll.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct wl_subcompositor* subcompositor = NULL;
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
    } else if (strcmp(iface, "wl_subcompositor") == 0) {
        subcompositor = wl_registry_bind(reg, name, &wl_subcompositor_interface, 1);
    } else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

// Allocate a wl_buffer of WxH filled with a solid ARGB color.
static struct wl_buffer* solidBuffer(int W, int H, uint32_t color, uint32_t fmt) {
    int stride = W * 4;
    size_t sz = (size_t)stride * H;
    int fd = memfd_create("overdraw-subsurf", 0);
    if (fd < 0 || ftruncate(fd, sz) != 0) { perror("memfd"); return NULL; }
    uint32_t* px = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); return NULL; }
    for (int i = 0; i < W * H; ++i) px[i] = color;
    munmap(px, sz);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, sz);
    struct wl_buffer* b = wl_shm_pool_create_buffer(pool, 0, W, H, stride, fmt);
    wl_shm_pool_destroy(pool);
    close(fd);
    return b;
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    int PW = 300, PH = 200, CW = 80, CH = 60, OX = 40, OY = 30;
    uint32_t pColor = 0xFF0000FFu;  // parent: opaque blue
    uint32_t cColor = 0xFF00FF00u;  // child: opaque green
    int sync = 0;   // --sync: subsurface stays in synchronized mode (default desync here)
    int step = 0;   // --step: gate the parent commit on a stdin line (timing test)
    int child_xrgb = 0;  // --child-xrgb: commit the CHILD as XRGB8888 (opaque format,
                         // don't-care alpha byte) instead of ARGB8888

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--parent") == 0 && i + 1 < argc) sscanf(argv[++i], "%dx%d", &PW, &PH);
        else if (strcmp(argv[i], "--child") == 0 && i + 1 < argc) sscanf(argv[++i], "%dx%d", &CW, &CH);
        else if (strcmp(argv[i], "--offset") == 0 && i + 1 < argc) sscanf(argv[++i], "%dx%d", &OX, &OY);
        else if (strcmp(argv[i], "--parent-color") == 0 && i + 1 < argc) pColor = (uint32_t)strtoul(argv[++i], NULL, 16);
        else if (strcmp(argv[i], "--child-color") == 0 && i + 1 < argc) cColor = (uint32_t)strtoul(argv[++i], NULL, 16);
        else if (strcmp(argv[i], "--sync") == 0) sync = 1;
        else if (strcmp(argv[i], "--step") == 0) step = 1;
        else if (strcmp(argv[i], "--child-xrgb") == 0) child_xrgb = 1;
    }
    if (!socket) { fprintf(stderr, "usage: %s --socket NAME [--sync] [--step] [...]\n", argv[0]); return 2; }

    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[subsurface-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    if (!compositor || !shm || !subcompositor || !wm_base) {
        fprintf(stderr, "[subsurface-client] missing globals (compositor=%p shm=%p subcompositor=%p wm=%p)\n",
                (void*)compositor, (void*)shm, (void*)subcompositor, (void*)wm_base);
        return 1;
    }

    // Parent toplevel.
    struct wl_buffer* pbuf = solidBuffer(PW, PH, pColor, WL_SHM_FORMAT_ARGB8888);
    struct wl_surface* parent = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, parent);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "subsurface-test");
    wl_surface_commit(parent);          // map: triggers configure
    wl_display_roundtrip(display);

    // In --step mode, map the parent FIRST (its own buffer) so the harness sees a
    // mapped window before the child exists, then drive child/parent commits in
    // discrete, stdout-announced steps so the harness can read back between them.
    if (step) {
        wl_surface_attach(parent, pbuf, 0, 0);
        wl_surface_damage(parent, 0, 0, PW, PH);
        wl_surface_commit(parent);
        wl_display_roundtrip(display);
        printf("[subsurface-client] mapped parent %dx%d child %dx%d offset %dx%d configured=%d\n",
               PW, PH, CW, CH, OX, OY, surface_configured);
        fflush(stdout);

        // Set up the child subsurface and commit ITS buffer. In sync mode this is
        // cached and must NOT appear until the parent commits next.
        struct wl_buffer* cbuf = solidBuffer(CW, CH, cColor, child_xrgb ? WL_SHM_FORMAT_XRGB8888 : WL_SHM_FORMAT_ARGB8888);
        struct wl_surface* child = wl_compositor_create_surface(compositor);
        struct wl_subsurface* sub = wl_subcompositor_get_subsurface(subcompositor, child, parent);
        wl_subsurface_set_position(sub, OX, OY);
        if (sync) wl_subsurface_set_sync(sub); else wl_subsurface_set_desync(sub);
        wl_surface_attach(child, cbuf, 0, 0);
        wl_surface_damage(child, 0, 0, CW, CH);
        wl_surface_commit(child);
        wl_display_roundtrip(display);
        printf("[subsurface-client] child-committed\n");
        fflush(stdout);

        // Wait for the harness to tell us to commit the parent (it reads back the
        // frame first to confirm a sync child has NOT yet appeared).
        char line[64];
        while (running && !fgets(line, sizeof(line), stdin)) { /* retry on EINTR */ }
        wl_surface_commit(parent);          // applies cached sync child state
        wl_display_roundtrip(display);
        printf("[subsurface-client] parent-committed\n");
        fflush(stdout);
    } else {
        // One-shot path (desync default): child + parent committed together.
        struct wl_buffer* cbuf = solidBuffer(CW, CH, cColor, child_xrgb ? WL_SHM_FORMAT_XRGB8888 : WL_SHM_FORMAT_ARGB8888);
        struct wl_surface* child = wl_compositor_create_surface(compositor);
        struct wl_subsurface* sub = wl_subcompositor_get_subsurface(subcompositor, child, parent);
        wl_subsurface_set_position(sub, OX, OY);
        if (sync) wl_subsurface_set_sync(sub); else wl_subsurface_set_desync(sub);
        wl_surface_attach(child, cbuf, 0, 0);
        wl_surface_damage(child, 0, 0, CW, CH);
        wl_surface_commit(child);

        wl_surface_attach(parent, pbuf, 0, 0);
        wl_surface_damage(parent, 0, 0, PW, PH);
        wl_surface_commit(parent);
        wl_display_roundtrip(display);
        wl_display_roundtrip(display);

        printf("[subsurface-client] mapped parent %dx%d child %dx%d offset %dx%d configured=%d\n",
               PW, PH, CW, CH, OX, OY, surface_configured);
        fflush(stdout);
    }

    int wlfd = wl_display_get_fd(display);
    while (running) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd pfd = { wlfd, POLLIN, 0 };
        if (poll(&pfd, 1, 10) > 0 && (pfd.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
    }

    // Teardown: the surfaces/buffers are owned by the per-branch scopes above and
    // are reclaimed on exit; just flush + disconnect. (toplevel/xs/parent outlive
    // both branches but a clean exit lets the server drop the client.)
    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_surface_destroy(parent);
    wl_buffer_destroy(pbuf);
    wl_display_roundtrip(display);
    wl_display_disconnect(display);
    return 0;
}
