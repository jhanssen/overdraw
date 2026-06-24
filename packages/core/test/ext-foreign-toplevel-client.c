// ext_foreign_toplevel_list_v1 test client: binds the list, waits for
// `toplevel` events, and prints one line per discovered toplevel with its
// identifier, app_id, and title. Exits 0 after observing at least
// --expect N distinct toplevels (default 1).
//
// Usage: ext-foreign-toplevel-client --socket NAME [--expect N] [--timeout-ms N]

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>

#include <wayland-client.h>
#include "ext-foreign-toplevel-list-v1-client-protocol.h"

static struct ext_foreign_toplevel_list_v1* list = NULL;
static volatile sig_atomic_t running = 1;
static int g_expect = 1;
static int g_timeoutMs = 5000;

static void onTerm(int sig) { (void)sig; running = 0; }

// Track up to a small number of toplevels; one printed line per handle.
struct ToplevelInfo {
    struct ext_foreign_toplevel_handle_v1* handle;
    char* identifier;
    char* app_id;
    char* title;
    int finalized;
};

#define MAX_TL 32
static struct ToplevelInfo toplevels[MAX_TL];
static int toplevelCount = 0;
static int donePrinted = 0;

static struct ToplevelInfo* findByHandle(struct ext_foreign_toplevel_handle_v1* h) {
    for (int i = 0; i < toplevelCount; i++)
        if (toplevels[i].handle == h) return &toplevels[i];
    return NULL;
}

static void handleIdentifier(void* d, struct ext_foreign_toplevel_handle_v1* h, const char* id) {
    (void)d;
    struct ToplevelInfo* t = findByHandle(h);
    if (!t) return;
    free(t->identifier);
    t->identifier = strdup(id);
}
static void handleAppId(void* d, struct ext_foreign_toplevel_handle_v1* h, const char* a) {
    (void)d;
    struct ToplevelInfo* t = findByHandle(h);
    if (!t) return;
    free(t->app_id);
    t->app_id = strdup(a);
}
static void handleTitle(void* d, struct ext_foreign_toplevel_handle_v1* h, const char* tt) {
    (void)d;
    struct ToplevelInfo* t = findByHandle(h);
    if (!t) return;
    free(t->title);
    t->title = strdup(tt);
}
static void handleDone(void* d, struct ext_foreign_toplevel_handle_v1* h) {
    (void)d;
    struct ToplevelInfo* t = findByHandle(h);
    if (!t) return;
    if (!t->finalized) {
        t->finalized = 1;
        printf("[ext-ftl-client] toplevel id=%s app_id=%s title=%s\n",
               t->identifier ? t->identifier : "",
               t->app_id ? t->app_id : "",
               t->title ? t->title : "");
        fflush(stdout);
        donePrinted++;
    }
}
static void handleClosed(void* d, struct ext_foreign_toplevel_handle_v1* h) {
    (void)d; (void)h;
    printf("[ext-ftl-client] closed\n");
    fflush(stdout);
}
static const struct ext_foreign_toplevel_handle_v1_listener handleListener = {
    handleClosed, handleDone, handleTitle, handleAppId, handleIdentifier,
};

static void listToplevel(void* d, struct ext_foreign_toplevel_list_v1* l,
                         struct ext_foreign_toplevel_handle_v1* tl) {
    (void)d; (void)l;
    if (toplevelCount >= MAX_TL) {
        ext_foreign_toplevel_handle_v1_destroy(tl);
        return;
    }
    struct ToplevelInfo* slot = &toplevels[toplevelCount++];
    memset(slot, 0, sizeof(*slot));
    slot->handle = tl;
    ext_foreign_toplevel_handle_v1_add_listener(tl, &handleListener, NULL);
}
static void listFinished(void* d, struct ext_foreign_toplevel_list_v1* l) {
    (void)d; (void)l;
    running = 0;
}
static const struct ext_foreign_toplevel_list_v1_listener listListener = {
    listToplevel, listFinished,
};

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data; (void)version;
    if (strcmp(iface, "ext_foreign_toplevel_list_v1") == 0)
        list = wl_registry_bind(reg, name, &ext_foreign_toplevel_list_v1_interface, 1);
}
static void regRemove(void* d, struct wl_registry* r, uint32_t n) { (void)d;(void)r;(void)n; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    const char* socket = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--expect") == 0 && i + 1 < argc) g_expect = atoi(argv[++i]);
        else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) g_timeoutMs = atoi(argv[++i]);
    }
    if (!socket) {
        fprintf(stderr, "usage: %s --socket NAME [--expect N] [--timeout-ms N]\n", argv[0]);
        return 2;
    }
    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[ext-ftl-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    if (!list) {
        fprintf(stderr, "[ext-ftl-client] ext_foreign_toplevel_list_v1 not advertised\n");
        return 1;
    }
    ext_foreign_toplevel_list_v1_add_listener(list, &listListener, NULL);
    wl_display_roundtrip(display);
    printf("[ext-ftl-client] ready\n");
    fflush(stdout);

    int wlfd = wl_display_get_fd(display);
    long elapsedMs = 0;
    while (running && donePrinted < g_expect && elapsedMs < g_timeoutMs) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd p = { wlfd, POLLIN, 0 };
        if (poll(&p, 1, 50) > 0 && (p.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
        elapsedMs += 50;
    }
    int ok = donePrinted >= g_expect;
    printf("[ext-ftl-client] done seen=%d expect=%d ok=%d\n",
           donePrinted, g_expect, ok);
    fflush(stdout);
    wl_display_disconnect(display);
    return ok ? 0 : 1;
}
