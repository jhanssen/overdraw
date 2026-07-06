// Cursor client exercising the libwayland-cursor theme-pool pattern: the
// shm pool is created sized for ONE image and grown with wl_shm_pool.resize
// as more images load, so the cursor buffer sits past the pool's creation
// size. GTK request ordering: set_cursor first, then attach/scale/damage/
// commit on a surface that never had a buffer before.
//
// stdout markers gate the harness readback:
//   "[client] mapped" / "[client] cursor_committed" / "[client] done"

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#define W 128
#define H 128
#define STRIDE (W * 4)
#define POOL_SIZE_TL (STRIDE * H)
#define CURSOR_W 16
#define CURSOR_H 16
#define CURSOR_STRIDE (CURSOR_W * 4)
#define POOL_SIZE_CURSOR (CURSOR_STRIDE * CURSOR_H)

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wl_seat* seat = NULL;
static struct wl_pointer* pointer = NULL;
static struct wl_surface* cursor_surface = NULL;
static uint32_t last_enter_serial = 0;
static int got_enter = 0;

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
    (void)d; xdg_surface_ack_configure(xs, serial);
}
static const struct xdg_surface_listener xsListener = { xsConfigure };

static void shmFormat(void* d, struct wl_shm* s, uint32_t fmt) { (void)d;(void)s;(void)fmt; }
static const struct wl_shm_listener shmListener = { shmFormat };

static void ptEnter(void* d, struct wl_pointer* p, uint32_t serial,
                    struct wl_surface* s, wl_fixed_t sx, wl_fixed_t sy) {
    (void)d;(void)p;(void)s;(void)sx;(void)sy;
    last_enter_serial = serial;
    got_enter = 1;
    printf("[client] pointer.enter serial=%u\n", serial); fflush(stdout);
}
static void ptLeave(void* d, struct wl_pointer* p, uint32_t serial, struct wl_surface* s) {
    (void)d;(void)p;(void)serial;(void)s;
}
static void ptMotion(void* d, struct wl_pointer* p, uint32_t time, wl_fixed_t sx, wl_fixed_t sy) {
    (void)d;(void)p;(void)time;(void)sx;(void)sy;
}
static void ptButton(void* d, struct wl_pointer* p, uint32_t serial, uint32_t time, uint32_t btn, uint32_t st) {
    (void)d;(void)p;(void)serial;(void)time;(void)btn;(void)st;
}
static void ptAxis(void* d, struct wl_pointer* p, uint32_t time, uint32_t axis, wl_fixed_t value) {
    (void)d;(void)p;(void)time;(void)axis;(void)value;
}
static void ptFrame(void* d, struct wl_pointer* p) { (void)d;(void)p; }
static void ptAxisSource(void* d, struct wl_pointer* p, uint32_t s) { (void)d;(void)p;(void)s; }
static void ptAxisStop(void* d, struct wl_pointer* p, uint32_t time, uint32_t axis) { (void)d;(void)p;(void)time;(void)axis; }
static void ptAxisDiscrete(void* d, struct wl_pointer* p, uint32_t axis, int32_t discrete) { (void)d;(void)p;(void)axis;(void)discrete; }
static void ptAxisValue120(void* d, struct wl_pointer* p, uint32_t axis, int32_t v) { (void)d;(void)p;(void)axis;(void)v; }
static void ptAxisRelDir(void* d, struct wl_pointer* p, uint32_t axis, uint32_t dir) { (void)d;(void)p;(void)axis;(void)dir; }
static const struct wl_pointer_listener ptListener = {
    ptEnter, ptLeave, ptMotion, ptButton, ptAxis, ptFrame, ptAxisSource,
    ptAxisStop, ptAxisDiscrete, ptAxisValue120, ptAxisRelDir
};

static void seatCaps(void* d, struct wl_seat* s, uint32_t caps) {
    (void)d;
    if ((caps & WL_SEAT_CAPABILITY_POINTER) && !pointer) {
        pointer = wl_seat_get_pointer(s);
        wl_pointer_add_listener(pointer, &ptListener, NULL);
    }
}
static void seatName(void* d, struct wl_seat* s, const char* n) { (void)d;(void)s;(void)n; }
static const struct wl_seat_listener seatListener = { seatCaps, seatName };

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
    } else if (strcmp(iface, "wl_seat") == 0) {
        seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
        wl_seat_add_listener(seat, &seatListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    const char* socket = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
    }
    if (!socket) { fprintf(stderr, "usage: %s --socket NAME\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    if (!compositor || !shm || !wm_base || !seat) {
        fprintf(stderr, "[client] missing globals\n");
        return 1;
    }

    int fdTl = memfd_create("cgo-tl", 0);
    if (fdTl < 0 || ftruncate(fdTl, POOL_SIZE_TL) != 0) { perror("memfd"); return 1; }
    uint32_t* pxTl = mmap(NULL, POOL_SIZE_TL, PROT_READ | PROT_WRITE, MAP_SHARED, fdTl, 0);
    for (int i = 0; i < W * H; ++i) pxTl[i] = 0xFFFF0000u;  // red
    munmap(pxTl, POOL_SIZE_TL);
    struct wl_shm_pool* poolTl = wl_shm_create_pool(shm, fdTl, POOL_SIZE_TL);
    struct wl_buffer* bufTl = wl_shm_pool_create_buffer(poolTl, 0, W, H, STRIDE, WL_SHM_FORMAT_ARGB8888);

    // Cursor theme pool, libwayland-cursor style: created with room for a
    // single image, then grown with ftruncate + wl_shm_pool.resize as more
    // images load. The image the cursor actually uses sits past the pool's
    // creation size, so the compositor must honor the resize on every
    // mapping that stages upload bytes.
    const int IMG = POOL_SIZE_CURSOR;            // one 16x16 image slot
    const int SLOTS = 4;
    int fdB = memfd_create("cursor-pool", 0);
    if (fdB < 0 || ftruncate(fdB, IMG) != 0) { perror("memfd"); return 1; }
    uint32_t* pxB = mmap(NULL, IMG, PROT_READ | PROT_WRITE, MAP_SHARED, fdB, 0);
    for (int i = 0; i < CURSOR_W * CURSOR_H; ++i) pxB[i] = 0x00000000u;
    munmap(pxB, IMG);
    struct wl_shm_pool* poolB = wl_shm_create_pool(shm, fdB, IMG);

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, "cursor-gtk-order");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);

    wl_surface_attach(surface, bufTl, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    // GTK creates the cursor surface up front but attaches nothing to it
    // until the pointer enters.
    cursor_surface = wl_compositor_create_surface(compositor);

    printf("[client] mapped\n"); fflush(stdout);

    for (int i = 0; i < 500 && !got_enter; ++i) {
        wl_display_roundtrip(display);
        usleep(10 * 1000);
    }
    if (!got_enter) {
        fprintf(stderr, "[client] never received pointer.enter\n");
        return 1;
    }

    // Grow the pool in two steps (like a theme loading images), write the
    // green image into slot 3 (offset 3*IMG -- past the creation size), and
    // use it as the cursor in GTK order: set_cursor first, then
    // attach/scale/damage/commit on the (previously bufferless) surface.
    if (ftruncate(fdB, IMG * 2) != 0) { perror("ftruncate"); return 1; }
    wl_shm_pool_resize(poolB, IMG * 2);
    if (ftruncate(fdB, IMG * SLOTS) != 0) { perror("ftruncate"); return 1; }
    uint32_t* pxB2 = mmap(NULL, IMG * SLOTS, PROT_READ | PROT_WRITE, MAP_SHARED, fdB, 0);
    for (int i = CURSOR_W * CURSOR_H; i < CURSOR_W * CURSOR_H * 3; ++i) pxB2[i] = 0x00000000u;
    for (int i = CURSOR_W * CURSOR_H * 3; i < CURSOR_W * CURSOR_H * 4; ++i) pxB2[i] = 0xFF00FF00u;
    munmap(pxB2, IMG * SLOTS);
    wl_shm_pool_resize(poolB, IMG * SLOTS);
    struct wl_buffer* bufB = wl_shm_pool_create_buffer(poolB, IMG * 3, CURSOR_W, CURSOR_H,
                                                       CURSOR_STRIDE, WL_SHM_FORMAT_ARGB8888);
    wl_pointer_set_cursor(pointer, last_enter_serial, cursor_surface, 0, 0);
    wl_surface_set_buffer_scale(cursor_surface, 1);
    wl_surface_attach(cursor_surface, bufB, 0, 0);
    wl_surface_damage(cursor_surface, 0, 0, CURSOR_W, CURSOR_H);
    wl_surface_commit(cursor_surface);
    wl_display_roundtrip(display);
    printf("[client] cursor_committed\n"); fflush(stdout);

    usleep(1500 * 1000);  // harness readback (expect green cursor)

    wl_surface_destroy(cursor_surface);
    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(bufTl);
    wl_shm_pool_destroy(poolTl);
    wl_buffer_destroy(bufB);
    wl_shm_pool_destroy(poolB);
    wl_surface_destroy(surface);
    if (pointer) wl_pointer_destroy(pointer);
    wl_seat_destroy(seat);
    xdg_wm_base_destroy(wm_base);
    wl_shm_destroy(shm);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    close(fdTl);
    close(fdB);
    printf("[client] done\n");
    return 0;
}
