// Fatal-signal crash handler shared by the core addon and the GPU process:
// dumps "<label> caught signal N" plus a native backtrace to a file, then
// re-raises with the default disposition. Without it a SIGSEGV leaves no
// trace (Node's runtime is short-circuited by the fatal signal; a plain
// process gets only the shell's "Aborted") -- the file is the only artifact.

#ifndef OVERDRAW_LOG_CRASH_HANDLER_H_
#define OVERDRAW_LOG_CRASH_HANDLER_H_

namespace overdraw::log {

// Install for SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE. `path` and `label` are
// read from inside the signal handler; pass string literals (they must
// outlive the process).
void installCrashHandler(const char* path, const char* label);

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_CRASH_HANDLER_H_
