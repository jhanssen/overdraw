// Unified logging for the three execution contexts (host JS via console.* +
// log module, host native, GPU process). See docs/architecture.md "Logging".
//
// Two public entry points:
//   LOG_* macros (compile-time-strippable spdlog wrappers; see SPDLOG_ACTIVE_LEVEL).
//   logInit() / parseLevelSpec() for startup configuration.

#ifndef OVERDRAW_LOG_LOG_H_
#define OVERDRAW_LOG_LOG_H_

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include <spdlog/spdlog.h>

namespace overdraw::log {

// Fixed area set. Order matches LogArea wire encoding in ipc_sink.
enum class Area : uint8_t {
    Core    = 0,
    Wayland = 1,
    Xdg     = 2,
    Ipc     = 3,
    Seat    = 4,
    Input   = 5,
    Gpu     = 6,
    Dawn    = 7,
    Plugin  = 8,
    Js      = 9,
    Count_  = 10,
};

const char* areaName(Area a);
// Returns Area::Count_ on miss; caller checks.
Area areaFromName(std::string_view name);

// One spdlog::logger per area. The same severity-based dist_sink is attached
// to every area (stdout ≤ info, stderr ≥ warn, optional file). Per-area level
// is the logger's own level. NEVER null after logInit (returns the area logger;
// if not yet initialized, returns a transient stderr logger so early calls do
// not crash).
spdlog::logger& logger(Area a);

// Configuration.
struct LevelOverride {
    Area area;
    spdlog::level::level_enum level;
    bool operator==(const LevelOverride& o) const {
        return area == o.area && level == o.level;
    }
};

struct Config {
    // Default level for areas not in `overrides`.
    spdlog::level::level_enum defaultLevel = spdlog::level::info;
    std::vector<LevelOverride> overrides;
    // File sink path override. Empty = default (logsDir()/overdraw.log,
    // rotating). Ignored when senderSink is set or disableFile is true.
    std::string filePath;
    // Suppress the file sink entirely (--no-log-file).
    bool disableFile = false;
    // If set, areas use this sink instead of stdout/stderr/file (the crash
    // ring is still attached). Used by the GPU process to route every LOG_*
    // through the IPC sink.
    std::shared_ptr<spdlog::sinks::sink> senderSink;
};

// Parse `--log-level=SPEC`. SPEC is a comma-separated list of `area=level` and
// bare `level` (the bare token becomes the default). Levels: trace/debug/info/
// warn/err/critical/off. Returns true on success; on failure writes a short
// reason to `*err` and leaves `*out` untouched.
bool parseLevelSpec(std::string_view spec, Config* out, std::string* err);

// Initialize the global logger registry. Safe to call multiple times (last
// call wins; sinks are rebuilt).
void logInit(const Config& cfg);

// Shut down the registry. Flushes sinks. Optional; sinks flush on process
// exit too.
void logShutdown();

}  // namespace overdraw::log

// LOG_* macros: wrappers over SPDLOG_LOGGER_* so SPDLOG_ACTIVE_LEVEL strips
// below the floor at compile time.
#define LOG_TRACE(area, ...) \
    SPDLOG_LOGGER_TRACE(&::overdraw::log::logger(::overdraw::log::Area::area), __VA_ARGS__)
#define LOG_DEBUG(area, ...) \
    SPDLOG_LOGGER_DEBUG(&::overdraw::log::logger(::overdraw::log::Area::area), __VA_ARGS__)
#define LOG_INFO(area, ...) \
    SPDLOG_LOGGER_INFO(&::overdraw::log::logger(::overdraw::log::Area::area), __VA_ARGS__)
#define LOG_WARN(area, ...) \
    SPDLOG_LOGGER_WARN(&::overdraw::log::logger(::overdraw::log::Area::area), __VA_ARGS__)
#define LOG_ERR(area, ...) \
    SPDLOG_LOGGER_ERROR(&::overdraw::log::logger(::overdraw::log::Area::area), __VA_ARGS__)
#define LOG_CRIT(area, ...) \
    SPDLOG_LOGGER_CRITICAL(&::overdraw::log::logger(::overdraw::log::Area::area), __VA_ARGS__)

#endif  // OVERDRAW_LOG_LOG_H_
