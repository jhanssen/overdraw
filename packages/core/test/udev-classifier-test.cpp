// Native unit test for the udev action classifier and the hotplug-adjacent
// link-status guards. GPU-free / no daemon dependency: feeds raw (action,
// HOTPLUG, CONNECTOR) property strings into the pure classifyUdevAction +
// parseConnectorIdHint helpers and asserts the kind / hint, and drives
// connectorLinkStatusBad through its no-DRM guard paths. Wired into
// `npm test` via test/udev-classifier.test.js, which spawns this binary and
// asserts PASS on stdout. Exit code: 0 = PASS, non-zero = FAIL.
//
// Mirrors wire-barrier-test.cpp / wire-barrier.test.js.

#include <cstdio>
#include <cstdlib>

#include "drm_utils.h"
#include "udev_monitor.h"

using overdraw::gpu::UdevHotplugEvent;
using overdraw::gpu::classifyUdevAction;
using overdraw::gpu::connectorLinkStatusBad;
using overdraw::gpu::parseConnectorIdHint;

namespace {

int g_failures = 0;
const char* g_currentCase = nullptr;

void fail(const char* file, int line, const char* msg) {
    std::fprintf(stderr, "FAIL [%s] %s:%d %s\n",
                 g_currentCase ? g_currentCase : "?", file, line, msg);
    ++g_failures;
}

#define CHECK(cond) do { if (!(cond)) fail(__FILE__, __LINE__, #cond); } while (0)

// HOTPLUG=1 + action=change is the only kind M7 actually acts on.
void caseConnectorChange() {
    g_currentCase = "connectorChange";
    CHECK(classifyUdevAction("change", "1") == UdevHotplugEvent::Kind::kConnectorChange);
}

// action=change WITHOUT HOTPLUG=1 (e.g. a LEASE event, or "HOTPLUG=0") is not
// a connector change; we ignore it. LEASE has its own property; we don't
// special-case it today (would be a separate Kind if/when leases come up).
void caseChangeWithoutHotplug() {
    g_currentCase = "changeWithoutHotplug";
    CHECK(classifyUdevAction("change", nullptr) == UdevHotplugEvent::Kind::kIgnore);
    CHECK(classifyUdevAction("change", "0")     == UdevHotplugEvent::Kind::kIgnore);
    CHECK(classifyUdevAction("change", "")      == UdevHotplugEvent::Kind::kIgnore);
}

// Card add/remove are M9 territory; the classifier surfaces them so main.cpp
// can log them, but the rescan path in M7 does not run for these.
void caseCardLifecycle() {
    g_currentCase = "cardLifecycle";
    CHECK(classifyUdevAction("add",    nullptr) == UdevHotplugEvent::Kind::kCardAdded);
    CHECK(classifyUdevAction("remove", nullptr) == UdevHotplugEvent::Kind::kCardRemoved);
    // HOTPLUG property is irrelevant for card-level events; it should not
    // change the kind.
    CHECK(classifyUdevAction("add",    "1")     == UdevHotplugEvent::Kind::kCardAdded);
    CHECK(classifyUdevAction("remove", "1")     == UdevHotplugEvent::Kind::kCardRemoved);
}

// Anything else (null action, unknown action) → ignore.
void caseUnknownAction() {
    g_currentCase = "unknownAction";
    CHECK(classifyUdevAction(nullptr,    "1")     == UdevHotplugEvent::Kind::kIgnore);
    CHECK(classifyUdevAction("",         "1")     == UdevHotplugEvent::Kind::kIgnore);
    CHECK(classifyUdevAction("bind",     "1")     == UdevHotplugEvent::Kind::kIgnore);
    CHECK(classifyUdevAction("offline",  nullptr) == UdevHotplugEvent::Kind::kIgnore);
}

// CONNECTOR=<id> hint parsing. Decimal only; trailing garbage tolerated by
// strtoul (we accept it -- the hint is advisory). Invalid input -> 0.
void caseConnectorIdHint() {
    g_currentCase = "connectorIdHint";
    CHECK(parseConnectorIdHint(nullptr) == 0);
    CHECK(parseConnectorIdHint("")      == 0);
    CHECK(parseConnectorIdHint("0")     == 0);
    CHECK(parseConnectorIdHint("1")     == 1u);
    CHECK(parseConnectorIdHint("42")    == 42u);
    CHECK(parseConnectorIdHint("4294967295") == 4294967295u);  // u32 max
    CHECK(parseConnectorIdHint("not-a-number") == 0);
    // Leading whitespace: strtoul skips, value parses.
    CHECK(parseConnectorIdHint("  7") == 7u);
}

// link-status guards. A connector with no link-status property (propId 0 --
// nested outputs, non-DP sinks, older drivers) must never read as bad, or
// rescan() would recycle healthy outputs on every hotplug event. Same for an
// unreadable device: failure to read is not evidence of a bad link. The
// BAD-detection path itself needs a kernel that flags a real link failure and
// is verified manually (see docs/status.md).
void caseLinkStatusGuards() {
    g_currentCase = "linkStatusGuards";
    // propId 0: early-out before any DRM call (fd deliberately invalid).
    CHECK(connectorLinkStatusBad(-1, 1, 0) == false);
    // Unreadable fd with a nonzero propId: read fails -> not bad.
    CHECK(connectorLinkStatusBad(-1, 1, 7) == false);
}

}  // namespace

int main() {
    caseConnectorChange();
    caseChangeWithoutHotplug();
    caseCardLifecycle();
    caseUnknownAction();
    caseConnectorIdHint();
    caseLinkStatusGuards();

    if (g_failures == 0) {
        std::printf("PASS udev-classifier-test\n");
        return 0;
    }
    std::fprintf(stderr, "FAILED %d check(s)\n", g_failures);
    return 1;
}
