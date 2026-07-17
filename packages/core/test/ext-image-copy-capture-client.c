// ext_image_copy_capture_v1 test client.
//
// One-shot capture of either an output or a foreign toplevel into an shm
// buffer. Prints metadata + a few sampled pixels so the harness can assert
// the captured content matches expectations.
//
// Usage:
//   --socket NAME           compositor socket
//   --mode output|toplevel  which source factory to use (default output)
//   --pick INDEX            for --mode toplevel: index into the ftl list
//                           (0 = first; default 0)
//   --timeout-ms N          give up + return 1 if no ready/failed (default 5000)
//   --dump-prefix PREFIX    optional: write captured BGRA pixels to PREFIX.raw
//   --capture-on-stdin      after printing constraints, wait for a byte on
//                           stdin (or EOF) before issuing the capture; lets
//                           the harness change compositor state at a known
//                           point between session setup and frame capture

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <sys/mman.h>
#include <fcntl.h>

#include <wayland-client.h>
#include "ext-image-capture-source-v1-client-protocol.h"
#include "ext-image-copy-capture-v1-client-protocol.h"
#include "ext-foreign-toplevel-list-v1-client-protocol.h"

static struct wl_shm* shm = NULL;
static struct wl_output* output = NULL;
static struct ext_output_image_capture_source_manager_v1* out_src_mgr = NULL;
static struct ext_foreign_toplevel_image_capture_source_manager_v1* tl_src_mgr = NULL;
static struct ext_image_copy_capture_manager_v1* capture_mgr = NULL;
static struct ext_foreign_toplevel_list_v1* ftl_list = NULL;

static volatile sig_atomic_t running = 1;
static void onTerm(int sig) { (void)sig; running = 0; }

static int g_timeoutMs = 5000;
static const char* g_dumpPrefix = NULL;
static const char* g_mode = "output";
static int g_pick = 0;
static int g_captureOnStdin = 0;

// Toplevel handles collected via ext_foreign_toplevel_list_v1.
struct ToplevelEntry {
    struct ext_foreign_toplevel_handle_v1* handle;
    char* app_id;
};
#define MAX_TL 16
static struct ToplevelEntry g_toplevels[MAX_TL];
static int g_toplevelCount = 0;

// Session/frame state.
static struct ext_image_copy_capture_session_v1* session = NULL;
static struct ext_image_copy_capture_frame_v1* frame = NULL;
static uint32_t g_bufW = 0, g_bufH = 0;
static uint32_t g_shmFormat = 0;
static int g_haveShmFormat = 0;
static int g_done = 0;          // session.done received
static int g_ready = 0;
static int g_failed = 0;
static uint32_t g_failReason = 0;
static uint32_t g_pres_tv_sec_lo = 0, g_pres_tv_nsec = 0;
static uint32_t g_dmg_w = 0, g_dmg_h = 0;

// shm buffer.
static int g_fd = -1;
static uint8_t* g_pixels = NULL;
static size_t g_mapSize = 0;
static struct wl_buffer* g_buffer = NULL;

// ---- ftl listeners (used in toplevel mode to pick a handle) ----
static void ftlHandleIdentifier(void* d, struct ext_foreign_toplevel_handle_v1* h, const char* id) {
    (void)d;(void)h;(void)id;
}
static void ftlHandleAppId(void* d, struct ext_foreign_toplevel_handle_v1* h, const char* a) {
    (void)d;
    for (int i = 0; i < g_toplevelCount; i++) {
        if (g_toplevels[i].handle == h) {
            free(g_toplevels[i].app_id);
            g_toplevels[i].app_id = strdup(a);
            return;
        }
    }
}
static void ftlHandleTitle(void* d, struct ext_foreign_toplevel_handle_v1* h, const char* tt) {
    (void)d;(void)h;(void)tt;
}
static void ftlHandleDone(void* d, struct ext_foreign_toplevel_handle_v1* h) {
    (void)d;(void)h;
}
static void ftlHandleClosed(void* d, struct ext_foreign_toplevel_handle_v1* h) {
    (void)d;(void)h;
}
static const struct ext_foreign_toplevel_handle_v1_listener ftlHandleListener = {
    ftlHandleClosed, ftlHandleDone, ftlHandleTitle, ftlHandleAppId, ftlHandleIdentifier,
};
static void ftlListToplevel(void* d, struct ext_foreign_toplevel_list_v1* l,
                             struct ext_foreign_toplevel_handle_v1* tl) {
    (void)d;(void)l;
    if (g_toplevelCount >= MAX_TL) { ext_foreign_toplevel_handle_v1_destroy(tl); return; }
    g_toplevels[g_toplevelCount].handle = tl;
    g_toplevels[g_toplevelCount].app_id = NULL;
    g_toplevelCount++;
    ext_foreign_toplevel_handle_v1_add_listener(tl, &ftlHandleListener, NULL);
}
static void ftlListFinished(void* d, struct ext_foreign_toplevel_list_v1* l) {
    (void)d;(void)l;
}
static const struct ext_foreign_toplevel_list_v1_listener ftlListListener = {
    ftlListToplevel, ftlListFinished,
};

// ---- session listeners ----
static void sBufferSize(void* d, struct ext_image_copy_capture_session_v1* s,
                        uint32_t w, uint32_t h) {
    (void)d;(void)s;
    g_bufW = w; g_bufH = h;
}
static void sShmFormat(void* d, struct ext_image_copy_capture_session_v1* s, uint32_t fmt) {
    (void)d;(void)s;
    // Prefer XRGB8888 (1) if both are advertised; first one wins otherwise.
    if (!g_haveShmFormat || fmt == 1) {
        g_shmFormat = fmt;
        g_haveShmFormat = 1;
    }
}
static void sDmabufDevice(void* d, struct ext_image_copy_capture_session_v1* s, struct wl_array* a) {
    (void)d;(void)s;(void)a;
}
static void sDmabufFormat(void* d, struct ext_image_copy_capture_session_v1* s,
                          uint32_t fmt, struct wl_array* mods) {
    (void)d;(void)s;(void)fmt;(void)mods;
}
static void sDone(void* d, struct ext_image_copy_capture_session_v1* s) {
    (void)d;(void)s;
    g_done = 1;
}
static void sStopped(void* d, struct ext_image_copy_capture_session_v1* s) {
    (void)d;(void)s;
    printf("[ext-icc-client] session.stopped\n");
    fflush(stdout);
    running = 0;
}
static const struct ext_image_copy_capture_session_v1_listener sListener = {
    sBufferSize, sShmFormat, sDmabufDevice, sDmabufFormat, sDone, sStopped,
};

// ---- frame listeners ----
static void fTransform(void* d, struct ext_image_copy_capture_frame_v1* f, uint32_t t) {
    (void)d;(void)f;(void)t;
}
static void fDamage(void* d, struct ext_image_copy_capture_frame_v1* f,
                    int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)d;(void)f;(void)x;(void)y;
    g_dmg_w = (uint32_t)w; g_dmg_h = (uint32_t)h;
}
static void fPresentationTime(void* d, struct ext_image_copy_capture_frame_v1* f,
                              uint32_t tv_sec_hi, uint32_t tv_sec_lo, uint32_t tv_nsec) {
    (void)d;(void)f;(void)tv_sec_hi;
    g_pres_tv_sec_lo = tv_sec_lo; g_pres_tv_nsec = tv_nsec;
}
static void fReady(void* d, struct ext_image_copy_capture_frame_v1* f) {
    (void)d;(void)f;
    g_ready = 1;
}
static void fFailed(void* d, struct ext_image_copy_capture_frame_v1* f, uint32_t reason) {
    (void)d;(void)f;
    g_failed = 1;
    g_failReason = reason;
}
static const struct ext_image_copy_capture_frame_v1_listener fListener = {
    fTransform, fDamage, fPresentationTime, fReady, fFailed,
};

// ---- registry ----
static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data; (void)version;
    if (strcmp(iface, "wl_shm") == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
    else if (strcmp(iface, "wl_output") == 0 && output == NULL)
        output = wl_registry_bind(reg, name, &wl_output_interface, version < 4 ? version : 4);
    else if (strcmp(iface, "ext_output_image_capture_source_manager_v1") == 0)
        out_src_mgr = wl_registry_bind(reg, name,
            &ext_output_image_capture_source_manager_v1_interface, 1);
    else if (strcmp(iface, "ext_foreign_toplevel_image_capture_source_manager_v1") == 0)
        tl_src_mgr = wl_registry_bind(reg, name,
            &ext_foreign_toplevel_image_capture_source_manager_v1_interface, 1);
    else if (strcmp(iface, "ext_image_copy_capture_manager_v1") == 0)
        capture_mgr = wl_registry_bind(reg, name,
            &ext_image_copy_capture_manager_v1_interface, 1);
    else if (strcmp(iface, "ext_foreign_toplevel_list_v1") == 0)
        ftl_list = wl_registry_bind(reg, name, &ext_foreign_toplevel_list_v1_interface, 1);
}
static void regRemove(void* d, struct wl_registry* r, uint32_t n) { (void)d;(void)r;(void)n; }
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

static int allocBuffer(uint32_t W, uint32_t H) {
    uint32_t stride = W * 4;
    size_t sz = (size_t)stride * H;
    int fd = memfd_create("icc-cap", 0);
    if (fd < 0) return -1;
    if (ftruncate(fd, (off_t)sz) != 0) { close(fd); return -1; }
    uint8_t* p = mmap(NULL, sz, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) { close(fd); return -1; }
    // Initialize to a sentinel color (0xAA) so we can tell if the compositor
    // actually wrote into it.
    memset(p, 0xAA, sz);
    g_fd = fd; g_pixels = p; g_mapSize = sz;
    uint32_t shm_format = (g_shmFormat == 1)
        ? (uint32_t)WL_SHM_FORMAT_XRGB8888
        : (uint32_t)WL_SHM_FORMAT_ARGB8888;
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, (int32_t)sz);
    g_buffer = wl_shm_pool_create_buffer(pool, 0, (int32_t)W, (int32_t)H,
                                         (int32_t)stride, shm_format);
    wl_shm_pool_destroy(pool);
    return 0;
}

int main(int argc, char** argv) {
    const char* socket = NULL;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) socket = argv[++i];
        else if (strcmp(argv[i], "--mode") == 0 && i + 1 < argc) g_mode = argv[++i];
        else if (strcmp(argv[i], "--pick") == 0 && i + 1 < argc) g_pick = atoi(argv[++i]);
        else if (strcmp(argv[i], "--timeout-ms") == 0 && i + 1 < argc) g_timeoutMs = atoi(argv[++i]);
        else if (strcmp(argv[i], "--dump-prefix") == 0 && i + 1 < argc) g_dumpPrefix = argv[++i];
        else if (strcmp(argv[i], "--capture-on-stdin") == 0) g_captureOnStdin = 1;
    }
    if (!socket) {
        fprintf(stderr, "usage: %s --socket NAME [--mode output|toplevel] [--pick N] [--timeout-ms N] [--dump-prefix P]\n",
                argv[0]);
        return 2;
    }
    signal(SIGTERM, onTerm);
    signal(SIGINT, onTerm);

    struct wl_display* display = wl_display_connect(socket);
    if (!display) { fprintf(stderr, "[ext-icc-client] connect failed\n"); return 1; }
    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    if (!shm || !capture_mgr) {
        fprintf(stderr, "[ext-icc-client] missing required globals (shm=%p capture_mgr=%p)\n",
                (void*)shm, (void*)capture_mgr);
        return 1;
    }
    if (strcmp(g_mode, "output") == 0 && !out_src_mgr) {
        fprintf(stderr, "[ext-icc-client] no ext_output_image_capture_source_manager_v1\n");
        return 1;
    }
    if (strcmp(g_mode, "toplevel") == 0 && (!tl_src_mgr || !ftl_list)) {
        fprintf(stderr, "[ext-icc-client] no toplevel capture infra\n");
        return 1;
    }

    // Build the source.
    struct ext_image_capture_source_v1* source = NULL;
    if (strcmp(g_mode, "output") == 0) {
        if (!output) {
            fprintf(stderr, "[ext-icc-client] no wl_output\n");
            return 1;
        }
        source = ext_output_image_capture_source_manager_v1_create_source(out_src_mgr, output);
    } else {
        // Listen for toplevels.
        ext_foreign_toplevel_list_v1_add_listener(ftl_list, &ftlListListener, NULL);
        wl_display_roundtrip(display);
        wl_display_roundtrip(display);  // catch the .done burst per handle
        if (g_pick < 0 || g_pick >= g_toplevelCount) {
            fprintf(stderr, "[ext-icc-client] pick=%d out of range (have %d toplevels)\n",
                    g_pick, g_toplevelCount);
            return 1;
        }
        source = ext_foreign_toplevel_image_capture_source_manager_v1_create_source(
            tl_src_mgr, g_toplevels[g_pick].handle);
    }

    // Create the session.
    session = ext_image_copy_capture_manager_v1_create_session(capture_mgr, source, 0);
    ext_image_copy_capture_session_v1_add_listener(session, &sListener, NULL);

    printf("[ext-icc-client] ready\n");
    fflush(stdout);

    // Wait for constraints (buffer_size + at least one shm_format + done).
    int wlfd = wl_display_get_fd(display);
    long elapsedMs = 0;
    while (running && !g_done && elapsedMs < g_timeoutMs) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd p = { wlfd, POLLIN, 0 };
        if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
        elapsedMs += 16;
    }
    if (!g_done) {
        fprintf(stderr, "[ext-icc-client] timed out waiting for session.done\n");
        return 1;
    }
    if (g_bufW == 0 || g_bufH == 0 || !g_haveShmFormat) {
        fprintf(stderr, "[ext-icc-client] no usable constraints (w=%u h=%u shm=%d)\n",
                g_bufW, g_bufH, g_haveShmFormat);
        return 1;
    }
    printf("[ext-icc-client] constraints w=%u h=%u shm_format=%u\n",
           g_bufW, g_bufH, g_shmFormat);
    fflush(stdout);

    if (allocBuffer(g_bufW, g_bufH) != 0) {
        fprintf(stderr, "[ext-icc-client] buffer alloc failed\n");
        return 1;
    }

    if (g_captureOnStdin) {
        // Hold the capture until the harness writes a byte (or closes our
        // stdin), dispatching wayland events meanwhile so a session.stopped
        // arriving during the wait is observed before we capture.
        int gated = 1;
        while (running && gated) {
            wl_display_dispatch_pending(display);
            wl_display_flush(display);
            struct pollfd ps[2] = { { wlfd, POLLIN, 0 }, { 0, POLLIN, 0 } };
            if (poll(ps, 2, 16) > 0) {
                if (ps[0].revents & POLLIN) {
                    if (wl_display_dispatch(display) < 0) break;
                }
                if (ps[1].revents & (POLLIN | POLLHUP)) gated = 0;
            }
        }
        if (!running) {
            // Session stopped before the capture was released.
            printf("[ext-icc-client] done ok=0 wrote=0 w=%u h=%u\n", g_bufW, g_bufH);
            fflush(stdout);
            return 1;
        }
    }

    // Create a frame, attach the buffer, capture.
    frame = ext_image_copy_capture_session_v1_create_frame(session);
    ext_image_copy_capture_frame_v1_add_listener(frame, &fListener, NULL);
    ext_image_copy_capture_frame_v1_attach_buffer(frame, g_buffer);
    ext_image_copy_capture_frame_v1_damage_buffer(frame, 0, 0,
                                                  (int32_t)g_bufW, (int32_t)g_bufH);
    ext_image_copy_capture_frame_v1_capture(frame);

    // Wait for ready or failed.
    elapsedMs = 0;
    while (running && !g_ready && !g_failed && elapsedMs < g_timeoutMs) {
        wl_display_dispatch_pending(display);
        wl_display_flush(display);
        struct pollfd p = { wlfd, POLLIN, 0 };
        if (poll(&p, 1, 16) > 0 && (p.revents & POLLIN)) {
            if (wl_display_dispatch(display) < 0) break;
        }
        elapsedMs += 16;
    }

    if (g_failed) {
        printf("[ext-icc-client] failed reason=%u\n", g_failReason);
        fflush(stdout);
        printf("[ext-icc-client] done ok=0 wrote=0 w=%u h=%u\n", g_bufW, g_bufH);
        fflush(stdout);
        return 1;
    }
    if (!g_ready) {
        fprintf(stderr, "[ext-icc-client] timed out waiting for ready\n");
        printf("[ext-icc-client] done ok=0 wrote=0 w=%u h=%u\n", g_bufW, g_bufH);
        fflush(stdout);
        return 1;
    }

    // Sample some pixels. The buffer is BGRA-byte-order on LE
    // (ARGB8888/XRGB8888 are little-endian-byte-order names; on the
    // wire they're [B,G,R,A] in memory).
    uint32_t stride = g_bufW * 4;
    uint32_t cx = g_bufW / 2, cy = g_bufH / 2;
    uint8_t* px = g_pixels + cy * stride + cx * 4;
    printf("[ext-icc-client] ready damage=%ux%u pres_tv_sec_lo=%u pres_tv_nsec=%u "
           "center_bgra=%02x,%02x,%02x,%02x\n",
           g_dmg_w, g_dmg_h, g_pres_tv_sec_lo, g_pres_tv_nsec,
           px[0], px[1], px[2], px[3]);

    // Confirm we wrote SOMETHING (not the 0xAA sentinel everywhere).
    int wrote = 0;
    for (size_t i = 0; i < g_mapSize; i += 4096) {
        if (g_pixels[i] != 0xAA) { wrote = 1; break; }
    }

    if (g_dumpPrefix) {
        char path[1024];
        snprintf(path, sizeof(path), "%s.raw", g_dumpPrefix);
        FILE* f = fopen(path, "wb");
        if (f) {
            fwrite(g_pixels, 1, g_mapSize, f);
            fclose(f);
        }
    }

    printf("[ext-icc-client] done ok=%d wrote=%d w=%u h=%u\n",
           wrote ? 1 : 0, wrote, g_bufW, g_bufH);
    fflush(stdout);
    wl_display_disconnect(display);
    return wrote ? 0 : 1;
}
