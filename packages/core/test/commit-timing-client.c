// commit-timing-v1 test client.
//
// Maps a small xdg_toplevel, then drives N timed commits: each sets a
// wp_commit_timer_v1 timestamp DELAY ms in the future (CLOCK_MONOTONIC, the
// wp_presentation clock advertised by the compositor), requests
// wp_presentation feedback on the same commit, and checks the presented
// timestamp is not earlier than the target -- i.e. the compositor actually
// held the commit instead of latching it at the next flip.
//
// Usage:
//   --socket NAME      compositor socket
//   --frames N         number of timed commits (default 3)
//   --delay-ms N       per-commit target delay from "now" (default 120)
//   --timeout-ms N     give up + exit 1 (default 8000)
//   --idle-latch       instead of the timed-frames loop: quiesce, post ONE
//                      timed commit carrying a wl_surface.frame callback,
//                      then only dispatch (no further requests) until the
//                      callback arrives. Proves the deferred latch renders
//                      by itself -- with nothing else waking the
//                      compositor, a latch that doesn't request a frame
//                      never flips and the callback never comes.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <time.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "presentation-time-client-protocol.h"
#include "commit-timing-v1-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wp_presentation* presentation = NULL;
static struct wp_commit_timing_manager_v1* timing_mgr = NULL;

static volatile sig_atomic_t running = 1;
static void onTerm(int sig) { (void)sig; running = 0; }

static int g_frames = 3;
static int g_delayMs = 120;
static int g_timeoutMs = 8000;
static int g_idleLatch = 0;

static struct wl_surface* surface = NULL;
static struct xdg_surface* xs = NULL;
static struct xdg_toplevel* tl = NULL;
static int configured = 0;

static int presented_count = 0;
static int discarded_count = 0;
static int early_count = 0;
static uint64_t target_ns = 0;

static uint64_t nowMonotonicNs(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
}

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
    printf("[commit-timing-client] clock_id=%u\n", cid);
    fflush(stdout);
}
static const struct wp_presentation_listener pListener = { clockId };

static void fbSyncOutput(void* d, struct wp_presentation_feedback* fb, struct wl_output* o) {
    (void)d;(void)fb;(void)o;
}
static void fbPresented(void* d, struct wp_presentation_feedback* fb,
                        uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec,
                        uint32_t refresh, uint32_t seq_hi, uint32_t seq_lo, uint32_t flags) {
    (void)d;(void)refresh;(void)seq_hi;(void)seq_lo;(void)flags;
    uint64_t sec = ((uint64_t)tv_sec_hi << 32) | tv_sec_lo;
    uint64_t actual_ns = sec * 1000000000ull + tv_nsec;
    long long delta = (long long)(actual_ns - target_ns);
    if (actual_ns < target_ns) early_count++;
    presented_count++;
    printf("[commit-timing-client] presented target=%llu actual=%llu delta_ns=%lld %s\n",
           (unsigned long long)target_ns, (unsigned long long)actual_ns, delta,
           actual_ns < target_ns ? "EARLY" : "ok");
    fflush(stdout);
    wp_presentation_feedback_destroy(fb);
}
static void fbDiscarded(void* d, struct wp_presentation_feedback* fb) {
    (void)d;
    discarded_count++;
    printf("[commit-timing-client] discarded\n");
    fflush(stdout);
    wp_presentation_feedback_destroy(fb);
}
static const struct wp_presentation_feedback_listener fbListener = {
    fbSyncOutput, fbPresented, fbDiscarded,
};

static int frame_done = 0;
static uint64_t frame_done_ns = 0;
static void frameDone(void* d, struct wl_callback* cb, uint32_t t) {
    (void)d; (void)t;
    frame_done = 1;
    frame_done_ns = nowMonotonicNs();
    wl_callback_destroy(cb);
}
static const struct wl_callback_listener frameListener = { frameDone };

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
    } else if (strcmp(iface, "wp_commit_timing_manager_v1") == 0) {
        timing_mgr = wl_registry_bind(reg, name, &wp_commit_timing_manager_v1_interface, 1);
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
        else if (strcmp(argv[i], "--delay-ms") == 0 && i + 1 < argc) g_delayMs = atoi(argv[++i]);
        else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) g_timeoutMs = atoi(argv[++i]);
        else if (strcmp(argv[i], "--idle-latch") == 0) g_idleLatch = 1;
    }
    if (!socket) {
        fprintf(stderr, "usage: %s --socket NAME [--frames N] [--delay-ms N] [--timeout-ms N]\n", argv[0]);
        return 2;
    }
    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[commit-timing-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
    if (!compositor || !shm || !wm_base || !presentation || !timing_mgr) {
        fprintf(stderr, "[commit-timing-client] missing globals (timing_mgr=%p)\n", (void*)timing_mgr);
        return 1;
    }

    const int W = 64, H = 64, stride = W * 4;
    int fd = memfd_create("commit-timing", 0);
    if (fd < 0 || ftruncate(fd, (off_t)stride * H) != 0) return 1;
    uint32_t* px = mmap(NULL, (size_t)stride * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) return 1;
    for (int i = 0; i < W * H; ++i) px[i] = 0xFF3355AAu;
    munmap(px, (size_t)stride * H);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, (int)stride * H);
    struct wl_buffer* buffer = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
    surface = wl_compositor_create_surface(compositor);
    struct wp_commit_timer_v1* timer =
        wp_commit_timing_manager_v1_get_timer(timing_mgr, surface);
    xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    tl = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(tl, &tlListener, NULL);
    xdg_toplevel_set_title(tl, "commit-timing");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    while (!configured) wl_display_dispatch(display);
    // Untimed mapping commit.
    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    printf("[commit-timing-client] mapped\n");
    fflush(stdout);

    int wlfd_early = wl_display_get_fd(display);
    if (g_idleLatch) {
        // Quiesce: dispatch-only for a while so the compositor's frame loop
        // goes fully idle (no damage from us, nothing pending).
        for (long q = 0; running && q < 400; q += 16) {
            wl_display_dispatch_pending(display);
            wl_display_flush(display);
            struct pollfd p = { wlfd_early, POLLIN, 0 };
            if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN))
                if (wl_display_dispatch(display) < 0) break;
        }
        // One timed commit carrying a frame callback...
        target_ns = nowMonotonicNs() + (uint64_t)g_delayMs * 1000000ull;
        uint64_t sec = target_ns / 1000000000ull;
        wp_commit_timer_v1_set_timestamp(timer,
            (uint32_t)(sec >> 32), (uint32_t)(sec & 0xffffffffu),
            (uint32_t)(target_ns % 1000000000ull));
        wl_surface_attach(surface, buffer, 0, 0);
        wl_surface_damage(surface, 0, 0, W, H);
        struct wl_callback* cb = wl_surface_frame(surface);
        wl_callback_add_listener(cb, &frameListener, NULL);
        wl_surface_commit(surface);
        wl_display_flush(display);
        printf("[commit-timing-client] idle-latch posted\n");
        fflush(stdout);
        // ...then ONLY dispatch. No further requests reach the compositor,
        // so the deferred latch must drive the render (and thus the flip
        // that delivers wl_callback.done) entirely by itself.
        for (long w2 = 0; running && !frame_done && w2 < g_timeoutMs; w2 += 16) {
            struct pollfd p = { wlfd_early, POLLIN, 0 };
            if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN))
                if (wl_display_dispatch(display) < 0) break;
        }
        long long after_ms = frame_done
            ? (long long)(frame_done_ns - target_ns) / 1000000ll : -1;
        int ok = frame_done && frame_done_ns + 2000000ull >= target_ns;
        printf("[commit-timing-client] idle-latch done=%d ms_after_target=%lld ok=%d\n",
               frame_done, after_ms, ok);
        fflush(stdout);
        wp_commit_timer_v1_destroy(timer);
        wl_display_disconnect(display);
        return ok ? 0 : 1;
    }

    // Drive N timed commits, strictly paced: post the next only after the
    // previous one's feedback arrived (so no feedback is superseded).
    int posted = 0;
    int handled = 0; /* presented + discarded consumed so far */
    int wlfd = wl_display_get_fd(display);
    long elapsedMs = 0;
    while (running && presented_count < g_frames && discarded_count == 0
           && elapsedMs < g_timeoutMs) {
        if (posted == handled && posted < g_frames) {
            target_ns = nowMonotonicNs() + (uint64_t)g_delayMs * 1000000ull;
            uint64_t sec = target_ns / 1000000000ull;
            uint32_t nsec = (uint32_t)(target_ns % 1000000000ull);
            wp_commit_timer_v1_set_timestamp(timer,
                (uint32_t)(sec >> 32), (uint32_t)(sec & 0xffffffffu), nsec);
            wl_surface_attach(surface, buffer, 0, 0);
            wl_surface_damage(surface, 0, 0, W, H);
            struct wp_presentation_feedback* fb =
                wp_presentation_feedback(presentation, surface);
            wp_presentation_feedback_add_listener(fb, &fbListener, NULL);
            wl_surface_commit(surface);
            posted++;
        }
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd p = { wlfd, POLLIN, 0 };
        if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
        elapsedMs += 16;
        handled = presented_count + discarded_count;
    }

    int ok = presented_count >= g_frames && early_count == 0 && discarded_count == 0;
    printf("[commit-timing-client] done presented=%d discarded=%d early=%d frames=%d ok=%d\n",
           presented_count, discarded_count, early_count, g_frames, ok);
    fflush(stdout);
    wp_commit_timer_v1_destroy(timer);
    wl_display_disconnect(display);
    return ok ? 0 : 1;
}
