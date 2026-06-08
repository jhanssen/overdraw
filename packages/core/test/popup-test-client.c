// xdg_popup test client: map a parent toplevel (solid color), then create a
// popup via xdg_positioner (anchor rect + anchor/gravity) of a different solid
// color, ack its configure, and commit a buffer to it. The compositor positions
// the popup relative to the parent; the harness reads back the composited frame
// and verifies the popup pixels appear at the expected position. Holds until
// SIGTERM. Prints the popup's configured position.
//
// Usage: popup-test-client --socket NAME [--parent WxH] [--popup WxH]
//        [--anchor-rect X,Y,W,H] [--parent-color AARRGGBB] [--popup-color AARRGGBB]

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

#define XDG_POSITIONER_ANCHOR_BOTTOM_LEFT 6
#define XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT 8

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct wl_subcompositor* subcompositor = NULL;
static struct xdg_wm_base* wm_base = NULL;
static volatile sig_atomic_t running = 1;
static int parent_configured = 0, popup_configured = 0;
static int popup_x = -1, popup_y = -1, popup_cfg_w = 0, popup_cfg_h = 0;

static void onTerm(int sig) { (void)sig; running = 0; }
static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wmListener = { wmPing };
static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) { (void)d;(void)t;(void)w;(void)h;(void)s; }
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; running = 0; }
static void tlBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlBounds, tlCaps };

static struct xdg_surface* parent_xs = NULL;
static struct xdg_surface* popup_xs = NULL;
static void xsParentConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; parent_configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsParentListener = { xsParentConfigure };
static void xsPopupConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; popup_configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsPopupListener = { xsPopupConfigure };

static void popupConfigure(void* d, struct xdg_popup* p, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)d;(void)p; popup_x = x; popup_y = y; popup_cfg_w = w; popup_cfg_h = h;
}
static void popupDone(void* d, struct xdg_popup* p) { (void)d;(void)p; running = 0; }
static void popupRepositioned(void* d, struct xdg_popup* p, uint32_t t) { (void)d;(void)p;(void)t; }
static const struct xdg_popup_listener popupListener = { popupConfigure, popupDone, popupRepositioned };

static void shmFormat(void* d, struct wl_shm* s, uint32_t fmt) { (void)d;(void)s;(void)fmt; }
static const struct wl_shm_listener shmListener = { shmFormat };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name, const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_compositor") == 0) compositor = wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "wl_subcompositor") == 0) subcompositor = wl_registry_bind(reg, name, &wl_subcompositor_interface, 1);
    else if (strcmp(iface, "wl_shm") == 0) { shm = wl_registry_bind(reg, name, &wl_shm_interface, 1); wl_shm_add_listener(shm, &shmListener, NULL); }
    else if (strcmp(iface, "xdg_wm_base") == 0) { wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5); xdg_wm_base_add_listener(wm_base, &wmListener, NULL); }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

static struct wl_buffer* solid(int W, int H, uint32_t color) {
    int stride = W * 4; size_t sz = (size_t)stride * H;
    int fd = memfd_create("popup", 0);
    if (fd < 0 || ftruncate(fd, sz) != 0) return NULL;
    uint32_t* px = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) return NULL;
    for (int i = 0; i < W * H; ++i) px[i] = color;
    munmap(px, sz);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, sz);
    struct wl_buffer* b = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool); close(fd);
    return b;
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    int PW = 300, PH = 200, UW = 80, UH = 60;
    int arx = 10, ary = 180, arw = 20, arh = 20;
    uint32_t pColor = 0xFF0000FFu, uColor = 0xFF00FF00u, subColor = 0xFFFF00FFu;
    int subW = 0, subH = 0, subX = 0, subY = 0;  // popup subsurface (0 = none)
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--parent") == 0 && i + 1 < argc) sscanf(argv[++i], "%dx%d", &PW, &PH);
        else if (strcmp(argv[i], "--popup") == 0 && i + 1 < argc) sscanf(argv[++i], "%dx%d", &UW, &UH);
        else if (strcmp(argv[i], "--anchor-rect") == 0 && i + 1 < argc) sscanf(argv[++i], "%d,%d,%d,%d", &arx, &ary, &arw, &arh);
        else if (strcmp(argv[i], "--parent-color") == 0 && i + 1 < argc) pColor = (uint32_t)strtoul(argv[++i], NULL, 16);
        else if (strcmp(argv[i], "--popup-color") == 0 && i + 1 < argc) uColor = (uint32_t)strtoul(argv[++i], NULL, 16);
        else if (strcmp(argv[i], "--popup-sub") == 0 && i + 1 < argc) sscanf(argv[++i], "%dx%d", &subW, &subH);
        else if (strcmp(argv[i], "--popup-sub-offset") == 0 && i + 1 < argc) sscanf(argv[++i], "%d,%d", &subX, &subY);
        else if (strcmp(argv[i], "--popup-sub-color") == 0 && i + 1 < argc) subColor = (uint32_t)strtoul(argv[++i], NULL, 16);
    }
    if (!socket) { fprintf(stderr, "usage: %s --socket NAME [...]\n", argv[0]); return 2; }

    signal(SIGTERM, onTerm); signal(SIGINT, onTerm);
    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[popup-client] connect failed\n"); return 1; }
    struct wl_registry* reg = wl_display_get_registry(display);
    wl_registry_add_listener(reg, &regListener, NULL);
    wl_display_roundtrip(display); wl_display_roundtrip(display);
    if (!compositor || !shm || !wm_base) { fprintf(stderr, "[popup-client] missing globals\n"); return 1; }

    // Parent toplevel.
    struct wl_buffer* pbuf = solid(PW, PH, pColor);
    struct wl_surface* parent = wl_compositor_create_surface(compositor);
    parent_xs = xdg_wm_base_get_xdg_surface(wm_base, parent);
    xdg_surface_add_listener(parent_xs, &xsParentListener, NULL);
    struct xdg_toplevel* tl = xdg_surface_get_toplevel(parent_xs);
    xdg_toplevel_add_listener(tl, &tlListener, NULL);
    xdg_toplevel_set_title(tl, "popup-parent");
    wl_surface_commit(parent);
    wl_display_roundtrip(display);
    wl_surface_attach(parent, pbuf, 0, 0);
    wl_surface_damage(parent, 0, 0, PW, PH);
    wl_surface_commit(parent);
    wl_display_roundtrip(display); wl_display_roundtrip(display);
    printf("[popup-client] parent mapped %dx%d\n", PW, PH);
    fflush(stdout);

    // Popup via positioner.
    struct xdg_positioner* posr = xdg_wm_base_create_positioner(wm_base);
    xdg_positioner_set_size(posr, UW, UH);
    xdg_positioner_set_anchor_rect(posr, arx, ary, arw, arh);
    xdg_positioner_set_anchor(posr, XDG_POSITIONER_ANCHOR_BOTTOM_LEFT);
    xdg_positioner_set_gravity(posr, XDG_POSITIONER_GRAVITY_BOTTOM_RIGHT);

    struct wl_surface* popup = wl_compositor_create_surface(compositor);
    popup_xs = xdg_wm_base_get_xdg_surface(wm_base, popup);
    xdg_surface_add_listener(popup_xs, &xsPopupListener, NULL);
    struct xdg_popup* pop = xdg_surface_get_popup(popup_xs, parent_xs, posr);
    xdg_popup_add_listener(pop, &popupListener, NULL);
    xdg_positioner_destroy(posr);
    wl_surface_commit(popup);          // initial: triggers popup configure
    wl_display_roundtrip(display);

    struct wl_buffer* ubuf = solid(UW, UH, uColor);
    wl_surface_attach(popup, ubuf, 0, 0);
    wl_surface_damage(popup, 0, 0, UW, UH);

    // Optional: a subsurface ON THE POPUP (popups are wl_surfaces and may parent
    // subsurfaces). Commit it desync so it applies immediately, then the popup.
    if (subW > 0 && subH > 0 && subcompositor) {
        struct wl_buffer* sbuf = solid(subW, subH, subColor);
        struct wl_surface* sub = wl_compositor_create_surface(compositor);
        struct wl_subsurface* ss = wl_subcompositor_get_subsurface(subcompositor, sub, popup);
        wl_subsurface_set_position(ss, subX, subY);
        wl_subsurface_set_desync(ss);
        wl_surface_attach(sub, sbuf, 0, 0);
        wl_surface_damage(sub, 0, 0, subW, subH);
        wl_surface_commit(sub);
    }

    wl_surface_commit(popup);
    wl_display_roundtrip(display); wl_display_roundtrip(display);

    printf("[popup-client] popup configured at %d,%d size %dx%d\n", popup_x, popup_y, popup_cfg_w, popup_cfg_h);
    fflush(stdout);

    int wlfd = wl_display_get_fd(display);
    while (running) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd pfd = { wlfd, POLLIN, 0 };
        if (poll(&pfd, 1, 10) > 0 && (pfd.revents & POLLIN)) if (wl_display_dispatch(display) < 0) break;
    }
    wl_display_disconnect(display);
    return (parent_configured && popup_configured) ? 0 : 1;
}
