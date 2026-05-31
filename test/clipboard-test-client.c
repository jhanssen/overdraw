// Clipboard (wl_data_device selection) test client. Two roles, selected by arg:
//
//   --source MIME TEXT : create a wl_data_source offering MIME, set it as the
//       selection, and serve TEXT whenever the compositor sends data_source.send
//       (write TEXT to the fd, close it). Stays alive until SIGTERM.
//
//   --receive MIME : wait for a data_device.selection offer carrying MIME, then
//       data_offer.receive(MIME, pipe-write-fd), read the data from the pipe read
//       end, print "[clipboard-client] received: <data>", and exit 0. Exits 1 if
//       no matching offer arrives in time.
//
// GPU-free: server + data-device protocol only.

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
#include "primary-selection-unstable-v1-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct wl_seat* seat = NULL;
static struct wl_data_device_manager* ddm = NULL;
static struct wl_data_device* data_device = NULL;
static struct zwp_primary_selection_device_manager_v1* psm = NULL;
static struct zwp_primary_selection_device_v1* primary_device = NULL;
static volatile sig_atomic_t running = 1;
static int configured = 0;

static const char* g_mime = NULL;
static const char* g_text = NULL;       // source mode payload
static struct wl_data_offer* pending_offer = NULL;
static int offer_has_mime = 0;          // the current offer advertised g_mime
static int got_selection = 0;
static char received[4096];
static int received_done = 0;

static void onTerm(int sig) { (void)sig; running = 0; }

// --- wl_data_source (source mode): serve the payload on 'send'. ---
static void srcTarget(void* d, struct wl_data_source* s, const char* m) { (void)d;(void)s;(void)m; }
static void srcSend(void* d, struct wl_data_source* s, const char* mime, int32_t fd) {
    (void)d;(void)s;(void)mime;
    if (g_text) { ssize_t n = write(fd, g_text, strlen(g_text)); (void)n; }
    close(fd);
}
static void srcCancelled(void* d, struct wl_data_source* s) { (void)d; wl_data_source_destroy(s); }
static void srcDndDropPerformed(void* d, struct wl_data_source* s) { (void)d;(void)s; }
static void srcDndFinished(void* d, struct wl_data_source* s) { (void)d;(void)s; }
static void srcAction(void* d, struct wl_data_source* s, uint32_t a) { (void)d;(void)s;(void)a; }
static const struct wl_data_source_listener srcListener = {
    srcTarget, srcSend, srcCancelled, srcDndDropPerformed, srcDndFinished, srcAction };

// --- wl_data_offer (receive mode): record whether it advertises our mime. ---
static void offOffer(void* d, struct wl_data_offer* o, const char* mime) {
    (void)d;(void)o;
    if (g_mime && strcmp(mime, g_mime) == 0) offer_has_mime = 1;
}
static void offSourceActions(void* d, struct wl_data_offer* o, uint32_t a) { (void)d;(void)o;(void)a; }
static void offAction(void* d, struct wl_data_offer* o, uint32_t a) { (void)d;(void)o;(void)a; }
static const struct wl_data_offer_listener offListener = { offOffer, offSourceActions, offAction };

// --- wl_data_device (receive mode): data_offer + selection events. ---
static void ddDataOffer(void* d, struct wl_data_device* dd, struct wl_data_offer* offer) {
    (void)d;(void)dd;
    pending_offer = offer;
    offer_has_mime = 0;
    wl_data_offer_add_listener(offer, &offListener, NULL);
}
static void ddEnter(void* d, struct wl_data_device* dd, uint32_t s, struct wl_surface* su,
                    wl_fixed_t x, wl_fixed_t y, struct wl_data_offer* o) { (void)d;(void)dd;(void)s;(void)su;(void)x;(void)y;(void)o; }
static void ddLeave(void* d, struct wl_data_device* dd) { (void)d;(void)dd; }
static void ddMotion(void* d, struct wl_data_device* dd, uint32_t t, wl_fixed_t x, wl_fixed_t y) { (void)d;(void)dd;(void)t;(void)x;(void)y; }
static void ddDrop(void* d, struct wl_data_device* dd) { (void)d;(void)dd; }
static void ddSelection(void* d, struct wl_data_device* dd, struct wl_data_offer* offer) {
    (void)d;(void)dd;
    got_selection = 1;
    pending_offer = offer; // may be NULL (selection cleared)
}
static const struct wl_data_device_listener ddListener = {
    ddDataOffer, ddEnter, ddLeave, ddMotion, ddDrop, ddSelection };

// Minimal xdg_wm_base + toplevel mapping so the RECEIVER can take keyboard focus
// (selection events go to the keyboard-focused client; focus-on-map gives it).
static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wmListener = { wmPing };
static void tlConfigure(void* d, struct xdg_toplevel* t, int32_t w, int32_t h, struct wl_array* s) { (void)d;(void)t;(void)w;(void)h;(void)s; }
static void tlClose(void* d, struct xdg_toplevel* t) { (void)d;(void)t; running = 0; }
static void tlBounds(void* d, struct xdg_toplevel* t, int32_t w, int32_t h) { (void)d;(void)t;(void)w;(void)h; }
static void tlCaps(void* d, struct xdg_toplevel* t, struct wl_array* c) { (void)d;(void)t;(void)c; }
static const struct xdg_toplevel_listener tlListener = { tlConfigure, tlClose, tlBounds, tlCaps };
static void xsConfigure(void* d, struct xdg_surface* xs, uint32_t serial) { (void)d; configured = 1; xdg_surface_ack_configure(xs, serial); }
static const struct xdg_surface_listener xsListener = { xsConfigure };

// --- primary selection listeners (mirror of the wl_data_* ones) ---
static void psrcSend(void* d, struct zwp_primary_selection_source_v1* s, const char* mime, int32_t fd) {
    (void)d;(void)s;(void)mime;
    if (g_text) { ssize_t n = write(fd, g_text, strlen(g_text)); (void)n; }
    close(fd);
}
static void psrcCancelled(void* d, struct zwp_primary_selection_source_v1* s) { (void)d; zwp_primary_selection_source_v1_destroy(s); }
static const struct zwp_primary_selection_source_v1_listener psrcListener = { psrcSend, psrcCancelled };

static struct zwp_primary_selection_offer_v1* primary_pending_offer = NULL;
static void poffOffer(void* d, struct zwp_primary_selection_offer_v1* o, const char* mime) {
    (void)d;(void)o;
    if (g_mime && strcmp(mime, g_mime) == 0) offer_has_mime = 1;
}
static const struct zwp_primary_selection_offer_v1_listener poffListener = { poffOffer };

static void pdDataOffer(void* d, struct zwp_primary_selection_device_v1* dd, struct zwp_primary_selection_offer_v1* offer) {
    (void)d;(void)dd;
    primary_pending_offer = offer;
    offer_has_mime = 0;
    zwp_primary_selection_offer_v1_add_listener(offer, &poffListener, NULL);
}
static void pdSelection(void* d, struct zwp_primary_selection_device_v1* dd, struct zwp_primary_selection_offer_v1* offer) {
    (void)d;(void)dd;
    got_selection = 1;
    primary_pending_offer = offer;
}
static const struct zwp_primary_selection_device_v1_listener pdListener = { pdDataOffer, pdSelection };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name, const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_seat") == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
    else if (strcmp(iface, "wl_data_device_manager") == 0)
        ddm = wl_registry_bind(reg, name, &wl_data_device_manager_interface, version < 3 ? version : 3);
    else if (strcmp(iface, "zwp_primary_selection_device_manager_v1") == 0)
        psm = wl_registry_bind(reg, name, &zwp_primary_selection_device_manager_v1_interface, 1);
    else if (strcmp(iface, "wl_compositor") == 0)
        compositor = wl_registry_bind(reg, name, &wl_compositor_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "wl_shm") == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) { (void)data;(void)reg;(void)name; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

// Map a small solid toplevel so this client receives keyboard focus.
static void mapWindow(struct wl_display* display) {
    const int W = 64, H = 64, stride = W * 4;
    int fd = memfd_create("clip", 0);
    if (fd < 0 || ftruncate(fd, (off_t)stride * H) != 0) return;
    uint32_t* px = mmap(NULL, (size_t)stride * H, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) return;
    for (int i = 0; i < W * H; ++i) px[i] = 0xFF202020u;
    munmap(px, (size_t)stride * H);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, (int)stride * H);
    struct wl_buffer* buf = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
    struct wl_surface* surf = wl_compositor_create_surface(compositor);
    struct xdg_surface* xs = xdg_wm_base_get_xdg_surface(wm_base, surf);
    xdg_surface_add_listener(xs, &xsListener, NULL);
    struct xdg_toplevel* tl = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(tl, &tlListener, NULL);
    xdg_toplevel_set_title(tl, "clipboard-receiver");
    wl_surface_commit(surf);
    wl_display_roundtrip(display);
    wl_surface_attach(surf, buf, 0, 0);
    wl_surface_damage(surf, 0, 0, W, H);
    wl_surface_commit(surf);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    int source_mode = 0, receive_mode = 0, primary = 0;

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--source") == 0 && i + 2 < argc) {
            source_mode = 1; g_mime = argv[++i]; g_text = argv[++i];
        } else if (strcmp(argv[i], "--receive") == 0 && i + 1 < argc) {
            receive_mode = 1; g_mime = argv[++i];
        } else if (strcmp(argv[i], "--primary") == 0) {
            primary = 1;
        }
    }
    if (!socket || (!source_mode && !receive_mode)) {
        fprintf(stderr, "usage: %s --socket NAME (--source MIME TEXT | --receive MIME)\n", argv[0]);
        return 2;
    }

    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[clipboard-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    if (!seat || (!primary && !ddm) || (primary && !psm)) {
        fprintf(stderr, "[clipboard-client] missing globals (seat=%p ddm=%p psm=%p primary=%d)\n",
                (void*)seat, (void*)ddm, (void*)psm, primary);
        return 1;
    }
    if (primary) {
        primary_device = zwp_primary_selection_device_manager_v1_get_device(psm, seat);
        zwp_primary_selection_device_v1_add_listener(primary_device, &pdListener, NULL);
    } else {
        data_device = wl_data_device_manager_get_data_device(ddm, seat);
        wl_data_device_add_listener(data_device, &ddListener, NULL);
    }

    // Receiver maps a window to take keyboard focus (selection goes to the focused
    // client). The source does not need focus to SET the selection.
    if (receive_mode) {
        if (!compositor || !shm || !wm_base) {
            fprintf(stderr, "[clipboard-client] receiver missing compositor/shm/wm_base\n");
            return 1;
        }
        mapWindow(display);
        printf("[clipboard-client] receiver mapped\n");
        fflush(stdout);
    }

    if (source_mode) {
        if (primary) {
            struct zwp_primary_selection_source_v1* src =
                zwp_primary_selection_device_manager_v1_create_source(psm);
            zwp_primary_selection_source_v1_add_listener(src, &psrcListener, NULL);
            zwp_primary_selection_source_v1_offer(src, g_mime);
            zwp_primary_selection_device_v1_set_selection(primary_device, src, 0);
        } else {
            struct wl_data_source* src = wl_data_device_manager_create_data_source(ddm);
            wl_data_source_add_listener(src, &srcListener, NULL);
            wl_data_source_offer(src, g_mime);
            // serial 0: our minimal server ignores serial validation.
            wl_data_device_set_selection(data_device, src, 0);
        }
        wl_display_roundtrip(display);
        printf("[clipboard-client] selection set mime=%s\n", g_mime);
        fflush(stdout);

        int wlfd = wl_display_get_fd(display);
        while (running) {
            wl_display_dispatch_pending(display);
            wl_display_flush(display);
            struct pollfd pfd = { wlfd, POLLIN, 0 };
            if (poll(&pfd, 1, 10) > 0 && (pfd.revents & POLLIN))
                if (wl_display_dispatch(display) < 0) break;
        }
        wl_display_disconnect(display);
        return 0;
    }

    // receive mode: wait for a selection offer with our mime, then receive it.
    int wlfd = wl_display_get_fd(display);
    #define HAVE_OFFER() (got_selection && offer_has_mime && \
                          (primary ? (primary_pending_offer != NULL) : (pending_offer != NULL)))
    for (int waited = 0; waited < 400 && !HAVE_OFFER(); ++waited) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd pfd = { wlfd, POLLIN, 0 };
        if (poll(&pfd, 1, 10) > 0 && (pfd.revents & POLLIN))
            if (wl_display_dispatch(display) < 0) break;
    }
    if (!HAVE_OFFER()) {
        fprintf(stderr, "[clipboard-client] no matching selection offer (selection=%d mime=%d)\n",
                got_selection, offer_has_mime);
        return 1;
    }

    int pipefd[2];
    if (pipe(pipefd) != 0) { perror("pipe"); return 1; }
    if (primary) zwp_primary_selection_offer_v1_receive(primary_pending_offer, g_mime, pipefd[1]);
    else wl_data_offer_receive(pending_offer, g_mime, pipefd[1]);
    close(pipefd[1]);          // we only read
    wl_display_flush(display); // ensure the receive request reaches the server

    // Read the data the source writes into the pipe, pumping the display so the
    // source's send callback runs (it lives in another client via the server).
    size_t off = 0;
    while (off < sizeof(received) - 1) {
        wl_display_flush(display);
        struct pollfd pfd[2] = { { pipefd[0], POLLIN, 0 }, { wlfd, POLLIN, 0 } };
        int r = poll(pfd, 2, 1000);
        if (r <= 0) break;
        if (pfd[1].revents & POLLIN) wl_display_dispatch(display);
        if (pfd[0].revents & POLLIN) {
            ssize_t n = read(pipefd[0], received + off, sizeof(received) - 1 - off);
            if (n < 0) { if (errno == EINTR) continue; break; }
            if (n == 0) { received_done = 1; break; } // EOF: source closed
            off += (size_t)n;
        }
    }
    received[off] = '\0';
    close(pipefd[0]);
    printf("[clipboard-client] received: %s\n", received);
    fflush(stdout);
    wl_display_disconnect(display);
    return received_done || off > 0 ? 0 : 1;
}
