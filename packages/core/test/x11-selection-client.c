// X11 selection test client. Three modes:
//
//   --source CLIPBOARD|PRIMARY <mime> <payload>
//     Claim the selection and serve `payload` for `mime` on every
//     SelectionRequest. Stays alive until --timeout-ms.
//
//   --source-bytes CLIPBOARD|PRIMARY <mime> <N>
//     Same, but serve N bytes of a deterministic pattern
//     (byte i = (i ^ (i >> 8)) & 0xFF). Exists so the bridge's
//     incoming pump can be driven across the INCR threshold
//     (64 KiB) without passing huge argv strings.
//
//   --paste  CLIPBOARD|PRIMARY <mime>
//     Convert the selection to <mime>, read the bytes (handling
//     INCR continuations), print
//       "[x11-selection] received: <bytes>"               (default)
//       "[x11-selection] received-summary len=N sum32=H"  (--summary)
//     and exit.
//
//   --paste-target  CLIPBOARD|PRIMARY <target-atom-name>
//     ConvertSelection on an arbitrary target atom (e.g. TARGETS,
//     TIMESTAMP). Prints a structured line per result:
//       "[x11-selection] target=<NAME> type=<ATOM-NAME> format=<N>
//          len=<N> u32[0]=<DECIMAL>"
//     where u32[0] is the first 32-bit value when format=32 (used
//     for TIMESTAMP). Useful for exercising bridge code paths that
//     are not data-MIME transfers.
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

static unsigned char patternByte(size_t i) {
    return (unsigned char)((i ^ (i >> 8)) & 0xFF);
}

static xcb_atom_t intern_atom(xcb_connection_t* c, const char* name) {
    xcb_intern_atom_cookie_t k = xcb_intern_atom(c, 0, (uint16_t)strlen(name), name);
    xcb_intern_atom_reply_t* r = xcb_intern_atom_reply(c, k, NULL);
    xcb_atom_t a = r ? r->atom : 0;
    free(r);
    return a;
}

// Either `payload` (NUL-terminated string) OR `patternBytes` > 0. When
// patternBytes > 0, the SelectionRequest reply is built from patternByte()
// for that many bytes.
static int run_source(xcb_connection_t* c, xcb_screen_t* screen,
                      const char* selectionName, const char* mime,
                      const char* payload, size_t patternBytes,
                      int timeoutMs,
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
    const size_t payloadLen = patternBytes > 0 ? patternBytes : strlen(payload);
    // For the byte-pattern path, materialize the buffer once. The X server
    // limits a single ChangeProperty to ~256 KiB by default; we use the
    // bridge's INCR threshold (64 KiB) test sizes well under that.
    unsigned char* patternBuf = NULL;
    if (patternBytes > 0) {
        patternBuf = (unsigned char*)malloc(patternBytes);
        if (!patternBuf) return 4;
        for (size_t i = 0; i < patternBytes; i++) patternBuf[i] = patternByte(i);
    }
    const unsigned char* payloadBytes =
        patternBytes > 0 ? patternBuf : (const unsigned char*)payload;
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
                        (uint32_t)payloadLen, payloadBytes);
                    printf("[x11-selection] selection-served %s len=%zu\n", mime, payloadLen);
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

// ConvertSelection on an arbitrary target atom and print one line
// describing the reply (type / format / length / first u32 if any).
// Used by the test suite to exercise TIMESTAMP / TARGETS replies the
// bridge produces without going through a MIME-data transfer.
static int run_paste_target(xcb_connection_t* c, xcb_screen_t* screen,
                            const char* selectionName,
                            const char* targetName, int timeoutMs) {
    xcb_window_t win = xcb_generate_id(c);
    const uint32_t mask = XCB_EVENT_MASK_PROPERTY_CHANGE;
    xcb_create_window(c, XCB_COPY_FROM_PARENT, win, screen->root,
                      0, 0, 1, 1, 0, XCB_WINDOW_CLASS_INPUT_ONLY,
                      screen->root_visual, XCB_CW_EVENT_MASK, &mask);
    const xcb_atom_t SEL = intern_atom(c, selectionName);
    const xcb_atom_t TARGET = intern_atom(c, targetName);
    const xcb_atom_t DST = intern_atom(c, "_X_SEL_DATA");
    if (SEL == 0 || TARGET == 0 || DST == 0) {
        fprintf(stderr, "[x11-selection] atom intern failed\n");
        return 1;
    }
    xcb_convert_selection(c, win, SEL, TARGET, DST, XCB_CURRENT_TIME);
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
                    printf("[x11-selection] target=%s refused\n", targetName);
                    fflush(stdout);
                    free(ev);
                    return 0;
                }
                xcb_get_property_cookie_t pk = xcb_get_property(
                    c, 1 /*delete*/, win, DST, 0, 0, 65536);
                xcb_get_property_reply_t* pr = xcb_get_property_reply(c, pk, NULL);
                if (!pr) {
                    fprintf(stderr, "[x11-selection] GetProperty failed\n");
                    free(ev);
                    return 5;
                }
                int len = xcb_get_property_value_length(pr);
                // Resolve the reply type atom to its name (best-effort).
                xcb_get_atom_name_cookie_t nk = xcb_get_atom_name(c, pr->type);
                xcb_get_atom_name_reply_t* nr =
                    xcb_get_atom_name_reply(c, nk, NULL);
                char typeBuf[128] = "<unknown>";
                if (nr) {
                    int nlen = xcb_get_atom_name_name_length(nr);
                    if (nlen > (int)sizeof(typeBuf) - 1) nlen = sizeof(typeBuf) - 1;
                    memcpy(typeBuf, xcb_get_atom_name_name(nr), (size_t)nlen);
                    typeBuf[nlen] = '\0';
                    free(nr);
                }
                uint32_t firstU32 = 0;
                if (pr->format == 32 && len >= 4) {
                    memcpy(&firstU32, xcb_get_property_value(pr), 4);
                }
                printf("[x11-selection] target=%s type=%s format=%u len=%d u32[0]=%u\n",
                       targetName, typeBuf, (unsigned)pr->format, len, firstU32);
                fflush(stdout);
                free(pr); free(ev);
                return 0;
            }
            free(ev);
        }
        if (xcb_connection_has_error(c)) {
            fprintf(stderr, "[x11-selection] connection error\n");
            return 3;
        }
    }
    fprintf(stderr, "[x11-selection] paste-target timeout\n");
    return 6;
}

// Print result: `--summary` (sum32 + len) or raw bytes (NUL-padded).
static void emit_paste_result(int summary, const unsigned char* buf, size_t len,
                              uint32_t sum32) {
    if (summary) {
        printf("[x11-selection] received-summary len=%zu sum32=0x%08x\n", len, sum32);
    } else {
        printf("[x11-selection] received: %.*s\n", (int)len, (const char*)buf);
    }
    fflush(stdout);
}

static int run_paste(xcb_connection_t* c, xcb_screen_t* screen,
                     const char* selectionName, const char* mime,
                     int timeoutMs, int summary) {
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
    const xcb_atom_t INCR_ATOM = intern_atom(c, "INCR");
    if (SEL == 0 || MIME_ATOM == 0 || DST == 0 || INCR_ATOM == 0) {
        fprintf(stderr, "[x11-selection] atom intern failed\n");
        return 1;
    }
    xcb_convert_selection(c, win, SEL, MIME_ATOM, DST, XCB_CURRENT_TIME);
    xcb_flush(c);

    // Bytes accumulated across either a one-shot reply or all INCR chunks.
    unsigned char* accum = NULL;
    size_t accumLen = 0;
    size_t accumCap = 0;
    uint32_t sum32 = 0;
    int incrActive = 0;

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
                    free(ev); free(accum);
                    return 4;
                }
                xcb_get_property_cookie_t pk = xcb_get_property(
                    c, 1 /*delete*/, win, DST, 0, 0, 65536);
                xcb_get_property_reply_t* pr = xcb_get_property_reply(c, pk, NULL);
                if (!pr) {
                    fprintf(stderr, "[x11-selection] paste GetProperty failed\n");
                    free(ev); free(accum);
                    return 5;
                }
                int len = xcb_get_property_value_length(pr);
                unsigned char* val = (unsigned char*)xcb_get_property_value(pr);
                if (pr->type == INCR_ATOM) {
                    // INCR header. Subsequent PropertyNotify(NewValue) on
                    // DST carry chunks; deleting DST (above) signals "ready
                    // for first chunk."
                    incrActive = 1;
                    free(pr);
                    free(ev);
                    continue;
                }
                // Non-INCR: full payload in one property.
                if (len > 0) {
                    if (accumCap < (size_t)len) {
                        accumCap = (size_t)len;
                        accum = (unsigned char*)realloc(accum, accumCap);
                    }
                    memcpy(accum, val, (size_t)len);
                    accumLen = (size_t)len;
                    for (int i = 0; i < len; i++) sum32 += val[i];
                }
                emit_paste_result(summary, accum, accumLen, sum32);
                free(pr); free(ev); free(accum);
                return 0;
            }
            if (type == XCB_PROPERTY_NOTIFY) {
                xcb_property_notify_event_t* pn =
                    (xcb_property_notify_event_t*)ev;
                // INCR continuation: only NEW_VALUE on DST. state=0 NewValue, 1 Delete.
                if (!incrActive || pn->window != win || pn->atom != DST
                    || pn->state != 0) { free(ev); continue; }
                xcb_get_property_cookie_t pk = xcb_get_property(
                    c, 1 /*delete*/, win, DST, 0, 0, 65536);
                xcb_get_property_reply_t* pr = xcb_get_property_reply(c, pk, NULL);
                if (!pr) { free(ev); continue; }
                int len = xcb_get_property_value_length(pr);
                if (len == 0) {
                    // EOF.
                    emit_paste_result(summary, accum, accumLen, sum32);
                    free(pr); free(ev); free(accum);
                    return 0;
                }
                unsigned char* val = (unsigned char*)xcb_get_property_value(pr);
                if (accumLen + (size_t)len > accumCap) {
                    accumCap = (accumLen + (size_t)len) * 2;
                    accum = (unsigned char*)realloc(accum, accumCap);
                }
                memcpy(accum + accumLen, val, (size_t)len);
                for (int i = 0; i < len; i++) sum32 += val[i];
                accumLen += (size_t)len;
                free(pr);
            }
            free(ev);
        }
        if (xcb_connection_has_error(c)) {
            fprintf(stderr, "[x11-selection] connection error\n");
            free(accum);
            return 3;
        }
    }
    fprintf(stderr, "[x11-selection] paste timeout\n");
    free(accum);
    return 6;
}

int main(int argc, char** argv) {
    int mode = 0;            // 0 = unset, 1 = source, 2 = paste, 3 = paste-target
    const char* selectionName = "CLIPBOARD";
    const char* mime = "text/plain;charset=utf-8";
    const char* payload = "x-selection-test-payload";
    const char* targetName = NULL;
    size_t patternBytes = 0;
    int summary = 0;
    int timeoutMs = 10000;
    int doMap = 0;
    const char* title = "selection-client";
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--source") && i + 3 < argc) {
            mode = 1;
            selectionName = argv[++i];
            mime = argv[++i];
            payload = argv[++i];
        } else if (!strcmp(argv[i], "--source-bytes") && i + 3 < argc) {
            mode = 1;
            selectionName = argv[++i];
            mime = argv[++i];
            patternBytes = (size_t)strtoull(argv[++i], NULL, 10);
        } else if (!strcmp(argv[i], "--paste") && i + 2 < argc) {
            mode = 2;
            selectionName = argv[++i];
            mime = argv[++i];
        } else if (!strcmp(argv[i], "--paste-target") && i + 2 < argc) {
            mode = 3;
            selectionName = argv[++i];
            targetName = argv[++i];
        } else if (!strcmp(argv[i], "--summary")) {
            summary = 1;
        } else if (!strcmp(argv[i], "--timeout-ms") && i + 1 < argc) {
            timeoutMs = atoi(argv[++i]);
        } else if (!strcmp(argv[i], "--map")) {
            doMap = 1;
        } else if (!strcmp(argv[i], "--title") && i + 1 < argc) {
            title = argv[++i];
        }
    }
    if (mode == 0) {
        fprintf(stderr,
            "usage: %s (--source SEL MIME PAYLOAD | --source-bytes SEL MIME N "
            "| --paste SEL MIME [--summary] "
            "| --paste-target SEL TARGET-ATOM)\n", argv[0]);
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
                                     patternBytes, timeoutMs, title, doMap);
    if (mode == 3) return run_paste_target(c, screen, selectionName, targetName,
                                           timeoutMs);
    return run_paste(c, screen, selectionName, mime, timeoutMs, summary);
}
