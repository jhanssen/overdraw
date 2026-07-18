#include "log/log.h"

#include <array>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>

#include <spdlog/sinks/dist_sink.h>
#include <spdlog/sinks/stdout_sinks.h>
#include <spdlog/sinks/rotating_file_sink.h>

#include "log/paths.h"
#include "log/ring_sink.h"

namespace overdraw::log {

namespace {

constexpr size_t kAreaCount = static_cast<size_t>(Area::Count_);

constexpr std::array<const char*, kAreaCount> kAreaNames = {
    "core", "wayland", "xdg", "ipc", "seat",
    "input", "gpu", "dawn", "plugin", "js",
};

struct Registry {
    std::mutex mu;
    std::array<std::shared_ptr<spdlog::logger>, kAreaCount> loggers;
    std::shared_ptr<spdlog::logger> fallback;  // used before logInit
};

Registry& registry() {
    static Registry r;
    return r;
}

// Sink that only accepts records at-or-below an inclusive ceiling.
template <typename Inner>
class CeilingSink : public spdlog::sinks::sink {
public:
    CeilingSink(std::shared_ptr<Inner> inner, spdlog::level::level_enum ceiling)
        : inner_(std::move(inner)), ceiling_(ceiling) {}
    void log(const spdlog::details::log_msg& m) override {
        if (m.level <= ceiling_) inner_->log(m);
    }
    void flush() override { inner_->flush(); }
    void set_pattern(const std::string& p) override { inner_->set_pattern(p); }
    void set_formatter(std::unique_ptr<spdlog::formatter> f) override {
        inner_->set_formatter(std::move(f));
    }

private:
    std::shared_ptr<Inner> inner_;
    spdlog::level::level_enum ceiling_;
};

std::shared_ptr<spdlog::sinks::dist_sink_mt> buildSinks(const Config& cfg) {
    auto dist = std::make_shared<spdlog::sinks::dist_sink_mt>();

    // Crash-context ring rides along in every mode (including the GPU
    // process's sender mode) so a crash report always has recent records.
    dist->add_sink(std::make_shared<RingSink>());

    if (cfg.senderSink) {
        // Sender mode (GPU process): the IPC sink instead of stdout/stderr/
        // file. The IpcSink uses the record's raw payload bytes; the pattern
        // set below only affects the ring.
        dist->add_sink(cfg.senderSink);
    } else {
        // stdout: trace/debug/info. Capped at info.
        auto stdoutInner = std::make_shared<spdlog::sinks::stdout_sink_mt>();
        auto stdoutCapped = std::make_shared<CeilingSink<spdlog::sinks::stdout_sink_mt>>(
            stdoutInner, spdlog::level::info);
        dist->add_sink(stdoutCapped);

        // stderr: warn/err/critical. Floor at warn (sink-level filter, not record).
        auto stderrSink = std::make_shared<spdlog::sinks::stderr_sink_mt>();
        stderrSink->set_level(spdlog::level::warn);
        dist->add_sink(stderrSink);

        // Persistent file sink, on by default: cfg.filePath when given, else
        // the state dir (survives reboots; /tmp does not). Rotation bounds
        // disk use for long sessions.
        if (!cfg.disableFile) {
            std::string path = cfg.filePath;
            if (path.empty()) {
                const std::string dir = logsDir();
                if (!dir.empty()) path = dir + "/overdraw.log";
            }
            if (!path.empty()) {
                try {
                    auto fileSink = std::make_shared<spdlog::sinks::rotating_file_sink_mt>(
                        path, /*max_size=*/8u * 1024 * 1024, /*max_files=*/3);
                    dist->add_sink(fileSink);
                } catch (const spdlog::spdlog_ex& e) {
                    std::fprintf(stderr, "overdraw: log file sink at %s unavailable: %s\n",
                                 path.c_str(), e.what());
                }
            }
        }
    }

    // Compact pattern: time, level, area (via logger name), message.
    dist->set_pattern("%H:%M:%S.%e %^%-5l%$ [%n] %v");
    return dist;
}

}  // namespace

const char* areaName(Area a) {
    const auto i = static_cast<size_t>(a);
    return i < kAreaCount ? kAreaNames[i] : "?";
}

Area areaFromName(std::string_view name) {
    for (size_t i = 0; i < kAreaCount; ++i) {
        if (name == kAreaNames[i]) return static_cast<Area>(i);
    }
    return Area::Count_;
}

spdlog::logger& logger(Area a) {
    auto& r = registry();
    const auto i = static_cast<size_t>(a);
    if (i >= kAreaCount) {
        // Defensive: callers should not pass Count_. Fall through to fallback.
    }
    {
        std::lock_guard<std::mutex> lk(r.mu);
        if (i < kAreaCount) {
            auto& slot = r.loggers[i];
            if (slot) return *slot;
        }
        if (!r.fallback) {
            // Pre-init: a bare stderr logger so calls before logInit do not
            // crash. Replaced on first logInit.
            r.fallback = spdlog::stderr_logger_mt("uninit");
            r.fallback->set_pattern("%H:%M:%S.%e %^%-5l%$ [uninit] %v");
            r.fallback->set_level(spdlog::level::info);
        }
        return *r.fallback;
    }
}

bool parseLevelSpec(std::string_view spec, Config* out, std::string* err) {
    auto parseLevel = [](std::string_view s, spdlog::level::level_enum* lv) -> bool {
        if (s == "trace") { *lv = spdlog::level::trace; return true; }
        if (s == "debug") { *lv = spdlog::level::debug; return true; }
        if (s == "info")  { *lv = spdlog::level::info;  return true; }
        if (s == "warn")  { *lv = spdlog::level::warn;  return true; }
        if (s == "err" || s == "error") { *lv = spdlog::level::err; return true; }
        if (s == "critical" || s == "crit") { *lv = spdlog::level::critical; return true; }
        if (s == "off")   { *lv = spdlog::level::off;   return true; }
        return false;
    };

    Config tmp = *out;
    tmp.overrides.clear();

    size_t start = 0;
    while (start <= spec.size()) {
        const size_t end = spec.find(',', start);
        const auto tok = spec.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
        const size_t eq = tok.find('=');
        if (eq == std::string_view::npos) {
            // bare level → default for all areas
            spdlog::level::level_enum lv;
            if (!parseLevel(tok, &lv)) {
                if (err) *err = "bad level token: " + std::string(tok);
                return false;
            }
            tmp.defaultLevel = lv;
        } else {
            const auto areaTok = tok.substr(0, eq);
            const auto levelTok = tok.substr(eq + 1);
            const Area a = areaFromName(areaTok);
            if (a == Area::Count_) {
                if (err) *err = "unknown area: " + std::string(areaTok);
                return false;
            }
            spdlog::level::level_enum lv;
            if (!parseLevel(levelTok, &lv)) {
                if (err) *err = "bad level for area " + std::string(areaTok) + ": " + std::string(levelTok);
                return false;
            }
            tmp.overrides.push_back({a, lv});
        }
        if (end == std::string_view::npos) break;
        start = end + 1;
    }
    *out = std::move(tmp);
    return true;
}

void logInit(const Config& cfg) {
    auto sinks = buildSinks(cfg);

    auto& r = registry();
    std::lock_guard<std::mutex> lk(r.mu);
    for (size_t i = 0; i < kAreaCount; ++i) {
        auto name = std::string(kAreaNames[i]);
        // Drop any prior logger with this name so logInit is idempotent.
        spdlog::drop(name);
        auto lg = std::make_shared<spdlog::logger>(name, sinks);
        // Apply default, then per-area override.
        spdlog::level::level_enum lv = cfg.defaultLevel;
        for (const auto& ov : cfg.overrides) {
            if (static_cast<size_t>(ov.area) == i) { lv = ov.level; break; }
        }
        lg->set_level(lv);
        // Flush every record. The file sink would otherwise buffer until
        // process exit (stdio default), hiding records from concurrent
        // readers. stdout/stderr are line-buffered anyway so the extra
        // flush on those is cheap.
        lg->flush_on(spdlog::level::trace);
        spdlog::register_logger(lg);
        r.loggers[i] = std::move(lg);
    }
    // Real loggers are installed; release the preinit fallback.
    r.fallback.reset();
}

void logShutdown() {
    auto& r = registry();
    std::lock_guard<std::mutex> lk(r.mu);
    for (auto& slot : r.loggers) {
        if (slot) slot->flush();
        slot.reset();
    }
    r.fallback.reset();
    spdlog::shutdown();
}

}  // namespace overdraw::log
