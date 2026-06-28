// Controllable shm Wayland client for the integration harness.
//
// Maps a single xdg_toplevel backed by a solid-color shm buffer, prints a
// "[harness-client] mapped" line on stdout once the window is up, then holds the
// surface alive until SIGTERM (the harness controls the lifetime; no sleeps).
//
// Usage: harness-client --socket NAME [--size WxH] [--color AARRGGBB]
//                       [--title T] [--app-id ID]
//   defaults: size 200x150, color 0xFF0000FF (opaque blue), title/app-id "harness"
//
// Color is ARGB8888 (the wl_shm format), stored little-endian, matching the
// server's BGRA8Unorm upload byte-for-byte on LE.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <signal.h>
#include <time.h>
#include <poll.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wl_seat* seat = NULL;
static struct wl_keyboard* keyboard = NULL;
static struct wl_output* output = NULL;
static struct wl_surface* g_surface = NULL;
// The committed buffer + its size, so the --frames render loop can re-attach
// and damage real content each frame (a genuine render loop -- an empty commit
// produces no damage and so, correctly, no repaint/present).
static struct wl_buffer* g_buffer = NULL;
static int g_w = 0, g_h = 0;
static int surface_configured = 0;
static volatile sig_atomic_t running = 1;
// --fill-configured: track the latest configured content size so the client can
// resize its buffer to fill the compositor-assigned tile (tiling WM path).
static int fill_configured = 0;
static int cfg_w = 0, cfg_h = 0;   // latest xdg_toplevel.configure size (0 = unset)
// Initial state requests (sent BEFORE the initial commit so the server's first
// configure carries the resolved size + states): 0=none, 1=maximized,
// 2=fullscreen, 3=minimized. Set via --initial-state.
static int initial_state = 0;

static void onTerm(int sig) { (void)sig; running = 0; }

// --- wl_output: report geometry/mode so the harness can assert the advertised
// monitor matches the (headless) output size. ---
static void outGeometry(void* d, struct wl_output* o, int32_t x, int32_t y,
                        int32_t pw, int32_t ph, int32_t subpx, const char* make,
                        const char* model, int32_t transform) {
    (void)d;(void)o;(void)pw;(void)ph;(void)subpx;(void)make;(void)model;
    printf("[harness-client] output.geometry x=%d y=%d transform=%d\n", x, y, transform);
    fflush(stdout);
}
static void outMode(void* d, struct wl_output* o, uint32_t flags, int32_t w, int32_t h, int32_t refresh) {
    (void)d;(void)o;
    printf("[harness-client] output.mode flags=%u %dx%d refresh=%d\n", flags, w, h, refresh);
    fflush(stdout);
}
static void outDone(void* d, struct wl_output* o) { (void)d;(void)o;
    printf("[harness-client] output.done\n"); fflush(stdout); }
static void outScale(void* d, struct wl_output* o, int32_t s) { (void)d;(void)o;
    printf("[harness-client] output.scale %d\n", s); fflush(stdout); }
static void outName(void* d, struct wl_output* o, const char* n) { (void)d;(void)o;(void)n; }
static void outDescription(void* d, struct wl_output* o, const char* n) { (void)d;(void)o;(void)n; }
static const struct wl_output_listener outListener = {
    outGeometry, outMode, outDone, outScale, outName, outDescription };

// --- wl_keyboard: report received keys so the harness can assert key delivery
// to the focused client. ---
static void kbKeymap(void* d, struct wl_keyboard* k, uint32_t fmt, int32_t fd, uint32_t size) {
    (void)d;(void)k;(void)size;
    printf("[harness-client] kb.keymap format=%u\n", fmt); fflush(stdout);
    if (fd >= 0) close(fd);
}
static void kbEnter(void* d, struct wl_keyboard* k, uint32_t serial, struct wl_surface* s, struct wl_array* keys) {
    (void)d;(void)k;(void)serial;(void)s;(void)keys;
    printf("[harness-client] kb.enter\n"); fflush(stdout);
}
static void kbLeave(void* d, struct wl_keyboard* k, uint32_t serial, struct wl_surface* s) {
    (void)d;(void)k;(void)serial;(void)s;
    printf("[harness-client] kb.leave\n"); fflush(stdout);
}
static void kbKey(void* d, struct wl_keyboard* k, uint32_t serial, uint32_t time, uint32_t key, uint32_t state) {
    (void)d;(void)k;(void)serial;(void)time;
    printf("[harness-client] kb.key key=%u state=%u\n", key, state); fflush(stdout);
}
static void kbMods(void* d, struct wl_keyboard* k, uint32_t serial, uint32_t dep, uint32_t lat, uint32_t lock, uint32_t grp) {
    (void)d;(void)k;(void)serial;
    printf("[harness-client] kb.mods dep=%u lat=%u lock=%u grp=%u\n", dep, lat, lock, grp); fflush(stdout);
}
static void kbRepeat(void* d, struct wl_keyboard* k, int32_t rate, int32_t delay) {
    (void)d;(void)k;(void)rate;(void)delay; }
static const struct wl_keyboard_listener kbListener = {
    kbKeymap, kbEnter, kbLeave, kbKey, kbMods, kbRepeat };

static void seatCaps(void* d, struct wl_seat* s, uint32_t caps) {
    (void)d;
    if ((caps & WL_SEAT_CAPABILITY_KEYBOARD) && !keyboard) {
        keyboard = wl_seat_get_keyboard(s);
        wl_keyboard_add_listener(keyboard, &kbListener, NULL);
    }
}
static void seatName(void* d, struct wl_seat* s, const char* n) { (void)d;(void)s;(void)n; }
static const struct wl_seat_listener seatListener = { seatCaps, seatName };

// --- wl_callback: report frame-callback completion so the harness can assert
// the compositor fires wl_surface.frame -> wl_callback.done. ---
static int frame_done_count = 0;
static const struct wl_callback_listener frameListener;
static void requestFrame(void);
static void frameDone(void* d, struct wl_callback* cb, uint32_t t) {
    (void)d;(void)t;
    wl_callback_destroy(cb);
    frame_done_count++;
    printf("[harness-client] frame.done n=%d\n", frame_done_count); fflush(stdout);
    requestFrame();  // re-arm, like a real render loop
}
static const struct wl_callback_listener frameListener = { frameDone };
static void requestFrame(void) {
    if (!g_surface) return;
    struct wl_callback* cb = wl_surface_frame(g_surface);
    wl_callback_add_listener(cb, &frameListener, NULL);
    // Attach + damage real content each frame so the commit actually produces a
    // repaint (a no-op commit correctly yields no present).
    if (g_buffer) {
        wl_surface_attach(g_surface, g_buffer, 0, 0);
        wl_surface_damage(g_surface, 0, 0, g_w, g_h);
    }
    wl_surface_commit(g_surface);
}

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) {
    (void)d;(void)t;
    // Record the compositor-requested content size (0 means "client chooses").
    if (w > 0 && h > 0) { cfg_w = w; cfg_h = h; }
    // Report the states array so the harness can assert on maximized/fullscreen/
    // activated bits. The wl_array carries uint32 entries.
    printf("[harness-client] configure %dx%d states=[", w, h);
    const uint32_t* st = (const uint32_t*) s->data;
    const size_t n = s->size / sizeof(uint32_t);
    for (size_t i = 0; i < n; ++i) printf("%s%u", i ? "," : "", st[i]);
    printf("]\n");
    fflush(stdout);
}
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
    } else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    } else if (strcmp(iface, "wl_seat") == 0 && !seat) {
        seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
        wl_seat_add_listener(seat, &seatListener, NULL);
    } else if (strcmp(iface, "wl_output") == 0 && !output) {
        output = wl_registry_bind(reg, name, &wl_output_interface, version < 2 ? version : 2);
        wl_output_add_listener(output, &outListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

// Allocate a solid-color wl_buffer of the given size. Returns the buffer (and
// leaks the pool/fd intentionally for the test client's lifetime, matching the
// original single-buffer behavior). On failure returns NULL.
static struct wl_buffer* make_solid_buffer(int w, int h, uint32_t color) {
    if (w <= 0 || h <= 0) return NULL;
    const int stride = w * 4;
    const size_t poolSize = (size_t)stride * h;
    int fd = memfd_create("overdraw-harness", 0);
    if (fd < 0 || ftruncate(fd, poolSize) != 0) { perror("memfd"); return NULL; }
    uint32_t* px = mmap(NULL, poolSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); close(fd); return NULL; }
    for (int i = 0; i < w * h; ++i) px[i] = color;
    munmap(px, poolSize);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, poolSize);
    struct wl_buffer* buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride, WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);  // the buffer holds its own ref to the mapping
    close(fd);
    return buf;
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    const char* title = "harness";
    const char* app_id = "harness";
    int W = 200, H = 150;
    uint32_t color = 0xFF0000FFu;  // opaque blue (ARGB)
    int report_frames = 0;  // --frames: drive a frame-callback loop + print done

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) { sscanf(argv[++i], "%dx%d", &W, &H); }
        else if (strcmp(argv[i], "--color") == 0 && i + 1 < argc) { color = (uint32_t)strtoul(argv[++i], NULL, 16); }
        else if (strcmp(argv[i], "--title") == 0 && i + 1 < argc) title = argv[++i];
        else if (strcmp(argv[i], "--app-id") == 0 && i + 1 < argc) app_id = argv[++i];
        else if (strcmp(argv[i], "--frames") == 0) report_frames = 1;
        else if (strcmp(argv[i], "--fill-configured") == 0) fill_configured = 1;
        else if (strcmp(argv[i], "--initial-state") == 0 && i + 1 < argc) {
            const char* v = argv[++i];
            if (strcmp(v, "maximized") == 0) initial_state = 1;
            else if (strcmp(v, "fullscreen") == 0) initial_state = 2;
            else if (strcmp(v, "minimized") == 0) initial_state = 3;
        }
    }
    if (!socket) { fprintf(stderr, "usage: %s --socket NAME [--size WxH] [--color AARRGGBB] [--title T] [--app-id ID]\n", argv[0]); return 2; }
    if (W <= 0 || H <= 0) { fprintf(stderr, "[harness-client] bad size\n"); return 2; }

    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[harness-client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // globals
    wl_display_roundtrip(display);  // shm format events

    if (!compositor || !shm || !wm_base) {
        fprintf(stderr, "[harness-client] missing globals (compositor=%p shm=%p wm=%p)\n",
                (void*)compositor, (void*)shm, (void*)wm_base);
        return 1;
    }

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    g_surface = surface;
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* toplevel = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(toplevel, &tlListener, NULL);
    xdg_toplevel_set_title(toplevel, title);
    xdg_toplevel_set_app_id(toplevel, app_id);

    // --initial-state: send the state-affecting request BEFORE the initial
    // commit so the server's first configure carries the resolved size +
    // states. Exercises the deferred-configure path (set_maximized between
    // get_toplevel and wl_surface.commit -> single first configure).
    switch (initial_state) {
        case 1: xdg_toplevel_set_maximized(toplevel); break;
        case 2: xdg_toplevel_set_fullscreen(toplevel, NULL); break;
        case 3: xdg_toplevel_set_minimized(toplevel); break;
    }

    wl_surface_commit(surface);        // initial commit: triggers configure
    wl_display_roundtrip(display);     // receive configure (sets cfg_w/h), ack sent

    // In --fill-configured mode, adopt the compositor-assigned tile size so the
    // client fills its tile (tiling WM path). Otherwise use the requested --size.
    if (fill_configured && cfg_w > 0 && cfg_h > 0) { W = cfg_w; H = cfg_h; }

    struct wl_buffer* buffer = make_solid_buffer(W, H, color);
    if (!buffer) return 1;
    int cur_w = W, cur_h = H;
    g_buffer = buffer; g_w = W; g_h = H;

    wl_surface_attach(surface, buffer, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);        // upload happens server-side here
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    // Signal readiness to the harness (which waits on the window via query()).
    printf("[harness-client] mapped %dx%d title=%s app_id=%s configured=%d\n",
           W, H, title, app_id, surface_configured);
    fflush(stdout);

    // Optional: drive a frame-callback loop so the harness can assert the
    // compositor fires wl_surface.frame -> wl_callback.done each frame.
    if (report_frames) requestFrame();

    // Hold the surface alive, servicing the display, until the harness kills us.
    // We must READ the socket (not just dispatch the in-memory queue) so events
    // the server sends -- wl_keyboard.enter/key, wl_callback.done, etc. -- are
    // actually delivered. poll the wl fd, then dispatch when readable; this stays
    // responsive to SIGTERM (10ms poll timeout) without blocking.
    //
    // Also poll stdin: a `rename <id>` line sets a new app_id + title AFTER map
    // (the harness sends it only once the window is confirmed mapped via query()),
    // exercising the post-map window-state change stream deterministically.
    int wlfd = wl_display_get_fd(display);
    char inbuf[256];
    while (running) {
        wl_display_dispatch_pending(display);
        // --fill-configured: if the compositor reconfigured us to a new tile size,
        // reallocate a buffer at that size, ack, and recommit so we fill the tile.
        if (fill_configured && cfg_w > 0 && cfg_h > 0 && (cfg_w != cur_w || cfg_h != cur_h)) {
            struct wl_buffer* nb = make_solid_buffer(cfg_w, cfg_h, color);
            if (nb) {
                cur_w = cfg_w; cur_h = cfg_h;
                g_buffer = nb; g_w = cur_w; g_h = cur_h;
                wl_surface_attach(surface, nb, 0, 0);
                wl_surface_damage(surface, 0, 0, cur_w, cur_h);
                wl_surface_commit(surface);
            }
        }
        wl_display_flush(display);
        struct pollfd pfd[2] = { { wlfd, POLLIN, 0 }, { STDIN_FILENO, POLLIN, 0 } };
        if (poll(pfd, 2, 10) > 0) {
            if (pfd[1].revents & POLLIN) {
                ssize_t n = read(STDIN_FILENO, inbuf, sizeof(inbuf) - 1);
                if (n > 0) {
                    inbuf[n] = '\0';
                    char id[128];
                    if (sscanf(inbuf, "rename %127s", id) == 1) {
                        xdg_toplevel_set_app_id(toplevel, id);
                        xdg_toplevel_set_title(toplevel, id);
                        wl_surface_commit(surface);
                        wl_display_flush(display);
                        printf("[harness-client] renamed app_id=%s\n", id);
                        fflush(stdout);
                    }
                }
            }
            if (pfd[0].revents & POLLIN) {
                if (wl_display_dispatch(display) < 0) break;  // reads + dispatches
            }
        }
    }

    xdg_toplevel_destroy(toplevel);
    xdg_surface_destroy(xs);
    wl_buffer_destroy(buffer);
    wl_surface_destroy(surface);
    wl_display_roundtrip(display);
    xdg_wm_base_destroy(wm_base);
    wl_shm_destroy(shm);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    return 0;
}
