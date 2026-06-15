// Unified logging entry point for the JS side. See docs/architecture.md
// "Logging".
//
// Two consumers:
//   1. The `log` named export (per-area structured logging from compositor
//      code).
//   2. installConsoleShim() -- replaces globalThis.console.{log,info,warn,
//      error,debug,trace} with shims that route through nativeLog on the
//      "js" area. Called from the launcher after addon.logInit(). All
//      original console functions are LOST -- redirecting them is the point.
//
// All formatting happens here (util.format), not in C++. Lazy: if the level
// is below the area's runtime filter the C++ side drops the record, but we
// still pay the format cost here. spdlog has no public predicate to ask
// "would this level be emitted on this area?" exposed from our binding; if
// the cost matters we add one later.

import { format as utilFormat } from "node:util";

import type { Addon } from "./types.js";

// Mirror of spdlog::level::level_enum.
export const LEVEL = {
    trace:    0,
    debug:    1,
    info:     2,
    warn:     3,
    err:      4,
    critical: 5,
    off:      6,
} as const;

export type LogArea =
    | "core" | "wayland" | "xdg" | "ipc" | "seat"
    | "input" | "gpu" | "dawn" | "plugin" | "js";

let addon: Addon | null = null;

// The launcher binds the addon once at boot. Until bound, log calls fall
// through to process.stderr.write so very early code (pre-addon-load) is not
// silently lost.
export function bindAddon(a: Addon): void {
    addon = a;
}

function emit(level: number, area: LogArea, fmt: unknown, args: unknown[]): void {
    const text = args.length === 0 ? String(fmt) : utilFormat(fmt, ...args);
    if (addon) {
        addon.nativeLog(level, area, text);
        return;
    }
    // Pre-bind fallback: write to stderr with a prefix that's recognizable.
    process.stderr.write(`[prebind ${area}] ${text}\n`);
}

export const log = {
    trace: (area: LogArea, fmt: unknown, ...args: unknown[]): void =>
        emit(LEVEL.trace, area, fmt, args),
    debug: (area: LogArea, fmt: unknown, ...args: unknown[]): void =>
        emit(LEVEL.debug, area, fmt, args),
    info: (area: LogArea, fmt: unknown, ...args: unknown[]): void =>
        emit(LEVEL.info, area, fmt, args),
    warn: (area: LogArea, fmt: unknown, ...args: unknown[]): void =>
        emit(LEVEL.warn, area, fmt, args),
    err: (area: LogArea, fmt: unknown, ...args: unknown[]): void =>
        emit(LEVEL.err, area, fmt, args),
    critical: (area: LogArea, fmt: unknown, ...args: unknown[]): void =>
        emit(LEVEL.critical, area, fmt, args),
};

// Replace globalThis.console.{log,info,warn,error,debug,trace} with shims
// that route through nativeLog on area "js". Other console methods (assert,
// table, dir, group, time, count, etc.) are left untouched -- they are not
// the routine logging surface and the format/output expectations diverge
// enough that the natural path is to keep node's implementation.
//
// Called once from the launcher AFTER addon.logInit().
export function installConsoleShim(): void {
    const toJsLog = (level: number) =>
        (fmt: unknown, ...args: unknown[]): void =>
            emit(level, "js", fmt, args);
    globalThis.console.log   = toJsLog(LEVEL.info)  as typeof console.log;
    globalThis.console.info  = toJsLog(LEVEL.info)  as typeof console.info;
    globalThis.console.debug = toJsLog(LEVEL.debug) as typeof console.debug;
    globalThis.console.trace = toJsLog(LEVEL.trace) as typeof console.trace;
    globalThis.console.warn  = toJsLog(LEVEL.warn)  as typeof console.warn;
    globalThis.console.error = toJsLog(LEVEL.err)   as typeof console.error;
}

// Parse a `--log-level`/`--log-file` from process.argv (or any argv slice).
// Returns the values to pass straight into addon.logInit({...}). Unknown
// flags are ignored; this function does no validation beyond looking for
// `=`-style flag values. spdlog itself rejects malformed level specs when
// addon.logInit runs.
export function parseLogArgs(argv: string[]): { levelSpec?: string; logFile?: string } {
    let levelSpec: string | undefined;
    let logFile: string | undefined;
    for (const a of argv) {
        if (a.startsWith("--log-level=")) levelSpec = a.slice("--log-level=".length);
        else if (a.startsWith("--log-file=")) logFile = a.slice("--log-file=".length);
    }
    const out: { levelSpec?: string; logFile?: string } = {};
    if (levelSpec !== undefined) out.levelSpec = levelSpec;
    if (logFile !== undefined) out.logFile = logFile;
    return out;
}
