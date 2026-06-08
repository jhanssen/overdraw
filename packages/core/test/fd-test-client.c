// Wayland client for the fd-passing path: bind wl_shm, create a memfd with a
// known marker written into it, and call wl_shm.create_pool(fd, size). The
// server-side handler receives the fd (as a handle), takes the raw fd, and
// reads the marker back -- proving fd decode + dup + the handle table.
//
// Usage: fd-test-client <socket-name>

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
    (void)data;
    if (strcmp(iface, "wl_shm") == 0) {
        shm = wl_registry_bind(reg, name, &wl_shm_interface, version < 1 ? version : 1);
        wl_shm_add_listener(shm, &shmListener, NULL);
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) {
    (void)data; (void)reg; (void)name;
}
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <socket>\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }
    printf("[client] connected to %s\n", argv[1]);

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);  // receive globals

    if (!shm) { fprintf(stderr, "[client] no wl_shm\n"); return 1; }

    // Build a memfd with a known marker.
    const char marker[] = "OVERDRAW_FD_OK";
    int size = 4096;
    int fd = memfd_create("overdraw-fd-test", 0);
    if (fd < 0) { perror("memfd_create"); return 1; }
    if (ftruncate(fd, size) != 0) { perror("ftruncate"); return 1; }
    void* p = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (p == MAP_FAILED) { perror("mmap"); return 1; }
    memcpy(p, marker, sizeof(marker));
    munmap(p, size);

    printf("[client] create_pool with fd, size=%d\n", size);
    struct wl_shm_pool* pool = wl_shm_create_pool(shm, fd, size);
    wl_display_roundtrip(display);  // flush the create_pool request (carries the fd)
    wl_display_roundtrip(display);  // give the server a beat to process

    close(fd);  // client closes its copy; the server dup'd its own
    wl_shm_pool_destroy(pool);
    wl_shm_destroy(shm);
    wl_display_disconnect(display);
    printf("[client] done\n");
    return 0;
}
