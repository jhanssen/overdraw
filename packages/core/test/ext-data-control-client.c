// ext_data_control_v1 test client. Two roles:
//
//   --source [--primary] MIME TEXT
//       Create a source via the control protocol, offer MIME, set it as the
//       (clipboard | primary) selection, serve TEXT on send. Does NOT map a
//       window -- the protocol bypasses keyboard focus.
//
//   --receive [--primary] MIME
//       Wait for a (selection | primary_selection) event carrying MIME on the
//       control device, receive(), print "[ext-dc-client] received: <data>"
//       and exit 0. Also does NOT map a window.
//
// GPU-free.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <errno.h>
#include <stdint.h>

#include <wayland-client.h>
#include "ext-data-control-v1-client-protocol.h"

static struct wl_seat* seat = NULL;
static struct ext_data_control_manager_v1* mgr = NULL;
static struct ext_data_control_device_v1* dev = NULL;

static const char* g_mime = NULL;
static const char* g_text = NULL;
static int g_primary = 0;

static volatile sig_atomic_t running = 1;
static void onTerm(int sig) { (void)sig; running = 0; }

// --- source mode ---
static void srcSend(void* d, struct ext_data_control_source_v1* s, const char* mime, int32_t fd) {
    (void)d; (void)s; (void)mime;
    if (g_text) {
        ssize_t n = write(fd, g_text, strlen(g_text));
        (void)n;
    }
    close(fd);
}
static void srcCancelled(void* d, struct ext_data_control_source_v1* s) {
    (void)d; ext_data_control_source_v1_destroy(s);
}
static const struct ext_data_control_source_v1_listener srcListener = { srcSend, srcCancelled };

// --- receive mode ---
static struct ext_data_control_offer_v1* pending_offer = NULL;
static int offer_has_mime = 0;
static int got_selection = 0;
static int got_primary_selection = 0;

static void offOffer(void* d, struct ext_data_control_offer_v1* o, const char* mime) {
    (void)d; (void)o;
    if (g_mime && strcmp(mime, g_mime) == 0) offer_has_mime = 1;
}
static const struct ext_data_control_offer_v1_listener offListener = { offOffer };

static void devDataOffer(void* d, struct ext_data_control_device_v1* dd,
                         struct ext_data_control_offer_v1* offer) {
    (void)d; (void)dd;
    // A fresh offer arrived; reset the per-offer mime match and listen for
    // the per-mime offers that follow.
    pending_offer = offer;
    offer_has_mime = 0;
    ext_data_control_offer_v1_add_listener(offer, &offListener, NULL);
}
static void devSelection(void* d, struct ext_data_control_device_v1* dd,
                         struct ext_data_control_offer_v1* offer) {
    (void)d; (void)dd;
    got_selection = 1;
    // Note: selection event carries the same offer pointer the data_offer
    // event introduced, OR null when no clipboard owner.
    if (offer == NULL) pending_offer = NULL;
}
static void devFinished(void* d, struct ext_data_control_device_v1* dd) {
    (void)d; (void)dd;
    running = 0;
}
static void devPrimary(void* d, struct ext_data_control_device_v1* dd,
                       struct ext_data_control_offer_v1* offer) {
    (void)d; (void)dd;
    got_primary_selection = 1;
    if (offer == NULL && g_primary) pending_offer = NULL;
}
static const struct ext_data_control_device_v1_listener devListener = {
    devDataOffer, devSelection, devFinished, devPrimary,
};

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_seat") == 0 && !seat)
        seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
    else if (strcmp(iface, "ext_data_control_manager_v1") == 0)
        mgr = wl_registry_bind(reg, name, &ext_data_control_manager_v1_interface, 1);
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) {
    (void)data; (void)reg; (void)name;
}
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    const char* socket = NULL;
    int source_mode = 0, receive_mode = 0;

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--primary") == 0) g_primary = 1;
        else if (strcmp(argv[i], "--source") == 0 && i + 2 < argc) {
            source_mode = 1; g_mime = argv[++i]; g_text = argv[++i];
        } else if (strcmp(argv[i], "--receive") == 0 && i + 1 < argc) {
            receive_mode = 1; g_mime = argv[++i];
        }
    }
    if (!socket || (!source_mode && !receive_mode)) {
        fprintf(stderr,
            "usage: %s --socket NAME [--primary] (--source MIME TEXT | --receive MIME)\n",
            argv[0]);
        return 2;
    }

    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[ext-dc-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    if (!seat || !mgr) {
        fprintf(stderr, "[ext-dc-client] missing globals (seat=%p mgr=%p)\n", (void*)seat, (void*)mgr);
        return 1;
    }
    dev = ext_data_control_manager_v1_get_data_device(mgr, seat);
    ext_data_control_device_v1_add_listener(dev, &devListener, NULL);
    // Roundtrip so the manager.get_data_device + initial selection burst
    // make it back before we print "ready" and proceed. The receiver needs
    // the device bound before the source claims the selection.
    wl_display_roundtrip(display);
    printf("[ext-dc-client] device ready\n");
    fflush(stdout);

    if (source_mode) {
        struct ext_data_control_source_v1* src =
            ext_data_control_manager_v1_create_data_source(mgr);
        ext_data_control_source_v1_add_listener(src, &srcListener, NULL);
        ext_data_control_source_v1_offer(src, g_mime);
        if (g_primary) ext_data_control_device_v1_set_primary_selection(dev, src);
        else ext_data_control_device_v1_set_selection(dev, src);
        wl_display_roundtrip(display);
        printf("[ext-dc-client] selection set mime=%s primary=%d\n", g_mime, g_primary);
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

    // receive mode: wait for the matching selection offer.
    int wlfd = wl_display_get_fd(display);
    int* got = g_primary ? &got_primary_selection : &got_selection;
    for (int waited = 0; waited < 400; ++waited) {
        if (*got && pending_offer && offer_has_mime) break;
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd pfd = { wlfd, POLLIN, 0 };
        if (poll(&pfd, 1, 10) > 0 && (pfd.revents & POLLIN))
            if (wl_display_dispatch(display) < 0) break;
    }
    if (!*got || !pending_offer || !offer_has_mime) {
        fprintf(stderr,
            "[ext-dc-client] no matching offer (got=%d pending=%p mime_match=%d primary=%d)\n",
            *got, (void*)pending_offer, offer_has_mime, g_primary);
        return 1;
    }

    int pipefd[2];
    if (pipe(pipefd) != 0) { perror("pipe"); return 1; }
    ext_data_control_offer_v1_receive(pending_offer, g_mime, pipefd[1]);
    close(pipefd[1]);
    wl_display_flush(display);

    char received[4096];
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
            if (n == 0) break;
            off += (size_t)n;
        }
    }
    received[off] = '\0';
    close(pipefd[0]);
    printf("[ext-dc-client] received: %s\n", received);
    fflush(stdout);
    wl_display_disconnect(display);
    return off > 0 ? 0 : 1;
}
