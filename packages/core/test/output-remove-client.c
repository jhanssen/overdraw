// Per-output global removal test client. Binds the advertised wl_output,
// then waits for the server to remove that global (wl_registry.global_remove)
// and reacts the way a well-behaved client does: sends wl_output.release --
// a request on a resource whose global is already gone, dispatched through
// the trampoline's parked InterfaceState. A subsequent roundtrip proves the
// server survived and the connection carries no protocol error.
//
// Usage: output-remove-client <socket-name>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <wayland-client.h>

static struct wl_output* output = NULL;
static uint32_t outputName = 0;
static int removed = 0;

static void regGlobal(void* data, struct wl_registry* reg, uint32_t name,
                      const char* iface, uint32_t version) {
    (void)data;
    if (strcmp(iface, "wl_output") == 0 && !output) {
        if (version < 3) { fprintf(stderr, "[client] wl_output v%u < 3, no release\n", version); exit(1); }
        output = wl_registry_bind(reg, name, &wl_output_interface, 3);
        outputName = name;
    }
}
static void regRemove(void* data, struct wl_registry* reg, uint32_t name) {
    (void)data; (void)reg;
    if (output && name == outputName) removed = 1;
}
static const struct wl_registry_listener regListener = { regGlobal, regRemove };

int main(int argc, char** argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <socket>\n", argv[0]); return 2; }

    struct wl_display* display = wl_display_connect(argv[1]);
    if (!display) { fprintf(stderr, "[client] connect failed\n"); return 1; }

    struct wl_registry* registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &regListener, NULL);
    wl_display_roundtrip(display);
    if (!output) { fprintf(stderr, "[client] no wl_output\n"); return 1; }
    printf("[client] bound wl_output name=%u\n", outputName);

    // The server removes the global once it has seen our bind; block until
    // the global_remove arrives.
    while (!removed) {
        if (wl_display_dispatch(display) == -1) {
            fprintf(stderr, "[client] dispatch failed waiting for global_remove\n");
            return 1;
        }
    }
    printf("[client] observed global_remove\n");

    // The request the protocol asks for at this point -- and the one that
    // must not crash the server: the resource's global is gone.
    wl_output_release(output);
    if (wl_display_roundtrip(display) == -1) {
        fprintf(stderr, "[client] roundtrip after release failed (error=%d)\n",
                wl_display_get_error(display));
        return 1;
    }
    printf("[client] released, server alive\n");

    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return 0;
}
