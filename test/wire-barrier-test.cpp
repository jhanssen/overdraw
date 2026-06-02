// Native unit test for ipc::WireBarrier. GPU-free / no Dawn / no sockets:
// exercises the deferred-action FIFO + cancel + drainAll directly. Wired into
// `npm test` via test/wire-barrier.test.js (which spawns this binary and
// asserts PASS on stdout). Exit code: 0 = PASS, non-zero = FAIL.
//
// Mirrors the scm-rights-test.cpp / scm-rights.test.js pattern.

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "wire_barrier.h"

using overdraw::ipc::WireBarrier;

namespace {

int g_failures = 0;
const char* g_currentCase = nullptr;

void fail(const char* file, int line, const char* msg) {
    std::fprintf(stderr, "FAIL [%s] %s:%d %s\n",
                 g_currentCase ? g_currentCase : "?", file, line, msg);
    ++g_failures;
}

#define CHECK(cond) do { if (!(cond)) fail(__FILE__, __LINE__, #cond); } while (0)

// Immediate run when the barrier is already satisfied (consumedNow >= serial).
void caseImmediateRun() {
    g_currentCase = "immediateRun";
    WireBarrier b;
    int ran = 0;
    b.after(100, [&] { ++ran; }, /*consumedNow=*/200);
    CHECK(ran == 1);
    CHECK(b.empty());
}

// Deferral + drain in FIFO order; only satisfied actions run.
void caseDeferAndFifo() {
    g_currentCase = "deferAndFifo";
    WireBarrier b;
    std::vector<int> order;
    b.after(100, [&] { order.push_back(1); }, /*consumedNow=*/0);
    b.after(200, [&] { order.push_back(2); }, /*consumedNow=*/0);
    b.after(150, [&] { order.push_back(3); }, /*consumedNow=*/0);
    CHECK(b.pendingCount() == 3);
    CHECK(order.empty());

    b.drain(/*consumedNow=*/120);
    // Only the first entry (serial 100) is satisfied; FIFO walks from the front
    // and stops at the first unsatisfied entry, even if a LATER entry's serial
    // is also satisfied. This preserves enqueue order across satisfied entries.
    CHECK(order.size() == 1);
    CHECK(order[0] == 1);
    CHECK(b.pendingCount() == 2);

    b.drain(/*consumedNow=*/160);
    // Entry #2 (serial 200) is still not satisfied -> head blocks; entry #3
    // (serial 150) waits behind it. FIFO is preserved.
    CHECK(order.size() == 1);
    CHECK(b.pendingCount() == 2);

    b.drain(/*consumedNow=*/250);
    // Both remaining now satisfied; they run in enqueue order: #2 then #3.
    CHECK(order.size() == 3);
    CHECK(order[1] == 2);
    CHECK(order[2] == 3);
    CHECK(b.empty());
}

// cancel(pred) drops deferred entries matching the predicate by their tag.
void caseCancelByTag() {
    g_currentCase = "cancelByTag";
    WireBarrier b;
    int ran[5] = {0};
    b.after(100, [&] { ++ran[0]; }, /*consumedNow=*/0, /*tag=*/10);
    b.after(100, [&] { ++ran[1]; }, /*consumedNow=*/0, /*tag=*/20);
    b.after(100, [&] { ++ran[2]; }, /*consumedNow=*/0, /*tag=*/10);
    b.after(100, [&] { ++ran[3]; }, /*consumedNow=*/0, /*tag=*/30);
    CHECK(b.pendingCount() == 4);
    size_t dropped = b.cancel([](WireBarrier::Tag t) { return t == 10; });
    CHECK(dropped == 2);
    CHECK(b.pendingCount() == 2);
    b.drain(200);
    CHECK(ran[0] == 0);  // cancelled
    CHECK(ran[1] == 1);
    CHECK(ran[2] == 0);  // cancelled
    CHECK(ran[3] == 1);
}

// drainAll runs every still-pending action regardless of serial (shutdown).
void caseDrainAll() {
    g_currentCase = "drainAll";
    WireBarrier b;
    int closed[3] = {0};
    b.after(100, [&] { closed[0] = 1; }, /*consumedNow=*/0);
    b.after(200, [&] { closed[1] = 1; }, /*consumedNow=*/0);
    b.after(300, [&] { closed[2] = 1; }, /*consumedNow=*/0);
    b.drainAll();
    CHECK(closed[0] == 1);
    CHECK(closed[1] == 1);
    CHECK(closed[2] == 1);
    CHECK(b.empty());
}

// takePending hands out the deferred entries (caller inspects/closes/etc.).
void caseTakePending() {
    g_currentCase = "takePending";
    WireBarrier b;
    int ran = 0;
    b.after(100, [&] { ++ran; }, /*consumedNow=*/0, /*tag=*/42);
    b.after(200, [&] { ++ran; }, /*consumedNow=*/0, /*tag=*/43);
    auto entries = b.takePending();
    CHECK(entries.size() == 2);
    CHECK(entries[0].tag == 42);
    CHECK(entries[1].tag == 43);
    CHECK(b.empty());
    // Actions are owned by the entries now; running one here works once.
    entries[0].action();
    CHECK(ran == 1);
}

// An action queued by an action goes on the tail and runs in the SAME drain
// pass once its serial is satisfied by the same consumedNow argument.
void caseReentrantAfter() {
    g_currentCase = "reentrantAfter";
    WireBarrier b;
    std::vector<int> order;
    b.after(100, [&] {
        order.push_back(1);
        // Queue another action whose serial is already satisfied at the current
        // consumedNow (200); it should run inside this same drain pass.
        b.after(150, [&] { order.push_back(2); }, /*consumedNow=*/200);
    }, /*consumedNow=*/0);
    b.drain(200);
    CHECK(order.size() == 2);
    CHECK(order[0] == 1);
    CHECK(order[1] == 2);
    CHECK(b.empty());
}

}  // namespace

int main() {
    caseImmediateRun();
    caseDeferAndFifo();
    caseCancelByTag();
    caseDrainAll();
    caseTakePending();
    caseReentrantAfter();
    if (g_failures == 0) { std::printf("PASS\n"); return 0; }
    std::fprintf(stderr, "FAILURES: %d\n", g_failures);
    return 1;
}
