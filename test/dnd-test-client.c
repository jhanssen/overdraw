// Drag-and-drop test client. Two roles:
//
//   --source MIME TEXT : map a window; create a data_source offering MIME with
//       dnd action copy; on the first pointer BUTTON PRESS over its surface, call
//       wl_data_device.start_drag. Serves TEXT on data_source.send. Prints
//       "[dnd-client] drag-started". Exits on SIGTERM.
//
//   --target MIME : map a window; on data_device.enter, accept(MIME) +
//       set_actions(copy); on drop, receive(MIME, pipe) + read + finish(); print
//       "[dnd-client] dropped: <text>" and exit 0.
//
// The harness drives the pointer (injectInput): move over the source, press
// (source starts the drag), move over the target, release (drop).

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <errno.h>
#include <stdint.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"

#define DND_COPY 1  /* WL_DATA_DEVICE_MANAGER_DND_ACTION_COPY */

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wl_seat* seat = NULL;
static struct wl_pointer* pointer = NULL;
static struct wl_data_device_manager* ddm = NULL;
static struct wl_data_device* data_device = NULL;
static struct wl_surface* surface = NULL;
static volatile sig_atomic_t running = 1;
static int configured = 0;

static const char* g_mime = NULL;
static const char* g_text = NULL;
static int is_source = 0;

// source: pending drag start on first button press.
static struct wl_data_source* g_src = NULL;
static uint32_t last_enter_serial = 0;
static int drag_started = 0;

// target: drop bookkeeping.
static struct wl_data_offer* cur_offer = NULL;
static int offer_has_mime = 0;
static int dropped = 0;
static char received[4096];

static void onTerm(int sig) { (void)sig; running = 0; }

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wmListener = { wmPing };
static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) { (void)d;(void)t;(void)w;(void)h;(void)s; }
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; running = 0; }
static void tlBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlBounds, tlCaps };
static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsListener = { xsConfigure };

// --- source data_source: serve payload on send; copy action. ---
static void srcTarget(void* d, struct wl_data_source* s, const char* m) { (void)d;(void)s;(void)m; }
static void srcSend(void* d, struct wl_data_source* s, const char* mime, int32_t fd) {
    (void)d;(void)s;(void)mime;
    if (g_text) { ssize_t n = write(fd, g_text, strlen(g_text)); (void)n; }
    close(fd);
}
static void srcCancelled(void* d, struct wl_data_source* s) { (void)d;(void)s; }
static void srcDndDrop(void* d, struct wl_data_source* s) { (void)d;(void)s; }
static void srcDndFinished(void* d, struct wl_data_source* s) { (void)d;(void)s; running = 0; }
static void srcAction(void* d, struct wl_data_source* s, uint32_t a) { (void)d;(void)s;(void)a; }
static const struct wl_data_source_listener srcListener = {
    srcTarget, srcSend, srcCancelled, srcDndDrop, srcDndFinished, srcAction };

// --- pointer (source): start a drag on the first button press. ---
static void ptrEnter(void* d, struct wl_pointer* p, uint32_t serial, struct wl_surface* s, wl_fixed_t x, wl_fixed_t y) {
    (void)d;(void)p;(void)s;(void)x;(void)y; last_enter_serial = serial;
}
static void ptrLeave(void* d, struct wl_pointer* p, uint32_t serial, struct wl_surface* s) { (void)d;(void)p;(void)serial;(void)s; }
static void ptrMotion(void* d, struct wl_pointer* p, uint32_t t, wl_fixed_t x, wl_fixed_t y) { (void)d;(void)p;(void)t;(void)x;(void)y; }
static void ptrButton(void* d, struct wl_pointer* p, uint32_t serial, uint32_t t, uint32_t button, uint32_t state) {
    (void)d;(void)p;(void)t;(void)button;
    if (is_source && state == 1 && !drag_started && g_src) {
        wl_data_device_start_drag(data_device, g_src, surface, NULL, serial);
        drag_started = 1;
        printf("[dnd-client] drag-started\n"); fflush(stdout);
    }
}
static void ptrAxis(void* d, struct wl_pointer* p, uint32_t t, uint32_t a, wl_fixed_t v) { (void)d;(void)p;(void)t;(void)a;(void)v; }
static void ptrFrame(void* d, struct wl_pointer* p) { (void)d;(void)p; }
static void ptrAxisSrc(void* d, struct wl_pointer* p, uint32_t s) { (void)d;(void)p;(void)s; }
static void ptrAxisStop(void* d, struct wl_pointer* p, uint32_t t, uint32_t a) { (void)d;(void)p;(void)t;(void)a; }
static void ptrAxisDisc(void* d, struct wl_pointer* p, uint32_t a, int32_t v) { (void)d;(void)p;(void)a;(void)v; }
static void ptrAxisV120(void* d, struct wl_pointer* p, uint32_t a, int32_t v) { (void)d;(void)p;(void)a;(void)v; }
static void ptrAxisRel(void* d, struct wl_pointer* p, uint32_t a, uint32_t dir) { (void)d;(void)p;(void)a;(void)dir; }
static const struct wl_pointer_listener ptrListener = {
    ptrEnter, ptrLeave, ptrMotion, ptrButton, ptrAxis, ptrFrame,
    ptrAxisSrc, ptrAxisStop, ptrAxisDisc, ptrAxisV120, ptrAxisRel };

// --- target data_offer: accept + set_actions; read on drop. ---
static void offOffer(void* d, struct wl_data_offer* o, const char* mime) {
    (void)d;(void)o;
    if (g_mime && strcmp(mime, g_mime) == 0) offer_has_mime = 1;
}
static void offSourceActions(void* d, struct wl_data_offer* o, uint32_t a) { (void)d;(void)o;(void)a; }
static void offAction(void* d, struct wl_data_offer* o, uint32_t a) { (void)d;(void)o;(void)a; }
static const struct wl_data_offer_listener offListener = { offOffer, offSourceActions, offAction };

static void ddDataOffer(void* d, struct wl_data_device* dd, struct wl_data_offer* offer) {
    (void)d;(void)dd;
    cur_offer = offer; offer_has_mime = 0;
    wl_data_offer_add_listener(offer, &offListener, NULL);
}
static void ddEnter(void* d, struct wl_data_device* dd, uint32_t serial, struct wl_surface* su,
                    wl_fixed_t x, wl_fixed_t y, struct wl_data_offer* o) {
    (void)d;(void)dd;(void)su;(void)x;(void)y;
    if (o && offer_has_mime) {
        wl_data_offer_accept(o, serial, g_mime);
        wl_data_offer_set_actions(o, DND_COPY, DND_COPY);
    }
}
static void ddLeave(void* d, struct wl_data_device* dd) { (void)d;(void)dd; }
static void ddMotion(void* d, struct wl_data_device* dd, uint32_t t, wl_fixed_t x, wl_fixed_t y) { (void)d;(void)dd;(void)t;(void)x;(void)y; }
static void ddDrop(void* d, struct wl_data_device* dd) {
    (void)d;(void)dd;
    if (!cur_offer) return;
    int pipefd[2];
    if (pipe(pipefd) != 0) return;
    wl_data_offer_receive(cur_offer, g_mime, pipefd[1]);
    close(pipefd[1]);
    dropped = 1;
    // Read happens in the main loop (needs the server to forward send to source).
    // Stash the read end via a global by reusing received[] reader below.
    extern int g_drop_readfd;
    g_drop_readfd = pipefd[0];
}
static void ddSelection(void* d, struct wl_data_device* dd, struct wl_data_offer* o) { (void)d;(void)dd;(void)o; }
static const struct wl_data_device_listener ddListener = {
    ddDataOffer, ddEnter, ddLeave, ddMotion, ddDrop, ddSelection };
int g_drop_readfd = -1;

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name, const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_compositor") == 0) compositor = wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "wl_shm") == 0) shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "wl_seat") == 0 && !seat) seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
    else if (strcmp(iface, "wl_data_device_manager") == 0) ddm = wl_registry_bind(reg, name, &wl_data_device_manager_interface, version < 3 ? version : 3);
    else if (strcmp(iface, "xdg_wm_base") == 0) { wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5); xdg_wm_base_add_listener(wm_base, &wmListener, NULL); }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

static void mapWindow(struct wl_display* display, uint32_t color) {
    const int W = 80, H = 80, stride = W * 4;
    int fd = memfd_create("dnd", 0);
    if (fd < 0 || ftruncate(fd, (off_t)stride * H) != 0) return;
    uint32_t* px = mmap(NULL, (size_t)stride * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) return;
    for (int i = 0; i < W * H; ++i) px[i] = color;
    munmap(px, (size_t)stride * H);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, stride * H);
    struct wl_buffer* buf = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
    surface = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surface);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* tl = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(tl, &tlListener, NULL);
    xdg_toplevel_set_title(tl, is_source ? "dnd-source" : "dnd-target");
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    wl_surface_attach(surface, buf, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--source") == 0 && i + 2 < argc) { is_source = 1; g_mime = argv[++i]; g_text = argv[++i]; }
        else if (strcmp(argv[i], "--target") == 0 && i + 1 < argc) { is_source = 0; g_mime = argv[++i]; }
    }
    if (!socket || !g_mime) { fprintf(stderr, "usage: %s --socket NAME (--source MIME TEXT | --target MIME)\n", argv[0]); return 2; }

    signal(SIGTERM, onTerm); signal(SIGINT, onTerm);
    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[dnd-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display); wl_display_roundtrip(display);

    if (!compositor || !shm || !seat || !ddm || !wm_base) {
        fprintf(stderr, "[dnd-client] missing globals\n"); return 1;
    }
    data_device = wl_data_device_manager_get_data_device(ddm, seat);
    wl_data_device_add_listener(data_device, &ddListener, NULL);
    pointer = wl_seat_get_pointer(seat);
    if (pointer) wl_pointer_add_listener(pointer, &ptrListener, NULL);

    mapWindow(display, is_source ? 0xFF3030C0u : 0xFF30C030u);
    printf("[dnd-client] %s mapped\n", is_source ? "source" : "target");
    fflush(stdout);

    if (is_source) {
        g_src = wl_data_device_manager_create_data_source(ddm);
        wl_data_source_add_listener(g_src, &srcListener, NULL);
        wl_data_source_offer(g_src, g_mime);
        wl_data_source_set_actions(g_src, DND_COPY);
    }

    int wlfd = wl_display_get_fd(display);
    while (running) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd pfds[2]; int nf = 1;
        pfds[0].fd = wlfd; pfds[0].events = POLLIN; pfds[0].revents = 0;
        if (g_drop_readfd >= 0) { pfds[1].fd = g_drop_readfd; pfds[1].events = POLLIN; pfds[1].revents = 0; nf = 2; }
        if (poll(pfds, nf, 10) > 0) {
            if (pfds[0].revents & POLLIN) { if (wl_display_dispatch(display) < 0) break; }
            if (nf == 2 && (pfds[1].revents & POLLIN)) {
                ssize_t n = read(g_drop_readfd, received, sizeof(received) - 1);
                if (n >= 0) {
                    received[n] = '\0';
                    if (cur_offer) wl_data_offer_finish(cur_offer);
                    wl_display_flush(display);
                    printf("[dnd-client] dropped: %s\n", received);
                    fflush(stdout);
                    close(g_drop_readfd); g_drop_readfd = -1;
                    wl_display_roundtrip(display);
                    wl_display_disconnect(display);
                    return 0;
                }
            }
        }
        (void)dropped;
    }
    wl_display_disconnect(display);
    return 0;
}
