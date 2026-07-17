// Pointer-lock + relative-motion test client.
//
// Maps a small xdg_toplevel, creates a zwp_relative_pointer_v1 for its
// wl_pointer, and locks the pointer (zwp_pointer_constraints_v1, persistent,
// no region) on the first pointer enter. Prints one line per pointer event so
// the harness can assert on delivery and frame grouping:
//
//   [lock-client] mapped
//   [lock-client] enter
//   [lock-client] locked            (zwp_locked_pointer_v1.locked)
//   [lock-client] motion x=.. y=..  (absolute wl_pointer.motion)
//   [lock-client] rel dx=.. dy=.. dxu=.. dyu=..
//   [lock-client] frame
//
// Usage:
//   --socket NAME      compositor socket
//   --timeout-ms N     exit 0 after N ms (default 10000)

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "pointer-constraints-unstable-v1-client-protocol.h"
#include "relative-pointer-unstable-v1-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wl_seat* seat = NULL;
static struct zwp_pointer_constraints_v1* constraints = NULL;
static struct zwp_relative_pointer_manager_v1* rel_mgr = NULL;

static volatile sig_atomic_t running = 1;
static void onTerm(int sig) { (void)sig; running = 0; }

static int g_timeoutMs = 10000;

static struct wl_surface* surface = NULL;
static struct xdg_surface* xs = NULL;
static struct xdg_toplevel* tl = NULL;
static struct wl_pointer* pointer = NULL;
static struct zwp_relative_pointer_v1* rel = NULL;
static struct zwp_locked_pointer_v1* locked = NULL;
static int configured = 0;

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t s) { (void)d; xdg_wm_base_pong(b, s); }
static const struct xdg_wm_base_listener wmListener = { wmPing };
static void xsConfigure(void* d, struct xdg_surface* x, uint32_t serial) {
    (void)d; configured = 1; xdg_surface_ack_configure(x, serial);
}
static const struct xdg_surface_listener xsListener = { xsConfigure };
static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) {
    (void)d;(void)t;(void)w;(void)h;(void)s;
}
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; running = 0; }
static void tlBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlBounds, tlCaps };

static void lockLocked(void* d, struct zwp_locked_pointer_v1* lp) {
    (void)d;(void)lp;
    printf("[lock-client] locked\n");
    fflush(stdout);
}
static void lockUnlocked(void* d, struct zwp_locked_pointer_v1* lp) {
    (void)d;(void)lp;
    printf("[lock-client] unlocked\n");
    fflush(stdout);
}
static const struct zwp_locked_pointer_v1_listener lockListener = { lockLocked, lockUnlocked };

static void relMotion(void* d, struct zwp_relative_pointer_v1* rp,
                      uint32_t hi, uint32_t lo,
                      wl_fixed_t dx, wl_fixed_t dy,
                      wl_fixed_t dxu, wl_fixed_t dyu) {
    (void)d;(void)rp;(void)hi;(void)lo;
    printf("[lock-client] rel dx=%.2f dy=%.2f dxu=%.2f dyu=%.2f\n",
           wl_fixed_to_double(dx), wl_fixed_to_double(dy),
           wl_fixed_to_double(dxu), wl_fixed_to_double(dyu));
    fflush(stdout);
}
static const struct zwp_relative_pointer_v1_listener relListener = { relMotion };

static void ptrEnter(void* d, struct wl_pointer* p, uint32_t serial,
                     struct wl_surface* s, wl_fixed_t sx, wl_fixed_t sy) {
    (void)d;(void)serial;(void)sx;(void)sy;
    printf("[lock-client] enter\n");
    fflush(stdout);
    // Lock on the first enter (games lock when capture starts). Persistent:
    // survives focus round-trips.
    if (!locked && constraints && s == surface) {
        locked = zwp_pointer_constraints_v1_lock_pointer(
            constraints, surface, p, NULL,
            ZWP_POINTER_CONSTRAINTS_V1_LIFETIME_PERSISTENT);
        zwp_locked_pointer_v1_add_listener(locked, &lockListener, NULL);
    }
}
static void ptrLeave(void* d, struct wl_pointer* p, uint32_t serial, struct wl_surface* s) {
    (void)d;(void)p;(void)serial;(void)s;
    printf("[lock-client] leave\n");
    fflush(stdout);
}
static void ptrMotion(void* d, struct wl_pointer* p, uint32_t t, wl_fixed_t sx, wl_fixed_t sy) {
    (void)d;(void)p;(void)t;
    printf("[lock-client] motion x=%.1f y=%.1f\n",
           wl_fixed_to_double(sx), wl_fixed_to_double(sy));
    fflush(stdout);
}
static void ptrButton(void* d, struct wl_pointer* p, uint32_t serial, uint32_t t,
                      uint32_t button, uint32_t state) {
    (void)d;(void)p;(void)serial;(void)t;(void)button;(void)state;
}
static void ptrAxis(void* d, struct wl_pointer* p, uint32_t t, uint32_t axis, wl_fixed_t v) {
    (void)d;(void)p;(void)t;(void)axis;(void)v;
}
static void ptrFrame(void* d, struct wl_pointer* p) {
    (void)d;(void)p;
    printf("[lock-client] frame\n");
    fflush(stdout);
}
static void ptrAxisSource(void* d, struct wl_pointer* p, uint32_t s) { (void)d;(void)p;(void)s; }
static void ptrAxisStop(void* d, struct wl_pointer* p, uint32_t t, uint32_t a) { (void)d;(void)p;(void)t;(void)a; }
static void ptrAxisDiscrete(void* d, struct wl_pointer* p, uint32_t a, int32_t v) { (void)d;(void)p;(void)a;(void)v; }
static const struct wl_pointer_listener ptrListener = {
    ptrEnter, ptrLeave, ptrMotion, ptrButton, ptrAxis, ptrFrame,
    ptrAxisSource, ptrAxisStop, ptrAxisDiscrete,
};

static void seatCaps(void* d, struct wl_seat* s, uint32_t caps) {
    (void)d;
    if ((caps & WL_SEAT_CAPABILITY_POINTER) && !pointer) {
        pointer = wl_seat_get_pointer(s);
        wl_pointer_add_listener(pointer, &ptrListener, NULL);
        if (rel_mgr && !rel) {
            rel = zwp_relative_pointer_manager_v1_get_relative_pointer(rel_mgr, pointer);
            zwp_relative_pointer_v1_add_listener(rel, &relListener, NULL);
        }
    }
}
static void seatName(void* d, struct wl_seat* s, const char* n) { (void)d;(void)s;(void)n; }
static const struct wl_seat_listener seatListener = { seatCaps, seatName };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_compositor") == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "wl_shm") == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    } else if (strcmp(iface, "wl_seat") == 0) {
        seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
        wl_seat_add_listener(seat, &seatListener, NULL);
    } else if (strcmp(iface, "zwp_pointer_constraints_v1") == 0) {
        constraints = wl_registry_bind(reg, name, &zwp_pointer_constraints_v1_interface, 1);
    } else if (strcmp(iface, "zwp_relative_pointer_manager_v1") == 0) {
        rel_mgr = wl_registry_bind(reg, name, &zwp_relative_pointer_manager_v1_interface, 1);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) {
    (void)data; (void)reg; (void)name;
}
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    const char* socket = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) g_timeoutMs = atoi(argv[++i]);
    }
    if (!socket) {
        fprintf(stderr, "usage: %s --socket NAME [--timeout-ms N]\n", argv[0]);
        return 2;
    }
    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[lock-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);   // seat caps + late globals
    if (!compositor || !shm || !wm_base || !seat || !constraints || !rel_mgr) {
        fprintf(stderr, "[lock-client] missing globals (constraints=%p rel_mgr=%p)\n",
                (void*)constraints, (void*)rel_mgr);
        return 1;
    }

    const int W = 64, H = 64, stride = W * 4;
    int fd = memfd_create("lock", 0);
    if (fd < 0 || ftruncate(fd, (off_t)stride * H) != 0) return 1;
    uint32_t* px = mmap(NULL, (size_t)stride * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) return 1;
    for (int i = 0; i < W * H; ++i) px[i] = 0xFF00FF00u;
    munmap(px, (size_t)stride * H);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, (int)stride * H);
    struct wl_buffer* buffer = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
    surface = wl_compositor_create_surface(compositor);
    xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    tl = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(tl, &tlListener, NULL);
    xdg_toplevel_set_title(tl, "lock-client");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    while (!configured) wl_display_dispatch(display);
    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    printf("[lock-client] mapped\n");
    fflush(stdout);

    int wlfd = wl_display_get_fd(display);
    long elapsedMs = 0;
    while (running && elapsedMs < g_timeoutMs) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd p = { wlfd, POLLIN, 0 };
        if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
        elapsedMs += 16;
    }
    wl_display_disconnect(display);
    return 0;
}
