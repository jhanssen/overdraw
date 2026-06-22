// Minimal X11 client for the XWM test: connects to $DISPLAY, creates and maps
// a window, then stays alive briefly so the window manager can observe it
// (CreateNotify -> MapRequest -> MapNotify, and Xwayland's WL_SURFACE_SERIAL
// association). No rendering needed -- the association is independent of
// content.
//
// Usage: DISPLAY=:N x11-test-client

#include <stdint.h>
#include <stdio.h>
#include <unistd.h>

#include <xcb/xcb.h>

int main(void) {
    xcb_connection_t* c = xcb_connect(NULL, NULL);
    if (xcb_connection_has_error(c)) {
        fprintf(stderr, "[x11] connect failed\n");
        return 1;
    }
    xcb_screen_t* screen = xcb_setup_roots_iterator(xcb_get_setup(c)).data;
    if (!screen) {
        fprintf(stderr, "[x11] no screen\n");
        return 1;
    }

    xcb_window_t win = xcb_generate_id(c);
    uint32_t values[2] = { screen->white_pixel, XCB_EVENT_MASK_EXPOSURE };
    xcb_create_window(c, XCB_COPY_FROM_PARENT, win, screen->root,
                      0, 0, 200, 150, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT,
                      screen->root_visual, XCB_CW_BACK_PIXEL | XCB_CW_EVENT_MASK, values);
    xcb_map_window(c, win);
    xcb_flush(c);
    printf("[x11] mapped window 0x%x\n", win);

    // Stay alive long enough for the WM to observe + the test to assert.
    sleep(3);
    xcb_disconnect(c);
    return 0;
}
