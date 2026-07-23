// zwlr_layer_shell_v1 / zwlr_layer_surface_v1 test client. Creates a panel
// layer surface anchored to a chosen edge with optional exclusive zone,
// goes through the configure / ack / first-buffer handshake, and prints
// status markers to stdout that the GPU test polls.
//
// CLI:
//   --socket NAME              wayland socket name (required)
//   --layer top|overlay|bottom|background   (default: top)
//   --anchor BITS              anchor bitfield (e.g. 13 = top|left|right). Default: top|left|right.
//   --size WxH                 surface size. Use 0 for an axis to "span the anchors". Default: 0x30.
//   --zone N                   exclusive zone (default: 30). Pass -1 to extend, 0 to avoid.
//   --kbd none|exclusive|on_demand   keyboard interactivity (default: none)
//   --color RRGGBB             solid color fill (default: 00FF00 green)
//
// stdout markers:
//   "[client] bound"                  globals bound
//   "[client] configure W H"          received first configure
//   "[client] mapped"                 buffer attached + committed after ack
//   "[client] keyboard.enter"         got wl_keyboard.enter
//   "[client] keyboard.key K"         got a key event
//   "[client] done"                   tearing down

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <stdint.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "wlr-layer-shell-unstable-v1-client-protocol.h"

static struct wl_compositor* compositor = NULL;
static struct wl_shm* shm = NULL;
static struct xdg_wm_base* wm_base = NULL;
static struct zwlr_layer_shell_v1* layer_shell = NULL;
static struct wl_seat* seat = NULL;
static struct wl_keyboard* keyboard = NULL;

static int got_configure = 0;
static uint32_t configure_serial = 0;
static int configured_w = 0;
static int configured_h = 0;

static int got_kb_enter = 0;
static int got_kb_key = 0;
static uint32_t last_key = 0;

// Defaults; CLI overrides them.
static int requested_w = 0;
static int requested_h = 30;
static uint32_t requested_anchor =
    ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP
    | ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT
    | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT;
static int requested_zone = 30;
static enum zwlr_layer_shell_v1_layer requested_layer = ZWLR_LAYER_SHELL_V1_LAYER_TOP;
static int requested_kbd = ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
static uint32_t fill_color = 0xFF00FF00u; // ARGB green

static void wmPing(void* d, struct xdg_wm_base* b, uint32_t serial) {
    (void)d; xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wmListener = { wmPing };

static void lsConfigure(void* data, struct zwlr_layer_surface_v1* ls,
                        uint32_t serial, uint32_t w, uint32_t h) {
    (void)data;
    configure_serial = serial;
    configured_w = (int)w;
    configured_h = (int)h;
    got_configure = 1;
    zwlr_layer_surface_v1_ack_configure(ls, serial);
    printf("[client] configure %d %d\n", configured_w, configured_h);
    fflush(stdout);
}
static void lsClosed(void* data, struct zwlr_layer_surface_v1* ls) {
    (void)data;(void)ls;
}
static const struct zwlr_layer_surface_v1_listener lsListener = { lsConfigure, lsClosed };

static void kbKeymap(void* d, struct wl_keyboard* k, uint32_t format, int fd, uint32_t size) {
    (void)d;(void)k;(void)format;(void)size;
    if (fd >= 0) close(fd);
}
static void kbEnter(void* d, struct wl_keyboard* k, uint32_t serial,
                    struct wl_surface* s, struct wl_array* keys) {
    (void)d;(void)k;(void)serial;(void)s;(void)keys;
    got_kb_enter = 1;
    printf("[client] keyboard.enter\n"); fflush(stdout);
}
static void kbLeave(void* d, struct wl_keyboard* k, uint32_t serial, struct wl_surface* s) {
    (void)d;(void)k;(void)serial;(void)s;
}
static void kbKey(void* d, struct wl_keyboard* k, uint32_t serial,
                  uint32_t time, uint32_t key, uint32_t state) {
    (void)d;(void)k;(void)serial;(void)time;(void)state;
    got_kb_key = 1;
    last_key = key;
    printf("[client] keyboard.key %u\n", key); fflush(stdout);
}
static void kbMods(void* d, struct wl_keyboard* k, uint32_t serial,
                   uint32_t dep, uint32_t lat, uint32_t lock, uint32_t group) {
    (void)d;(void)k;(void)serial;(void)dep;(void)lat;(void)lock;(void)group;
}
static void kbRepeat(void* d, struct wl_keyboard* k, int32_t rate, int32_t delay) {
    (void)d;(void)k;(void)rate;(void)delay;
}
static const struct wl_keyboard_listener kbListener = {
    kbKeymap, kbEnter, kbLeave, kbKey, kbMods, kbRepeat
};

static void seatCaps(void* d, struct wl_seat* s, uint32_t caps) {
    (void)d;
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
    else if (strcmp(iface, "wl_shm") == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "xdg_wm_base") == 0) {
        wm_base = wl_registry_bind(reg, name, &xdg_wm_base_interface, version < 5 ? version : 5);
        xdg_wm_base_add_listener(wm_base, &wmListener, NULL);
    } else if (strcmp(iface, "wl_seat") == 0) {
        seat = wl_registry_bind(reg, name, &wl_seat_interface, version < 5 ? version : 5);
        wl_seat_add_listener(seat, &seatListener, NULL);
    } else if (strcmp(iface, "zwlr_layer_shell_v1") == 0) {
        layer_shell = wl_registry_bind(reg, name, &zwlr_layer_shell_v1_interface,
                                       version < 4 ? version : 4);
    }
}
static void regRemove(void* d, struct wl_registry* r, uint32_t n) { (void)d;(void)r;(void)n; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

static enum zwlr_layer_shell_v1_layer parseLayer(const char* s) {
    if (strcmp(s, "background") == 0) return ZWLR_LAYER_SHELL_V1_LAYER_BACKGROUND;
    if (strcmp(s, "bottom") == 0) return ZWLR_LAYER_SHELL_V1_LAYER_BOTTOM;
    if (strcmp(s, "top") == 0) return ZWLR_LAYER_SHELL_V1_LAYER_TOP;
    if (strcmp(s, "overlay") == 0) return ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY;
    return ZWLR_LAYER_SHELL_V1_LAYER_TOP;
}

static int parseKbd(const char* s) {
    if (strcmp(s, "none") == 0) return ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
    if (strcmp(s, "exclusive") == 0) return ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_EXCLUSIVE;
    if (strcmp(s, "on_demand") == 0) return ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_ON_DEMAND;
    return ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE;
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    int lifetime_ms = 2500;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--lifetime") == 0 && i + 1 < argc)
            lifetime_ms = atoi(argv[++i]);
        else if (strcmp(argv[i], "--layer") == 0 && i + 1 < argc)
            requested_layer = parseLayer(argv[++i]);
        else if (strcmp(argv[i], "--anchor") == 0 && i + 1 < argc)
            requested_anchor = (uint32_t)atoi(argv[++i]);
        else if (strcmp(argv[i], "--size") == 0 && i + 1 < argc) {
            if (sscanf(argv[++i], "%dx%d", &requested_w, &requested_h) != 2) {
                fprintf(stderr, "[client] bad --size\n"); return 2;
            }
        } else if (strcmp(argv[i], "--zone") == 0 && i + 1 < argc)
            requested_zone = atoi(argv[++i]);
        else if (strcmp(argv[i], "--kbd") == 0 && i + 1 < argc)
            requested_kbd = parseKbd(argv[++i]);
        else if (strcmp(argv[i], "--color") == 0 && i + 1 < argc) {
            uint32_t rgb = (uint32_t)strtoul(argv[++i], NULL, 16);
            fill_color = 0xFF000000u | rgb;
        }
    }
    if (!socket) { fprintf(stderr, "usage: %s --socket NAME [opts]\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);  // seat caps

    if (!compositor || !shm || !wm_base || !seat || !layer_shell) {
        fprintf(stderr, "[client] missing globals (compositor=%p shm=%p wm_base=%p seat=%p layer_shell=%p)\n",
                (void*)compositor, (void*)shm, (void*)wm_base, (void*)seat, (void*)layer_shell);
        return 1;
    }
    printf("[client] bound\n"); fflush(stdout);

    struct wl_surface* surface = wl_compositor_create_surface(compositor);
    struct zwlr_layer_surface_v1* ls = zwlr_layer_shell_v1_get_layer_surface(
        layer_shell, surface, NULL, requested_layer, "test-panel");
    zwlr_layer_surface_v1_add_listener(ls, &lsListener, NULL);
    zwlr_layer_surface_v1_set_size(ls, requested_w, requested_h);
    zwlr_layer_surface_v1_set_anchor(ls, requested_anchor);
    zwlr_layer_surface_v1_set_exclusive_zone(ls, requested_zone);
    zwlr_layer_surface_v1_set_keyboard_interactivity(ls, requested_kbd);

    // Initial commit (no buffer) to obtain the configure.
    wl_surface_commit(surface);
    for (int i = 0; i < 200 && !got_configure; ++i) {
        wl_display_roundtrip(display);
        usleep(5 * 1000);
    }
    if (!got_configure) { fprintf(stderr, "[client] no configure\n"); return 1; }

    // Allocate a buffer at the configured size and fill.
    int W = configured_w > 0 ? configured_w : (requested_w > 0 ? requested_w : 1);
    int H = configured_h > 0 ? configured_h : (requested_h > 0 ? requested_h : 1);
    int stride = W * 4;
    int poolSize = stride * H;
    if (poolSize < 4) poolSize = 4;
    int fd = memfd_create("ls-test", 0);
    if (ftruncate(fd, poolSize) < 0) {
        fprintf(stderr, "[client] ftruncate failed\n");
        return 1;
    }
    uint32_t* px = mmap(NULL, poolSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    for (int i = 0; i < W * H; ++i) px[i] = fill_color;
    munmap(px, poolSize);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, poolSize);
    struct wl_buffer* buf = wl_shm_pool_create_buffer(pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);

    wl_surface_attach(surface, buf, 0, 0);
    wl_surface_damage(surface, 0, 0, W, H);
    wl_surface_commit(surface);
    wl_display_roundtrip(display);
    wl_display_roundtrip(display);

    printf("[client] mapped\n"); fflush(stdout);

    // Stay alive for an upper bound (--lifetime overrides) while the
    // driver test injects input / exercises the compositor.
    const int STEP_MS = 20;
    for (int t = 0; t < lifetime_ms; t += STEP_MS) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        wl_display_roundtrip(display);
        usleep(STEP_MS * 1000);
    }

    zwlr_layer_surface_v1_destroy(ls);
    wl_buffer_destroy(buf);
    wl_shm_pool_destroy(pool);
    wl_surface_destroy(surface);
    if (keyboard) wl_keyboard_destroy(keyboard);
    wl_seat_destroy(seat);
    zwlr_layer_shell_v1_destroy(layer_shell);
    xdg_wm_base_destroy(wm_base);
    wl_shm_destroy(shm);
    wl_compositor_destroy(compositor);
    wl_display_disconnect(display);
    close(fd);
    printf("[client] done\n"); fflush(stdout);
    return 0;
}
