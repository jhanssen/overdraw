#include "server.h"

#include <cstdio>
#include <string>
#include <vector>

#include <fcntl.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

namespace overdraw::xwayland {

XwaylandSpawn spawnXwayland(const XwaylandOptions& opts) {
    XwaylandSpawn out;
    if (opts.waylandDisplay.empty()) {
        std::fprintf(stderr, "[xwayland] no WAYLAND_DISPLAY to connect to\n");
        return out;
    }

    int dpyFds[2];  // [0] parent read, [1] child write (Xwayland -displayfd)
    if (::pipe(dpyFds) != 0) {
        std::perror("pipe");
        return out;
    }

    // WM channel: a connected stream socketpair. The XWM's xcb connection lives
    // on our end (wmFds[0]); Xwayland gets the other via -wm.
    int wmFds[2] = {-1, -1};
    if (opts.enableWm && ::socketpair(AF_UNIX, SOCK_STREAM, 0, wmFds) != 0) {
        std::perror("socketpair (wm)");
        ::close(dpyFds[0]);
        ::close(dpyFds[1]);
        return out;
    }

    const pid_t parentPid = ::getpid();  // for the child's fork-race death check
    const pid_t pid = ::fork();
    if (pid < 0) {
        std::perror("fork");
        ::close(dpyFds[0]);
        ::close(dpyFds[1]);
        if (opts.enableWm) { ::close(wmFds[0]); ::close(wmFds[1]); }
        return out;
    }

    if (pid == 0) {
        // Child: die if the core (our parent) dies, so Xwayland is never
        // orphaned. Guard the fork-vs-parent-death race (getppid() != parentPid
        // means the parent already exited and we were reparented).
        ::prctl(PR_SET_PDEATHSIG, SIGKILL);
        if (::getppid() != parentPid) _exit(0);
        ::close(dpyFds[0]);
        if (opts.enableWm) ::close(wmFds[0]);
        // Keep the displayfd + wm write ends + stdio open across exec
        // (Xwayland's diagnostics reach the same destination as the core's).
        ::fcntl(dpyFds[1], F_SETFD, 0);
        if (opts.enableWm) ::fcntl(wmFds[1], F_SETFD, 0);
        ::fcntl(STDOUT_FILENO, F_SETFD, 0);
        ::fcntl(STDERR_FILENO, F_SETFD, 0);

        ::setenv("WAYLAND_DISPLAY", opts.waylandDisplay.c_str(), 1);
        // Rootless Xwayland is itself the X server; it must not find a prior
        // DISPLAY and try to nest into it.
        ::unsetenv("DISPLAY");

        char dfd[16];
        std::snprintf(dfd, sizeof(dfd), "%d", dpyFds[1]);
        const std::string path =
            opts.xwaylandPath.empty() ? std::string("Xwayland") : opts.xwaylandPath;

        // No display arg + -displayfd: Xwayland picks the first free display,
        // creates its X11 sockets, and writes the chosen number to the pipe.
        char wmfdArg[16];
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(path.c_str()));
        argv.push_back(const_cast<char*>("-rootless"));
        if (opts.terminate) argv.push_back(const_cast<char*>("-terminate"));
        argv.push_back(const_cast<char*>("-displayfd"));
        argv.push_back(dfd);
        if (opts.enableWm) {
            std::snprintf(wmfdArg, sizeof(wmfdArg), "%d", wmFds[1]);
            argv.push_back(const_cast<char*>("-wm"));
            argv.push_back(wmfdArg);
        }
        argv.push_back(nullptr);
        ::execvp(path.c_str(), argv.data());
        ::perror("execvp Xwayland");
        _exit(127);
    }

    // Parent: keep the read end (non-blocking, for uv_poll), close the write end.
    ::close(dpyFds[1]);
    ::fcntl(dpyFds[0], F_SETFL, ::fcntl(dpyFds[0], F_GETFL, 0) | O_NONBLOCK);
    out.pid = pid;
    out.displayReadFd = dpyFds[0];
    if (opts.enableWm) {
        ::close(wmFds[1]);     // child's end
        out.wmFd = wmFds[0];   // the XWM's xcb connection fd
    }
    return out;
}

void reapXwayland(pid_t pid) {
    if (pid <= 0) return;
    int status = 0;
    for (int i = 0; i < 500; ++i) {  // ~0.5s grace for an already-clean exit
        if (::waitpid(pid, &status, WNOHANG) == pid) return;
        ::usleep(1000);
    }
    // SIGKILL, not SIGTERM: this is a synchronous reap on the node thread, and
    // that thread also runs our (single-threaded) Wayland server. On SIGTERM,
    // Xwayland tries to cleanly flush its Wayland connection -- which needs this
    // thread to service it -- so it blocks on Wayland I/O while we block on its
    // exit: a deadlock. SIGKILL is uncatchable, so Xwayland dies immediately
    // with no Wayland-dependent shutdown path.
    ::kill(pid, SIGKILL);
    ::waitpid(pid, &status, 0);
}

}  // namespace overdraw::xwayland
