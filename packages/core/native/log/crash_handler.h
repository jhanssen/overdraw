// Fatal-signal crash handler shared by the core addon and the GPU process:
// writes a per-crash report (signal + fault address, native backtrace, the
// most recent log records from the in-memory ring) to a timestamped file in
// a crash directory, then re-raises with the default disposition. Without it
// a SIGSEGV leaves no trace (Node's runtime is short-circuited by the fatal
// signal; a plain process gets only the shell's "Aborted") -- the file is
// the only artifact.

#ifndef OVERDRAW_LOG_CRASH_HANDLER_H_
#define OVERDRAW_LOG_CRASH_HANDLER_H_

#include <string>

namespace overdraw::log {

// Install for SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE. Reports go to
// `dir`/crash-<label>-<epoch>-<pid>.txt; older reports are pruned to the
// newest 20 at install time. Runs on a dedicated sigaltstack so
// stack-overflow faults are reported too. No-op when `dir` is empty.
void installCrashHandler(const std::string& dir, const char* label);

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_CRASH_HANDLER_H_
