// X11 test client for the XWM test: connects to $DISPLAY, creates and maps a
// window with ICCCM/EWMH properties (title, app_id, WM_DELETE_WINDOW), then
// loops on events. The window stays alive until either:
//   - the WM sends WM_DELETE_WINDOW (the XWM close path), at which point the
//     client exits cleanly with status 0, or
//   - --timeout-ms expires (a safety net for tests that don't trigger a close).
//
// CLI:
//   --title <s>      Set both _NET_WM_NAME (UTF-8) and WM_NAME (Latin-1).
//   --app-id <s>     Set WM_CLASS instance/class to <s>.
//   --timeout-ms <n> Safety upper bound (default 5000).
//   --startup-id <s> Set _NET_STARTUP_ID to <s> on the window.
//   --probe-wm       After mapping, read root's _NET_SUPPORTING_WM_CHECK
//                    and that child's _NET_WM_NAME + self-pointer; print
//                    one line per result for the harness to assert on.
//   --probe-wm-state After mapping, read this window's WM_STATE and print
//                    "[x11] wm-state state=<N> icon=0x<W>" once.
//   --probe-net-supported After mapping, read _NET_SUPPORTED on the root
//                    and print "[x11] net-supported count=<N>".
//
// Prints "[x11] mapped 0x<window>" on map and "[x11] deleted" on
// WM_DELETE_WINDOW receipt.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <poll.h>

#include <xcb/xcb.h>

static xcb_atom_t intern(xcb_connection_t* c, const char* name) {
    xcb_intern_atom_cookie_t k = xcb_intern_atom(c, 0, (uint16_t)strlen(name), name);
    xcb_intern_atom_reply_t* r = xcb_intern_atom_reply(c, k, NULL);
    xcb_atom_t a = r ? r->atom : 0;
    free(r);
    return a;
}

int main(int argc, char** argv) {
    const char* title = "overdraw test";
    const char* appId = "x11-test-client";
    const char* startupId = NULL;
    int probeWm = 0;
    int probeWmState = 0;
    int probeNetSupported = 0;
    int timeoutMs = 5000;
    int overrideRedirect = 0;
    int x = 0, y = 0, w = 200, h = 150;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--title") && i + 1 < argc) { title = argv[++i]; }
        else if (!strcmp(argv[i], "--app-id") && i + 1 < argc) { appId = argv[++i]; }
        else if (!strcmp(argv[i], "--startup-id") && i + 1 < argc) { startupId = argv[++i]; }
        else if (!strcmp(argv[i], "--probe-wm")) { probeWm = 1; }
        else if (!strcmp(argv[i], "--probe-wm-state")) { probeWmState = 1; }
        else if (!strcmp(argv[i], "--probe-net-supported")) { probeNetSupported = 1; }
        else if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) {
            timeoutMs = atoi(argv[++i]);
        }
        else if (!strcmp(argv[i], "--override-redirect")) { overrideRedirect = 1; }
        else if (!strcmp(argv[i], "--x") && i + 1 < argc) { x = atoi(argv[++i]); }
        else if (!strcmp(argv[i], "--y") && i + 1 < argc) { y = atoi(argv[++i]); }
        else if (!strcmp(argv[i], "--w") && i + 1 < argc) { w = atoi(argv[++i]); }
        else if (!strcmp(argv[i], "--h") && i + 1 < argc) { h = atoi(argv[++i]); }
    }

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
    // Override-redirect: CWOverrideRedirect=True tells the X server to bypass
    // the WM for this window. Used by menus / tooltips / DnD icons.
    // CW values must be supplied in CW bit-position order: BACK_PIXEL (2),
    // OVERRIDE_REDIRECT (512), EVENT_MASK (2048).
    uint32_t valuesMask = XCB_CW_BACK_PIXEL | XCB_CW_EVENT_MASK;
    uint32_t values[3];
    int vi = 0;
    values[vi++] = screen->white_pixel;
    if (overrideRedirect) {
        valuesMask |= XCB_CW_OVERRIDE_REDIRECT;
        values[vi++] = 1;
    }
    values[vi++] = XCB_EVENT_MASK_EXPOSURE;
    xcb_create_window(c, XCB_COPY_FROM_PARENT, win, screen->root,
                      x, y, w, h, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT,
                      screen->root_visual, valuesMask, values);

    // WM_CLASS: "<instance>\0<class>\0". Many WMs treat the second as app_id;
    // overdraw's parseWmClass picks the second too.
    char wmClass[256];
    size_t n0 = strlen(appId);
    if (n0 > 100) n0 = 100;
    memcpy(wmClass, appId, n0); wmClass[n0] = 0;
    memcpy(wmClass + n0 + 1, appId, n0); wmClass[n0 + 1 + n0] = 0;
    const size_t wmClassLen = n0 + 1 + n0 + 1;

    const xcb_atom_t WM_NAME = intern(c, "WM_NAME");
    const xcb_atom_t WM_CLASS = intern(c, "WM_CLASS");
    const xcb_atom_t WM_PROTOCOLS = intern(c, "WM_PROTOCOLS");
    const xcb_atom_t WM_DELETE_WINDOW = intern(c, "WM_DELETE_WINDOW");
    const xcb_atom_t NET_WM_NAME = intern(c, "_NET_WM_NAME");
    const xcb_atom_t UTF8_STRING = intern(c, "UTF8_STRING");
    const xcb_atom_t NET_WM_PID = intern(c, "_NET_WM_PID");

    // _NET_WM_NAME (UTF-8) -- the modern title; titleAppId reads this first.
    xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, NET_WM_NAME, UTF8_STRING, 8,
                        (uint32_t)strlen(title), title);
    // WM_NAME (Latin-1) -- fallback for non-EWMH WMs.
    xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, WM_NAME, XCB_ATOM_STRING, 8,
                        (uint32_t)strlen(title), title);
    // WM_CLASS (instance\0class\0).
    xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, WM_CLASS, XCB_ATOM_STRING, 8,
                        (uint32_t)wmClassLen, wmClass);
    // WM_PROTOCOLS: opt in to the ICCCM close path AND advertise that we
    // accept WM_TAKE_FOCUS (the locally-active input model). The test
    // harness sets focus via applyKeyboardFocus and expects both signals.
    const xcb_atom_t WM_TAKE_FOCUS = intern(c, "WM_TAKE_FOCUS");
    xcb_atom_t protocols[2] = { WM_DELETE_WINDOW, WM_TAKE_FOCUS };
    xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, WM_PROTOCOLS, 4 /*ATOM*/, 32,
                        2, protocols);
    // _NET_WM_PID: tell the WM our process id so the same-PID exception
    // for focus stealing can match two windows from the same client.
    const uint32_t mypid = (uint32_t)getpid();
    xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, NET_WM_PID, 6 /*CARDINAL*/, 32,
                        1, &mypid);
    // _NET_STARTUP_ID (opt-in via --startup-id): an opaque ASCII id the
    // launcher set on the window for activation correlation.
    if (startupId) {
        const xcb_atom_t NET_STARTUP_ID = intern(c, "_NET_STARTUP_ID");
        xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, NET_STARTUP_ID,
                            XCB_ATOM_STRING, 8,
                            (uint32_t)strlen(startupId), startupId);
    }

    xcb_map_window(c, win);
    xcb_flush(c);
    printf("[x11] mapped 0x%x\n", win);
    fflush(stdout);

    // --probe-wm: read _NET_SUPPORTING_WM_CHECK on the root and on the
    // child it names; verify _NET_WM_NAME on the child and that the child's
    // own _NET_SUPPORTING_WM_CHECK points at itself.
    if (probeWm) {
        const xcb_atom_t NET_SUPPORTING_WM_CHECK = intern(c, "_NET_SUPPORTING_WM_CHECK");
        xcb_get_property_cookie_t kRoot = xcb_get_property(c, 0, screen->root,
            NET_SUPPORTING_WM_CHECK, 33 /*WINDOW*/, 0, 1);
        xcb_get_property_reply_t* rRoot = xcb_get_property_reply(c, kRoot, NULL);
        xcb_window_t child = 0;
        if (rRoot && rRoot->format == 32 && xcb_get_property_value_length(rRoot) >= 4) {
            child = *(uint32_t*)xcb_get_property_value(rRoot);
        }
        printf("[x11] wm-check root child=0x%x\n", child);
        free(rRoot);
        if (child) {
            xcb_get_property_cookie_t kSelf = xcb_get_property(c, 0, child,
                NET_SUPPORTING_WM_CHECK, 33 /*WINDOW*/, 0, 1);
            xcb_get_property_reply_t* rSelf = xcb_get_property_reply(c, kSelf, NULL);
            xcb_window_t selfPtr = 0;
            if (rSelf && rSelf->format == 32 && xcb_get_property_value_length(rSelf) >= 4) {
                selfPtr = *(uint32_t*)xcb_get_property_value(rSelf);
            }
            printf("[x11] wm-check child self=0x%x\n", selfPtr);
            free(rSelf);
            xcb_get_property_cookie_t kName = xcb_get_property(c, 0, child,
                NET_WM_NAME, UTF8_STRING, 0, 256);
            xcb_get_property_reply_t* rName = xcb_get_property_reply(c, kName, NULL);
            if (rName && rName->format == 8) {
                int len = xcb_get_property_value_length(rName);
                printf("[x11] wm-name child='%.*s'\n",
                       len, (const char*)xcb_get_property_value(rName));
            }
            free(rName);
        }
        fflush(stdout);
    }

    // --probe-net-supported: count the atoms in _NET_SUPPORTED on the root.
    if (probeNetSupported) {
        const xcb_atom_t NET_SUPPORTED = intern(c, "_NET_SUPPORTED");
        xcb_get_property_cookie_t k = xcb_get_property(c, 0, screen->root,
            NET_SUPPORTED, 4 /*ATOM*/, 0, 256);
        xcb_get_property_reply_t* r = xcb_get_property_reply(c, k, NULL);
        int count = 0;
        if (r && r->format == 32) count = xcb_get_property_value_length(r) / 4;
        printf("[x11] net-supported count=%d\n", count);
        free(r);
        fflush(stdout);
    }

    // We need to observe ConfigureNotify events (both real and synthetic),
    // FocusIn/FocusOut (so focus-mirror tests can see the WM landing focus
    // on us). StructureNotify gives ConfigureNotify; FOCUS_CHANGE gives the
    // focus events.
    {
        const uint32_t mask = XCB_EVENT_MASK_EXPOSURE
                            | XCB_EVENT_MASK_STRUCTURE_NOTIFY
                            | XCB_EVENT_MASK_FOCUS_CHANGE;
        xcb_change_window_attributes(c, win, XCB_CW_EVENT_MASK, &mask);
        xcb_flush(c);
    }

    // Event loop. Exit on WM_DELETE_WINDOW or after the safety timeout.
    // Print every ConfigureNotify so tests can read the WM-chosen rect.
    const int fd = xcb_get_file_descriptor(c);
    const long deadlineMs = timeoutMs;
    long elapsedMs = 0;
    const int stepMs = 50;
    xcb_atom_t WM_STATE = 0;
    int wmStateReported = 0;
    if (probeWmState) WM_STATE = intern(c, "WM_STATE");
    for (;;) {
        // --probe-wm-state: poll WM_STATE on this window every tick until
        // it appears (the WM sets NormalState after taking us over).
        if (probeWmState && !wmStateReported) {
            xcb_get_property_cookie_t k = xcb_get_property(c, 0, win,
                WM_STATE, WM_STATE, 0, 2);
            xcb_get_property_reply_t* r = xcb_get_property_reply(c, k, NULL);
            if (r && r->format == 32 && xcb_get_property_value_length(r) >= 8) {
                const uint32_t* v = (const uint32_t*)xcb_get_property_value(r);
                printf("[x11] wm-state state=%u icon=0x%x\n", v[0], v[1]);
                fflush(stdout);
                wmStateReported = 1;
            }
            free(r);
        }
        if (elapsedMs >= deadlineMs) break;
        struct pollfd p = { .fd = fd, .events = POLLIN };
        poll(&p, 1, stepMs);
        elapsedMs += stepMs;
        xcb_generic_event_t* ev;
        while ((ev = xcb_poll_for_event(c))) {
            const uint8_t type = ev->response_type & 0x7f;
            // Top bit of response_type distinguishes synthetic from real.
            const int synthetic = (ev->response_type & 0x80) != 0;
            if (type == XCB_CONFIGURE_NOTIFY) {
                xcb_configure_notify_event_t* cn = (xcb_configure_notify_event_t*)ev;
                printf("[x11] configure %s x=%d y=%d w=%u h=%u\n",
                       synthetic ? "synthetic" : "real",
                       cn->x, cn->y, cn->width, cn->height);
                fflush(stdout);
            } else if (type == XCB_FOCUS_IN) {
                printf("[x11] focused\n");
                fflush(stdout);
            } else if (type == XCB_FOCUS_OUT) {
                printf("[x11] unfocused\n");
                fflush(stdout);
            } else if (type == XCB_CLIENT_MESSAGE) {
                xcb_client_message_event_t* cm = (xcb_client_message_event_t*)ev;
                if (cm->type == WM_PROTOCOLS
                    && cm->data.data32[0] == WM_DELETE_WINDOW) {
                    printf("[x11] deleted\n");
                    fflush(stdout);
                    free(ev);
                    xcb_disconnect(c);
                    return 0;
                }
                if (cm->type == WM_PROTOCOLS
                    && cm->data.data32[0] == WM_TAKE_FOCUS) {
                    // ICCCM locally-active: take the focus the WM offered.
                    // For tests, just print so the harness can assert.
                    printf("[x11] take-focus\n");
                    fflush(stdout);
                }
            }
            free(ev);
        }
        if (xcb_connection_has_error(c)) {
            fprintf(stderr, "[x11] connection error\n");
            return 2;
        }
    }
    xcb_disconnect(c);
    return 0;
}
