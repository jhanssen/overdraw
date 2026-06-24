// wp_presentation feedback test client.
//
// Maps a small xdg_toplevel, requests presentation feedback on each of N
// commits, and prints a line for every received `presented` event. Exits 0
// after N feedbacks have arrived (or --timeout-ms elapses, which is a
// failure).
//
// Usage:
//   --socket NAME      compositor socket
//   --frames N         number of commits to drive (default 3)
//   --timeout-ms N     give up + return 1 if not enough feedbacks (default 5000)

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
#include "presentation-time-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wp_presentation* presentation = NULL;

static volatile sig_atomic_t running = 1;
static void onTerm(int sig) { (void)sig; running = 0; }

static int g_frames = 3;
static int g_timeoutMs = 5000;

static struct wl_surface* surface = NULL;
static struct xdg_surface* xs = NULL;
static struct xdg_toplevel* tl = NULL;
static int configured = 0;

static struct wl_buffer* buffer = NULL;

static int presented_count = 0;
static int discarded_count = 0;

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

static void clockId(void* d, struct wp_presentation* p, uint32_t cid) {
    (void)d; (void)p;
    printf("[wp-pres-client] clock_id=%u\n", cid);
    fflush(stdout);
}
static const struct wp_presentation_listener pListener = { clockId };

static void fbSyncOutput(void* d, struct wp_presentation_feedback* fb, struct wl_output* o) {
    (void)d;(void)fb;(void)o;
}
static void fbPresented(void* d, struct wp_presentation_feedback* fb,
                        uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec,
                        uint32_t refresh, uint32_t seq_hi, uint32_t seq_lo, uint32_t flags) {
    (void)d;
    presented_count++;
    printf("[wp-pres-client] presented tv_sec=%u:%u tv_nsec=%u refresh=%u seq=%u:%u flags=0x%x\n",
           tv_sec_hi, tv_sec_lo, tv_nsec, refresh, seq_hi, seq_lo, flags);
    fflush(stdout);
    wp_presentation_feedback_destroy(fb);
}
static void fbDiscarded(void* d, struct wp_presentation_feedback* fb) {
    (void)d;
    discarded_count++;
    printf("[wp-pres-client] discarded\n");
    fflush(stdout);
    wp_presentation_feedback_destroy(fb);
}
static const struct wp_presentation_feedback_listener fbListener = {
    fbSyncOutput, fbPresented, fbDiscarded,
};

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
    } else if (strcmp(iface, "wp_presentation") == 0) {
        presentation = wl_registry_bind(reg, name, &wp_presentation_interface, 1);
        wp_presentation_add_listener(presentation, &pListener, NULL);
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
        else if (strcmp(argv[i], "--frames") == 0 && i + 1 < argc) g_frames = atoi(argv[++i]);
        else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) g_timeoutMs = atoi(argv[++i]);
    }
    if (!socket) {
        fprintf(stderr, "usage: %s --socket NAME [--frames N] [--timeout-ms N]\n", argv[0]);
        return 2;
    }
    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[wp-pres-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
    if (!compositor || !shm || !wm_base || !presentation) {
        fprintf(stderr, "[wp-pres-client] missing globals\n");
        return 1;
    }

    const int W = 64, H = 64, stride = W * 4;
    int fd = memfd_create("pres", 0);
    if (fd < 0 || ftruncate(fd, (off_t)stride * H) != 0) return 1;
    uint32_t* px = mmap(NULL, (size_t)stride * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) return 1;
    for (int i = 0; i < W * H; ++i) px[i] = 0xFF112233u;
    munmap(px, (size_t)stride * H);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, (int)stride * H);
    buffer = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
    surface = wl_compositor_create_surface(compositor);
    xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    tl = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(tl, &tlListener, NULL);
    xdg_toplevel_set_title(tl, "wp-pres");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    while (!configured) wl_display_dispatch(display);
    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    // Queue a presentation_feedback for the upcoming commit.
    {
        struct wp_presentation_feedback* fb =
            wp_presentation_feedback(presentation, surface);
        wp_presentation_feedback_add_listener(fb, &fbListener, NULL);
    }
    wl_surface_commit(surface);
    printf("[wp-pres-client] mapped\n");
    fflush(stdout);

    // Drive N-1 additional frames, each requesting feedback. Pace strictly:
    // only post the next commit after the previous one has been presented.
    // wp_presentation discards superseded feedbacks (per spec), so posting
    // back-to-back loses every commit-in-flight at the next vblank.
    int posted = 1;
    int last_presented_count = 0;
    int wlfd = wl_display_get_fd(display);
    long elapsedMs = 0;
    while (running && presented_count < g_frames && elapsedMs < g_timeoutMs) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd p = { wlfd, POLLIN, 0 };
        if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
        elapsedMs += 16;
        // Post the next frame only after the previous one's feedback has
        // arrived (presented_count moved).
        if (posted < g_frames && presented_count > last_presented_count) {
            last_presented_count = presented_count;
            wl_surface_attach(surface, buffer, 0, 0);
            wl_surface_damage(surface, 0, 0, W, H);
            struct wp_presentation_feedback* fb =
                wp_presentation_feedback(presentation, surface);
            wp_presentation_feedback_add_listener(fb, &fbListener, NULL);
            wl_surface_commit(surface);
            posted++;
        }
    }

    int ok = presented_count >= g_frames;
    printf("[wp-pres-client] done presented=%d discarded=%d frames=%d ok=%d\n",
           presented_count, discarded_count, g_frames, ok);
    fflush(stdout);
    wl_display_disconnect(display);
    return ok ? 0 : 1;
}
