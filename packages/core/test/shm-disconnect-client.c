// Wayland client that creates N wl_shm pools (each with a buffer carved from it)
// and then DISCONNECTS without destroying any of them. This exercises the
// compositor's disconnect sweep for shm pools + buffer refs: the destroy
// handlers never run, so the sweep must free each pool's mmap + dup'd fd.
//
// Usage: shm-disconnect-client <socket-name> [count]

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#include <wayland-client.h>

static struct wl_shm* shm = NULL;

static void shmFormat(void* d, struct wl_shm* s, uint32_t fmt) { (void)d;(void)s;(void)fmt; }
static const struct wl_shm_listener shmListener = { shmFormat };

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data; (void)name; (void)version;
    if (strcmp(iface, "wl_shm") == 0)
        shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) {
    (void)data; (void)reg; (void)name;
}
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <socket> [count]\n", argv[0]); return 2; }
    int count = argc >= 3 ? atoi(argv[2]) : 8;

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[shmdc] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // receive globals
    if (!shm) { fprintf(stderr, "[shmdc] no wl_shm\n"); return 1; }

    const int W = 64, H = 64, stride = W * 4, size = stride * H;
    for (int i = 0; i < count; ++i) {
        int fd = memfd_create("overdraw-shmdc", 0);
        if (fd < 0) { perror("memfd_create"); return 1; }
        if (ftruncate(fd, size) != 0) { perror("ftruncate"); return 1; }
        struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, size);
        // Carve a buffer so the pool gets a buffer ref (the disconnect sweep must
        // release it before the pool can free).
        struct wl_buffer* buf = wl_shm_pool_create_buffer(
            pool, 0, W, H, stride, WL_SHM_FORMAT_ARGB8888);
        (void)buf;
        wl_display_roundtrip(display);  // flush create_pool (carries fd) + create_buffer
        close(fd);                      // client drops its copy; server keeps its own
        // Intentionally DO NOT destroy pool or buffer.
    }
    printf("[shmdc] created %d pools\n", count);
    // Disconnect without destroying anything -> server disconnect sweep must
    // reclaim every pool.
    wl_display_disconnect(display);
    return 0;
}
