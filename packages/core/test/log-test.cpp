// Native unit test for overdraw::log. GPU-free / no Dawn / no sockets:
// exercises area name round-trip, --log-level spec parser, ipc_sink ring
// buffer behavior, and ipc_sink fragmentation through an in-process socket
// pair (NOT a forked GPU process; the fork-based end-to-end test lives in a
// separate .gpu.mjs harness). Exit code: 0 = PASS, non-zero = FAIL.

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include <sys/socket.h>
#include <unistd.h>

#include "log/log.h"
#include "log/ipc_sink.h"
#include "log/ipc_source.h"
#include "log/log_wire.h"

using overdraw::log::Area;
using overdraw::log::Config;
using overdraw::log::IpcSink;
using overdraw::log::LogPacket;
using overdraw::log::areaFromName;
using overdraw::log::areaName;
using overdraw::log::kLogFragBytes;
using overdraw::log::parseLevelSpec;

namespace {

int g_failures = 0;
const char* g_currentCase = nullptr;

void fail(const char* file, int line, const char* msg) {
    std::fprintf(stderr, "FAIL [%s] %s:%d %s\n",
                 g_currentCase ? g_currentCase : "?", file, line, msg);
    ++g_failures;
}

#define CHECK(cond) do { if (!(cond)) fail(__FILE__, __LINE__, #cond); } while (0)

void caseAreaRoundTrip() {
    g_currentCase = "areaRoundTrip";
    for (size_t i = 0; i < static_cast<size_t>(Area::Count_); ++i) {
        const auto a = static_cast<Area>(i);
        const auto* name = areaName(a);
        CHECK(name != nullptr);
        CHECK(std::strlen(name) > 0);
        const Area back = areaFromName(name);
        CHECK(back == a);
    }
    // Unknown returns Count_ sentinel.
    CHECK(areaFromName("nosuch") == Area::Count_);
    CHECK(areaFromName("") == Area::Count_);
}

void caseSpecParserOk() {
    g_currentCase = "specParserOk";
    Config cfg{};
    std::string err;

    CHECK(parseLevelSpec("debug", &cfg, &err));
    CHECK(cfg.defaultLevel == spdlog::level::debug);
    CHECK(cfg.overrides.empty());

    cfg = {};
    CHECK(parseLevelSpec("warn,gpu=trace", &cfg, &err));
    CHECK(cfg.defaultLevel == spdlog::level::warn);
    CHECK(cfg.overrides.size() == 1);
    CHECK(cfg.overrides[0].area == Area::Gpu);
    CHECK(cfg.overrides[0].level == spdlog::level::trace);

    cfg = {};
    CHECK(parseLevelSpec("core=debug,gpu=info,wayland=err", &cfg, &err));
    CHECK(cfg.defaultLevel == spdlog::level::info);   // unchanged default
    CHECK(cfg.overrides.size() == 3);
    CHECK(cfg.overrides[0].area == Area::Core);
    CHECK(cfg.overrides[0].level == spdlog::level::debug);
    CHECK(cfg.overrides[1].area == Area::Gpu);
    CHECK(cfg.overrides[2].area == Area::Wayland);
    CHECK(cfg.overrides[2].level == spdlog::level::err);

    // "error" alias for err; "crit" alias for critical.
    cfg = {};
    CHECK(parseLevelSpec("ipc=error,plugin=crit", &cfg, &err));
    CHECK(cfg.overrides.size() == 2);
    CHECK(cfg.overrides[0].level == spdlog::level::err);
    CHECK(cfg.overrides[1].level == spdlog::level::critical);

    // off
    cfg = {};
    CHECK(parseLevelSpec("off", &cfg, &err));
    CHECK(cfg.defaultLevel == spdlog::level::off);
}

void caseSpecParserBad() {
    g_currentCase = "specParserBad";
    Config cfg{};
    std::string err;

    CHECK(!parseLevelSpec("bogus", &cfg, &err));
    CHECK(!err.empty());
    err.clear();

    CHECK(!parseLevelSpec("nosuch=debug", &cfg, &err));
    CHECK(err.find("unknown area") != std::string::npos);
    err.clear();

    CHECK(!parseLevelSpec("core=bogus", &cfg, &err));
    CHECK(!err.empty());
    err.clear();

    // Partial failure leaves out unchanged.
    Config baseline{};
    baseline.defaultLevel = spdlog::level::info;
    cfg = baseline;
    CHECK(!parseLevelSpec("debug,nosuch=trace", &cfg, &err));
    CHECK(cfg.defaultLevel == baseline.defaultLevel);
    CHECK(cfg.overrides == baseline.overrides);
}

// Drain `n` packets off the receiving end of a socketpair; returns the
// reassembled records as (level, area, text).
struct Decoded {
    uint8_t level;
    uint8_t area;
    std::string text;
};

std::vector<Decoded> drainPackets(int rfd, size_t expectedRecords) {
    std::vector<Decoded> out;
    std::string acc;
    uint32_t curSeq = 0;
    bool haveSeq = false;
    uint16_t need = 0;
    uint16_t got = 0;
    uint8_t curLevel = 0;
    uint8_t curArea = 0;
    while (out.size() < expectedRecords) {
        LogPacket pkt;
        ssize_t r = ::recv(rfd, &pkt, sizeof(LogPacket), 0);
        if (r <= 0) return out;
        if (!haveSeq) {
            curSeq = pkt.hdr.seq;
            need = pkt.hdr.fragCount;
            got = 0;
            haveSeq = true;
            curLevel = pkt.hdr.level;
            curArea = pkt.hdr.area;
            acc.clear();
        }
        if (pkt.hdr.seq != curSeq) {
            // Out-of-order is not expected (single sender, SEQPACKET).
            return out;
        }
        acc.append(pkt.payload, pkt.hdr.fragLen);
        ++got;
        if (got == need) {
            out.push_back({curLevel, curArea, acc});
            haveSeq = false;
        }
    }
    return out;
}

// Build a fresh logger bound only to the given IpcSink. Avoids touching
// global registry state (logInit) so test cases stay isolated. The logger
// is named after the area so IpcSink reports the right area.
std::shared_ptr<spdlog::logger> standaloneLogger(Area area, std::shared_ptr<IpcSink> sink) {
    auto lg = std::make_shared<spdlog::logger>(areaName(area), sink);
    lg->set_level(spdlog::level::trace);
    return lg;
}

void caseSinkSingleFragment() {
    g_currentCase = "sinkSingleFragment";
    int sv[2];
    CHECK(::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) == 0);

    auto sink = std::make_shared<IpcSink>();
    sink->setFd(sv[0]);
    auto lg = standaloneLogger(Area::Core, sink);
    lg->info("hello {}", 42);

    auto records = drainPackets(sv[1], 1);
    CHECK(records.size() == 1);
    if (records.size() == 1) {
        CHECK(records[0].level == static_cast<uint8_t>(spdlog::level::info));
        CHECK(records[0].area == static_cast<uint8_t>(Area::Core));
        CHECK(records[0].text == "hello 42");
    }
    ::close(sv[0]);
    ::close(sv[1]);
}

void caseSinkFragmentation() {
    g_currentCase = "sinkFragmentation";
    int sv[2];
    CHECK(::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) == 0);
    // Larger socket buffer for the long write.
    const int bufsz = 1 << 20;
    ::setsockopt(sv[0], SOL_SOCKET, SO_SNDBUF, &bufsz, sizeof(bufsz));
    ::setsockopt(sv[1], SOL_SOCKET, SO_RCVBUF, &bufsz, sizeof(bufsz));

    auto sink = std::make_shared<IpcSink>();
    sink->setFd(sv[0]);
    auto lg = standaloneLogger(Area::Gpu, sink);

    // Build a 3 * kLogFragBytes + 17 byte message; expect 4 fragments.
    const size_t totalLen = 3 * kLogFragBytes + 17;
    std::string big(totalLen, 'x');
    for (size_t i = 0; i < totalLen; ++i) big[i] = static_cast<char>('a' + (i % 26));
    lg->warn(big);

    auto records = drainPackets(sv[1], 1);
    CHECK(records.size() == 1);
    if (records.size() == 1) {
        CHECK(records[0].text == big);
        CHECK(records[0].level == static_cast<uint8_t>(spdlog::level::warn));
        CHECK(records[0].area == static_cast<uint8_t>(Area::Gpu));
    }
    ::close(sv[0]);
    ::close(sv[1]);
}

void caseSinkPreFdBuffering() {
    g_currentCase = "sinkPreFdBuffering";
    auto sink = std::make_shared<IpcSink>();
    auto lg = standaloneLogger(Area::Ipc, sink);

    // Before setFd: emit 3 records.
    lg->info("buffered-a");
    lg->warn("buffered-b");
    lg->error("buffered-c");

    int sv[2];
    CHECK(::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) == 0);
    sink->setFd(sv[0]);

    auto records = drainPackets(sv[1], 3);
    CHECK(records.size() == 3);
    if (records.size() == 3) {
        CHECK(records[0].text == "buffered-a");
        CHECK(records[1].text == "buffered-b");
        CHECK(records[2].text == "buffered-c");
        CHECK(records[0].level == static_cast<uint8_t>(spdlog::level::info));
        CHECK(records[2].level == static_cast<uint8_t>(spdlog::level::err));
    }
    ::close(sv[0]);
    ::close(sv[1]);
}

void caseSinkRingOverflow() {
    g_currentCase = "sinkRingOverflow";
    auto sink = std::make_shared<IpcSink>();
    auto lg = standaloneLogger(Area::Core, sink);

    // Emit kRingCapacity + 5 records pre-fd; oldest 5 should drop, ring keeps
    // the latest kRingCapacity.
    const size_t over = IpcSink::kRingCapacity + 5;
    for (size_t i = 0; i < over; ++i) {
        lg->info("r{}", i);
    }

    int sv[2];
    // Larger socket buffer so the drain doesn't block.
    const int bufsz = 2 << 20;
    CHECK(::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) == 0);
    ::setsockopt(sv[0], SOL_SOCKET, SO_SNDBUF, &bufsz, sizeof(bufsz));
    ::setsockopt(sv[1], SOL_SOCKET, SO_RCVBUF, &bufsz, sizeof(bufsz));

    // Drain on a thread so setFd's flush isn't blocked by socket backpressure.
    std::vector<Decoded> records;
    std::thread reader([&] {
        records = drainPackets(sv[1], IpcSink::kRingCapacity + 1);  // +1 overflow notice
    });
    sink->setFd(sv[0]);
    reader.join();

    // Expect the latest kRingCapacity records (r5..r{over-1}) plus an overflow
    // record from Ipc area.
    CHECK(records.size() == IpcSink::kRingCapacity + 1);
    if (records.size() == IpcSink::kRingCapacity + 1) {
        // The first surviving record should be "r5".
        CHECK(records[0].text == "r5");
        // The last buffered record before the overflow notice.
        CHECK(records[IpcSink::kRingCapacity - 1].text ==
              "r" + std::to_string(over - 1));
        // Overflow notice carries the dropped count and warn level.
        const auto& notice = records[IpcSink::kRingCapacity];
        CHECK(notice.level == static_cast<uint8_t>(spdlog::level::warn));
        CHECK(notice.area == static_cast<uint8_t>(Area::Ipc));
        CHECK(notice.text.find("5 records dropped") != std::string::npos);
    }
    ::close(sv[0]);
    ::close(sv[1]);
}

void caseIpcSourceReceives() {
    g_currentCase = "ipcSourceReceives";
    // End-to-end: sink -> socketpair -> source thread reads + reassembles.
    // We do not depend on the host registry here; we just verify the source
    // thread does not crash on a well-formed record and shuts down cleanly.
    int sv[2];
    CHECK(::socketpair(AF_UNIX, SOCK_SEQPACKET, 0, sv) == 0);

    // Initialize global registry with stdout sinks suppressed (level=off) so
    // dispatched records do NOT print to stdout during the test (which would
    // disrupt the final PASS line).
    Config cfg{};
    cfg.defaultLevel = spdlog::level::off;
    overdraw::log::logInit(cfg);

    overdraw::log::IpcSource src;
    src.start(sv[1]);

    auto sink = std::make_shared<IpcSink>();
    sink->setFd(sv[0]);
    auto lg = standaloneLogger(Area::Plugin, sink);
    lg->info("from-sender");

    // Give the source thread a moment to dispatch.
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    src.stop();  // closes sv[1]
    ::close(sv[0]);
}

}  // namespace

int main() {
    caseAreaRoundTrip();
    caseSpecParserOk();
    caseSpecParserBad();
    caseSinkSingleFragment();
    caseSinkFragmentation();
    caseSinkPreFdBuffering();
    caseSinkRingOverflow();
    caseIpcSourceReceives();

    overdraw::log::logShutdown();

    if (g_failures != 0) {
        std::fprintf(stderr, "FAIL: %d check(s) failed\n", g_failures);
        return 1;
    }
    std::printf("PASS\n");
    return 0;
}
