// X11 selection test client. Two modes:
//
//   --source CLIPBOARD|PRIMARY <mime> <payload>
//     Claim the selection and serve `payload` for `mime` on every
//     SelectionRequest. Stays alive until --timeout-ms.
//
//   --paste  CLIPBOARD|PRIMARY <mime>
//     Convert the selection to <mime>, read the bytes, print
//     "[x11-selection] received: <bytes>" and exit.
//
// Common:
//   --map         Create + map a 1x1 window so the X side has a focused
//                 surface (focus is required for the bridge to mediate).
//                 The test harness uses applyKeyboardFocus separately on
//                 the wl side.
//   --title <s>   Set _NET_WM_NAME + WM_NAME (default "selection-client").
//   --timeout-ms <n>
//                 Safety upper bound (default 10000).
//
// Print contract for tests:
//   [x11-selection] mapped 0x<window>          on map
//   [x11-selection] selection-set              after SetSelectionOwner success
//   [x11-selection] selection-served <mime>    after we answered a request
//   [x11-selection] received: <bytes>          after a successful paste

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>

#include <xcb/xcb.h>

static xcb_atom_t intern_atom(xcb_connection_t* c, const char* name) {
    xcb_intern_atom_cookie_t k = xcb_intern_atom(c, 0, (uint16_t)strlen(name), name);
    xcb_intern_atom_reply_t* r = xcb_intern_atom_reply(c, k, NULL);
    xcb_atom_t a = r ? r->atom : 0;
    free(r);
    return a;
}

static int run_source(xcb_connection_t* c, xcb_screen_t* screen,
                      const char* selectionName, const char* mime,
                      const char* payload, int timeoutMs,
                      const char* title, int doMap) {
    xcb_window_t win = xcb_generate_id(c);
    const uint32_t valuesMask = XCB_CW_BACK_PIXEL | XCB_CW_EVENT_MASK;
    const uint32_t values[2] = {
        screen->white_pixel,
        XCB_EVENT_MASK_EXPOSURE | XCB_EVENT_MASK_STRUCTURE_NOTIFY
        | XCB_EVENT_MASK_PROPERTY_CHANGE,
    };
    xcb_create_window(c, XCB_COPY_FROM_PARENT, win, screen->root,
                      0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT,
                      screen->root_visual, valuesMask, values);

    if (doMap) {
        const xcb_atom_t WM_NAME = intern_atom(c, "WM_NAME");
        const xcb_atom_t NET_WM_NAME = intern_atom(c, "_NET_WM_NAME");
        const xcb_atom_t UTF8_STRING = intern_atom(c, "UTF8_STRING");
        xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, NET_WM_NAME, UTF8_STRING, 8,
                            (uint32_t)strlen(title), title);
        xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, WM_NAME, XCB_ATOM_STRING, 8,
                            (uint32_t)strlen(title), title);
        xcb_map_window(c, win);
        printf("[x11-selection] mapped 0x%x\n", win);
        fflush(stdout);
    }

    const xcb_atom_t SEL = intern_atom(c, selectionName);
    // For the standard text MIMEs, intern the X atom name the X protocol uses
    // (UTF8_STRING / TEXT). The bridge ConvertSelection's onto that atom.
    // Always also intern the literal MIME string so a "verbatim" MIME (e.g.
    // image/png) is supported too.
    const char* mimeAtomName = mime;
    if (!strcmp(mime, "text/plain;charset=utf-8")) mimeAtomName = "UTF8_STRING";
    else if (!strcmp(mime, "text/plain")) mimeAtomName = "TEXT";
    const xcb_atom_t MIME_ATOM = intern_atom(c, mimeAtomName);
    const xcb_atom_t TARGETS = intern_atom(c, "TARGETS");
    const xcb_atom_t TIMESTAMP = intern_atom(c, "TIMESTAMP");
    const xcb_atom_t MULTIPLE = intern_atom(c, "MULTIPLE");
    if (SEL == 0 || MIME_ATOM == 0) {
        fprintf(stderr, "[x11-selection] atom intern failed\n");
        return 1;
    }

    xcb_set_selection_owner(c, win, SEL, XCB_CURRENT_TIME);
    xcb_flush(c);

    // Verify we got it.
    xcb_get_selection_owner_cookie_t gk = xcb_get_selection_owner(c, SEL);
    xcb_get_selection_owner_reply_t* gr = xcb_get_selection_owner_reply(c, gk, NULL);
    if (!gr || gr->owner != win) {
        fprintf(stderr, "[x11-selection] failed to take selection (owner=%x want %x)\n",
                gr ? gr->owner : 0, win);
        free(gr);
        return 2;
    }
    free(gr);
    printf("[x11-selection] selection-set\n");
    fflush(stdout);

    const int fd = xcb_get_file_descriptor(c);
    long elapsedMs = 0;
    const int stepMs = 50;
    const size_t payloadLen = strlen(payload);
    while (elapsedMs < timeoutMs) {
        struct pollfd p = { .fd = fd, .events = POLLIN };
        poll(&p, 1, stepMs);
        elapsedMs += stepMs;
        xcb_generic_event_t* ev;
        while ((ev = xcb_poll_for_event(c))) {
            const uint8_t type = ev->response_type & 0x7f;
            if (type == XCB_SELECTION_REQUEST) {
                xcb_selection_request_event_t* sr =
                    (xcb_selection_request_event_t*)ev;
                xcb_atom_t replyProperty = sr->property != 0 ? sr->property
                                                              : sr->target;
                if (sr->target == TARGETS) {
                    xcb_atom_t list[3] = { TIMESTAMP, TARGETS, MIME_ATOM };
                    xcb_change_property(c, XCB_PROP_MODE_REPLACE, sr->requestor,
                        replyProperty, XCB_ATOM_ATOM, 32, 3, list);
                } else if (sr->target == MIME_ATOM) {
                    xcb_change_property(c, XCB_PROP_MODE_REPLACE, sr->requestor,
                        replyProperty, sr->target, 8,
                        (uint32_t)payloadLen, payload);
                    printf("[x11-selection] selection-served %s\n", mime);
                    fflush(stdout);
                } else if (sr->target == TIMESTAMP) {
                    uint32_t t = XCB_CURRENT_TIME;
                    xcb_change_property(c, XCB_PROP_MODE_REPLACE, sr->requestor,
                        replyProperty, XCB_ATOM_INTEGER, 32, 1, &t);
                } else if (sr->target == MULTIPLE) {
                    // Refuse.
                    replyProperty = 0;
                } else {
                    replyProperty = 0;
                }
                xcb_selection_notify_event_t n = {0};
                n.response_type = XCB_SELECTION_NOTIFY;
                n.requestor = sr->requestor;
                n.selection = sr->selection;
                n.target = sr->target;
                n.property = replyProperty;
                n.time = sr->time;
                xcb_send_event(c, 0, sr->requestor, 0, (const char*)&n);
                xcb_flush(c);
            } else if (type == XCB_SELECTION_CLEAR) {
                // Someone else took the selection; we still stay alive
                // until --timeout-ms so the harness can observe.
            }
            free(ev);
        }
        if (xcb_connection_has_error(c)) {
            fprintf(stderr, "[x11-selection] connection error\n");
            return 3;
        }
    }
    return 0;
}

static int run_paste(xcb_connection_t* c, xcb_screen_t* screen,
                     const char* selectionName, const char* mime, int timeoutMs) {
    // A small input-only requestor window. The selection bridge writes the
    // converted bytes onto `_X_SEL_DATA` on this window.
    xcb_window_t win = xcb_generate_id(c);
    const uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    xcb_create_window(c, XCB_COPY_FROM_PARENT, win, screen->root,
                      0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_ONLY,
                      screen->root_visual, XCB_CW_EVENT_MASK, &mask);
    const xcb_atom_t SEL = intern_atom(c, selectionName);
    const char* mimeAtomName = mime;
    if (!strcmp(mime, "text/plain;charset=utf-8")) mimeAtomName = "UTF8_STRING";
    else if (!strcmp(mime, "text/plain")) mimeAtomName = "TEXT";
    const xcb_atom_t MIME_ATOM = intern_atom(c, mimeAtomName);
    const xcb_atom_t DST = intern_atom(c, "_X_SEL_DATA");
    if (SEL == 0 || MIME_ATOM == 0 || DST == 0) {
        fprintf(stderr, "[x11-selection] atom intern failed\n");
        return 1;
    }
    xcb_convert_selection(c, win, SEL, MIME_ATOM, DST, XCB_CURRENT_TIME);
    xcb_flush(c);

    const int fd = xcb_get_file_descriptor(c);
    long elapsedMs = 0;
    const int stepMs = 50;
    while (elapsedMs < timeoutMs) {
        struct pollfd p = { .fd = fd, .events = POLLIN };
        poll(&p, 1, stepMs);
        elapsedMs += stepMs;
        xcb_generic_event_t* ev;
        while ((ev = xcb_poll_for_event(c))) {
            const uint8_t type = ev->response_type & 0x7f;
            if (type == XCB_SELECTION_NOTIFY) {
                xcb_selection_notify_event_t* sn =
                    (xcb_selection_notify_event_t*)ev;
                if (sn->property == 0) {
                    fprintf(stderr, "[x11-selection] paste refused\n");
                    free(ev);
                    return 4;
                }
                xcb_get_property_cookie_t pk = xcb_get_property(
                    c, 1 /*delete*/, win, DST, 0, 0, 65536 /*length words*/);
                xcb_get_property_reply_t* pr = xcb_get_property_reply(c, pk, NULL);
                if (!pr) {
                    fprintf(stderr, "[x11-selection] paste GetProperty failed\n");
                    free(ev);
                    return 5;
                }
                int len = xcb_get_property_value_length(pr);
                char* val = (char*)xcb_get_property_value(pr);
                // INCR not handled by this client (test payloads are small).
                printf("[x11-selection] received: %.*s\n", len, val);
                fflush(stdout);
                free(pr);
                free(ev);
                return 0;
            }
            free(ev);
        }
        if (xcb_connection_has_error(c)) {
            fprintf(stderr, "[x11-selection] connection error\n");
            return 3;
        }
    }
    fprintf(stderr, "[x11-selection] paste timeout\n");
    return 6;
}

int main(int argc, char** argv) {
    int mode = 0;            // 0 = unset, 1 = source, 2 = paste
    const char* selectionName = "CLIPBOARD";
    const char* mime = "text/plain;charset=utf-8";
    const char* payload = "x-selection-test-payload";
    int timeoutMs = 10000;
    int doMap = 0;
    const char* title = "selection-client";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--source") && i + 3 < argc) {
            mode = 1;
            selectionName = argv[++i];
            mime = argv[++i];
            payload = argv[++i];
        } else if (!strcmp(argv[i], "--paste") && i + 2 < argc) {
            mode = 2;
            selectionName = argv[++i];
            mime = argv[++i];
        } else if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) {
            timeoutMs = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--map")) {
            doMap = 1;
        } else if (!strcmp(argv[i], "--title") && i + 1 < argc) {
            title = argv[++i];
        }
    }
    if (mode == 0) {
        fprintf(stderr, "usage: %s --source SEL MIME PAYLOAD | --paste SEL MIME\n",
                argv[0]);
        return 1;
    }

    xcb_connection_t* c = xcb_connect(NULL, NULL);
    if (xcb_connection_has_error(c)) {
        fprintf(stderr, "[x11-selection] connect failed\n");
        return 1;
    }
    xcb_screen_t* screen = xcb_setup_roots_iterator(xcb_get_setup(c)).data;
    if (!screen) {
        fprintf(stderr, "[x11-selection] no screen\n");
        return 1;
    }

    if (mode == 1) return run_source(c, screen, selectionName, mime, payload,
                                     timeoutMs, title, doMap);
    return run_paste(c, screen, selectionName, mime, timeoutMs);
}
