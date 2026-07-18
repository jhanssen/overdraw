#include "spawn_child.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <uv.h>

#include "log/log.h"

namespace overdraw::core {
namespace {

// Pids of children spawned via spawnChild. These are forked directly (not by
// libuv), so libuv's own child reaping never touches them; we reap them from a
// uv_signal_t SIGCHLD watcher (libuv multiplexes signals, so this coexists with
// its internal handling) plus opportunistically on each spawn. reapTracked()
// waits only on OUR pids -- never waitpid(-1) -- so libuv's child handles are
// never stolen.
std::mutex g_mu;
std::vector<pid_t> g_pids;

// SIGCHLD watcher on the node event loop; reaps exited spawn children promptly
// without a raw signal handler that would clobber libuv's. Unref'd so it never
// keeps the loop alive. Initialized once in RegisterSpawn.
uv_signal_t g_sigchld;
bool g_sigchldReady = false;

void reapTracked() {
    std::lock_guard<std::mutex> lk(g_mu);
    std::vector<pid_t> alive;
    alive.reserve(g_pids.size());
    for (pid_t p : g_pids) {
        int status = 0;
        // WNOHANG on the specific pid: 0 = still running (keep); pid = reaped
        // (drop); <0 (ECHILD, already gone) = drop.
        if (::waitpid(p, &status, WNOHANG) == 0) alive.push_back(p);
    }
    g_pids.swap(alive);
}

std::string jsString(napi_env env, napi_value v) {
    size_t len = 0;
    napi_get_value_string_utf8(env, v, nullptr, 0, &len);
    std::string s(len, '\0');
    napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
    return s;
}

std::vector<std::string> jsStringArray(napi_env env, napi_value arr) {
    std::vector<std::string> out;
    bool isArray = false;
    if (napi_is_array(env, arr, &isArray) != napi_ok || !isArray) return out;
    uint32_t n = 0;
    napi_get_array_length(env, arr, &n);
    out.reserve(n);
    for (uint32_t i = 0; i < n; ++i) {
        napi_value e;
        if (napi_get_element(env, arr, i, &e) == napi_ok) out.push_back(jsString(env, e));
    }
    return out;
}

// spawnChild(command: string, argv: string[], env: string[]) -> pid (number)
//
// argv EXCLUDES argv0 (added here from `command`). `env` is a list of
// "KEY=VALUE" overrides applied on top of the inherited environment. Returns
// the child pid, or -1 on fork failure. The child dies when the compositor
// (this process) exits, even on SIGKILL, via PR_SET_PDEATHSIG.
napi_value SpawnChild(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3] = {};
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    const std::string command = argc >= 1 ? jsString(env, args[0]) : std::string();
    const std::vector<std::string> argv = argc >= 2 ? jsStringArray(env, args[1])
                                                    : std::vector<std::string>();
    const std::vector<std::string> envOverrides =
        argc >= 3 ? jsStringArray(env, args[2]) : std::vector<std::string>();

    // Opportunistic: clear any previously-spawned children that have exited so
    // the tracking list (and the zombie table) doesn't grow across spawns.
    reapTracked();

    const pid_t parentPid = ::getpid();  // for the child's fork-race death check
    const pid_t pid = ::fork();
    if (pid < 0) {
        LOG_ERR(Core, "fork (spawnChild): {}", std::strerror(errno));
        napi_value out;
        napi_create_int32(env, -1, &out);
        return out;
    }

    if (pid == 0) {
        // Child: die if the compositor (our parent) dies, even by crash/SIGKILL,
        // so a spawned client is never orphaned holding GPU memory. PDEATHSIG
        // survives execve. Guard the fork-vs-parent-death race: if the parent
        // already exited, getppid() is no longer the compositor -> exit now.
        ::prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (::getppid() != parentPid) _exit(0);
        // New session: the client is not in the compositor's terminal foreground
        // process group, so a tty Ctrl-C hits only the compositor (pdeathsig then
        // takes the client down). Does not affect the pdeathsig relationship.
        ::setsid();
        // Discard stdio.
        const int devnull = ::open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            ::dup2(devnull, STDIN_FILENO);
            ::dup2(devnull, STDOUT_FILENO);
            ::dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO) ::close(devnull);
        }
        for (const std::string& kv : envOverrides) {
            const auto eq = kv.find('=');
            if (eq == std::string::npos) continue;
            ::setenv(kv.substr(0, eq).c_str(), kv.substr(eq + 1).c_str(), 1);
        }
        std::vector<char*> a;
        a.push_back(const_cast<char*>(command.c_str()));
        for (const std::string& s : argv) a.push_back(const_cast<char*>(s.c_str()));
        a.push_back(nullptr);
        ::execvp(command.c_str(), a.data());
        ::perror("execvp (spawnChild)");
        _exit(127);
    }

    {
        std::lock_guard<std::mutex> lk(g_mu);
        g_pids.push_back(pid);
    }
    napi_value out;
    napi_create_int32(env, pid, &out);
    return out;
}

void onSigchld(uv_signal_t*, int /*signum*/) {
    reapTracked();
}

}  // namespace

void RegisterSpawn(napi_env env, napi_value exports) {
    const auto reg = [&](const char* name, napi_callback fn) {
        napi_value f;
        napi_create_function(env, name, NAPI_AUTO_LENGTH, fn, nullptr, &f);
        napi_set_named_property(env, exports, name, f);
    };
    reg("spawnChild", SpawnChild);

    // Reap spawn children on SIGCHLD via the node event loop. uv_signal_t
    // multiplexes with libuv's own SIGCHLD use, so this does not disturb node's
    // child_process reaping; unref keeps it from holding the loop open.
    uv_loop_t* loop = nullptr;
    if (!g_sigchldReady && napi_get_uv_event_loop(env, &loop) == napi_ok && loop != nullptr) {
        if (uv_signal_init(loop, &g_sigchld) == 0
            && uv_signal_start(&g_sigchld, onSigchld, SIGCHLD) == 0) {
            uv_unref(reinterpret_cast<uv_handle_t*>(&g_sigchld));
            g_sigchldReady = true;
        }
    }
}

}  // namespace overdraw::core
