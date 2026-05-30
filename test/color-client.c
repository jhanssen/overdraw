// A long-lived solid-color shm Wayland client for eyeballing compositing.
// Maps an xdg_toplevel filled with a solid color and stays alive until killed
// (SIGTERM/SIGINT), so multiple instances can be placed and viewed at once.
//
// Usage: color-client <socket> <argb-hex> [w] [h] [title]
//   e.g. color-client wayland-0 FF0000FF 300 300 red

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <signal.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wl_seat* seat = NULL;
static struct wl_pointer* pointer = NULL;
static struct wl_keyboard* keyboard = NULL;
static const char* g_title = "color";
static int configured = 0;
static volatile sig_atomic_t running = 1;

static void onSig(int s) { (void)s; running = 0; }

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) {
    (void)d; xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) {
    (void)d;(void)t;(void)w;(void)h;(void)s;
}
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; running = 0; }
static void tlConfigureBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlWmCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlConfigureBounds, tlWmCaps };

static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) {
    (void)d; configured = 1; xdg_surface_ack_configure(xs, serial);
}
static const struct xdg_surface_listener xsListener = { xsConfigure };

static void shmFormat(void* d, struct wl_shm* s, uint32_t fmt) { (void)d;(void)s;(void)fmt; }
static const struct wl_shm_listener shmListener = { shmFormat };

// Pointer listener: log events so input routing is verifiable.
static void ptEnter(void* d, struct wl_pointer* p, uint32_t serial, struct wl_surface* s,
                    wl_fixed_t x, wl_fixed_t y) {
    (void)d;(void)p;(void)serial;(void)s;
    printf("[client %s] pointer ENTER at %.1f,%.1f\n", g_title,
           wl_fixed_to_double(x), wl_fixed_to_double(y));
}
static void ptLeave(void* d, struct wl_pointer* p, uint32_t serial, struct wl_surface* s) {
    (void)d;(void)p;(void)serial;(void)s;
    printf("[client %s] pointer LEAVE\n", g_title);
}
static void ptMotion(void* d, struct wl_pointer* p, uint32_t t, wl_fixed_t x, wl_fixed_t y) {
    (void)d;(void)p;(void)t;
    printf("[client %s] pointer MOTION %.1f,%.1f\n", g_title,
           wl_fixed_to_double(x), wl_fixed_to_double(y));
}
static void ptButton(void* d, struct wl_pointer* p, uint32_t serial, uint32_t t,
                     uint32_t button, uint32_t state) {
    (void)d;(void)p;(void)serial;(void)t;
    printf("[client %s] pointer BUTTON %u %s\n", g_title, button, state ? "press" : "release");
}
static void ptAxis(void* d, struct wl_pointer* p, uint32_t t, uint32_t axis, wl_fixed_t v) {
    (void)d;(void)p;(void)t;
    printf("[client %s] pointer AXIS %u %.1f\n", g_title, axis, wl_fixed_to_double(v));
}
static void ptFrame(void* d, struct wl_pointer* p) { (void)d;(void)p; }
static void ptAxisSrc(void* d, struct wl_pointer* p, uint32_t s) { (void)d;(void)p;(void)s; }
static void ptAxisStop(void* d, struct wl_pointer* p, uint32_t t, uint32_t a) { (void)d;(void)p;(void)t;(void)a; }
static void ptAxisDisc(void* d, struct wl_pointer* p, uint32_t a, int32_t disc) { (void)d;(void)p;(void)a;(void)disc; }
static void ptAxisV120(void* d, struct wl_pointer* p, uint32_t a, int32_t v) { (void)d;(void)p;(void)a;(void)v; }
static void ptAxisDir(void* d, struct wl_pointer* p, uint32_t a, uint32_t dir) { (void)d;(void)p;(void)a;(void)dir; }
static const struct wl_pointer_listener ptListener = {
    ptEnter, ptLeave, ptMotion, ptButton, ptAxis, ptFrame,
    ptAxisSrc, ptAxisStop, ptAxisDisc, ptAxisV120, ptAxisDir,
};

// Keyboard listener: log keymap + key/modifier events.
static void kbKeymap(void* d, struct wl_keyboard* k, uint32_t format, int32_t fd, uint32_t size) {
    (void)d;(void)k;
    printf("[client %s] keyboard KEYMAP format=%u fd=%d size=%u\n", g_title, format, fd, size);
    if (fd >= 0) {
        // Map it to prove the fd is real + readable (xkb_v1 text starts with "xkb").
        void* m = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
        if (m != MAP_FAILED) {
            printf("[client %s] keymap first bytes: %.16s\n", g_title, (const char*)m);
            munmap(m, size);
        }
        close(fd);
    }
}
static void kbEnter(void* d, struct wl_keyboard* k, uint32_t serial, struct wl_surface* s, struct wl_array* keys) {
    (void)d;(void)k;(void)serial;(void)s;(void)keys;
    printf("[client %s] keyboard ENTER\n", g_title);
}
static void kbLeave(void* d, struct wl_keyboard* k, uint32_t serial, struct wl_surface* s) {
    (void)d;(void)k;(void)serial;(void)s;
    printf("[client %s] keyboard LEAVE\n", g_title);
}
static void kbKey(void* d, struct wl_keyboard* k, uint32_t serial, uint32_t time, uint32_t key, uint32_t state) {
    (void)d;(void)k;(void)serial;(void)time;
    printf("[client %s] keyboard KEY %u %s\n", g_title, key, state ? "press" : "release");
}
static void kbMods(void* d, struct wl_keyboard* k, uint32_t serial, uint32_t dep, uint32_t lat, uint32_t lock, uint32_t grp) {
    (void)d;(void)k;(void)serial;
    printf("[client %s] keyboard MODS dep=%u lat=%u lock=%u grp=%u\n", g_title, dep, lat, lock, grp);
}
static void kbRepeat(void* d, struct wl_keyboard* k, int32_t rate, int32_t delay) {
    (void)d;(void)k;(void)rate;(void)delay;
}
static const struct wl_keyboard_listener kbListener = {
    kbKeymap, kbEnter, kbLeave, kbKey, kbMods, kbRepeat,
};

static void seatCaps(void* d, struct wl_seat* s, uint32_t caps) {
    (void)d;
    if ((caps & WL_SEAT_CAPABILITY_POINTER) && !pointer) {
        pointer = wl_seat_get_pointer(s);
        wl_pointer_add_listener(pointer, &ptListener, NULL);
    }
    if ((caps & WL_SEAT_CAPABILITY_KEYBOARD) && !keyboard) {
        keyboard = wl_seat_get_keyboard(s);
        wl_keyboard_add_listener(keyboard, &kbListener, NULL);
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
    if (argc < 3) { fprintf(stderr, "usage: %s <socket> <argb-hex> [w] [h] [title]\n", argv[0]); return 2; }
    const char* sock = argv[1];
    uint32_t pixel = (uint32_t)strtoul(argv[2], NULL, 16);
    int W = (argc > 3) ? atoi(argv[3]) : 300;
    int H = (argc > 4) ? atoi(argv[4]) : 300;
    const char* title = (argc > 5) ? argv[5] : "color";
    g_title = title;
    int stride = W * 4, poolSize = stride * H;

    signal(SIGTERM, onSig);
    signal(SIGINT, onSig);

    struct wl_display* display = wl_display_connect(sock);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
    if (!compositor || !shm || !wm_base) { fprintf(stderr, "[client] missing globals\n"); return 1; }

    int fd = memfd_create("overdraw-color", 0);
    if (fd < 0 || ftruncate(fd, poolSize) != 0) { perror("memfd"); return 1; }
    uint32_t* px = mmap(NULL, poolSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); return 1; }
    for (int i = 0; i < W * H; ++i) px[i] = pixel;
    munmap(px, poolSize);

    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, poolSize);
    struct wl_buffer* buffer = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, title);

    wl_surface_commit(surface);
    wl_display_roundtrip(display);

    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    wl_display_roundtrip(display);

    printf("[client] %s mapped %dx%d pixel=%08X (configured=%d) -- ctrl-c to quit\n",
           title, W, H, pixel, configured);

    // Stay alive, dispatching events (pings, close) until signaled.
    while (running && wl_display_dispatch(display) != -1) {}

    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(buffer);
    wl_shm_pool_destroy(pool);
    wl_surface_destroy(surface);
    close(fd);
    wl_display_disconnect(display);
    printf("[client] %s done\n", title);
    return 0;
}
