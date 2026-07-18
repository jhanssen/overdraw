// Persistent state-directory resolution shared by the host addon and the GPU
// process. Logs and crash reports live under one per-user state directory so
// they survive reboots (unlike /tmp on tmpfs).
//
// Resolution order: $OVERDRAW_STATE_DIR, else $XDG_STATE_HOME/overdraw, else
// $HOME/.local/state/overdraw. Directories are created on first use (0755).

#ifndef OVERDRAW_LOG_PATHS_H_
#define OVERDRAW_LOG_PATHS_H_

#include <string>

namespace overdraw::log {

// Root state dir. Empty string when no override is set and $HOME is unset
// (callers treat empty as "no persistent storage available").
std::string stateDir();

// stateDir()/logs and stateDir()/crashes, created if missing. Empty when
// stateDir() is empty or mkdir fails.
std::string logsDir();
std::string crashesDir();

}  // namespace overdraw::log

#endif  // OVERDRAW_LOG_PATHS_H_
