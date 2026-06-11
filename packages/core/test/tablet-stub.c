// Link stub: the wp_cursor_shape_v1 client glue references
// zwp_tablet_tool_v2_interface (because the manager has get_tablet_tool_v2).
// Test clients that only exercise the pointer path don't need the tablet
// protocol; ship an empty wl_interface so the link resolves.
#include <wayland-client.h>

const struct wl_interface zwp_tablet_tool_v2_interface = {
    .name = "zwp_tablet_tool_v2",
    .version = 2,
    .method_count = 0,
    .methods = NULL,
    .event_count = 0,
    .events = NULL,
};
