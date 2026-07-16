# The wayland event-loop watcher thread

Why `wayland/server.cpp` watches libwayland's event-loop fd from a dedicated
thread instead of `uv_poll`, what is actually known about the failure that
motivated it, and what to do next. The threading design itself lives in
`architecture.md` "frame pacing and threading".

**Status: the motivating bug is diagnosed only partially, and the fix is
unverified.** Read "What is not established" before building on any of this.

## What the code does

`Server::start` spawns a watcher thread that blocks in `poll(2)` on
`wl_event_loop_get_fd()` plus a stop eventfd. On readiness it kicks a
`uv_async` into the node loop; `onAsync` dispatches on the main thread and
then posts `dispatchedSem_`, releasing the watcher to poll again. The
ping-pong means the watcher never spins ahead of a dispatch the main thread
has not performed, and level-triggered `poll(2)` re-reports anything left
undrained.

The thread is only a readiness notifier. Every per-socket read still happens
on the main thread inside `wl_event_loop_dispatch`.

## The reported failure

On one machine (Arch-based, node 26), wayland client dispatch stalls: the
watcher delivers one event and then goes permanently deaf, starving all
clients whenever nothing else wakes the loop. It does not reproduce on
ubuntu / node 24.

## What is established

Verified by reading libuv v1.51.0 and v1.52.1 and by running a reproducer
(appendix) on kernel 7.0:

- **The libuv version is not the cause.** `src/unix/poll.c` changed exactly
  once between 1.51.0 and 1.52.1 (`3813460d`, callback pointer -> enum), which
  is behaviourally nil. `src/unix/linux.c` has no change in the epoll or
  io_uring `epoll_ctl` path; its diff is the `uv__io_poll_prepare`/`check`
  extraction, an io_uring *ftruncate* fix, and cgroup/cpuinfo changes. The
  `POLLERR` branch below dates to `d731fd1b` (2016) and is identical in both.
- **The two machines get libuv differently**, which is where "libuv 1.52" in
  commit `8dc5de9` came from: ubuntu's node bundles libuv **statically**
  (1.51.0; no `libuv.so` in `ldd $(which node)`), while Arch's `nodejs`
  depends on **shared** libuv (1.52.1). Real observation, but not causal --
  the relevant code is the same in both.
- **`uv_poll` on a nested epoll fd works.** The reproducer (inner epoll fd
  holding a level-triggered pipe, watched by `uv_poll`, woken from a separate
  thread so nothing else stirs the loop) delivers 10/10 events on 1.51.0,
  1.52.0 and 1.52.1, with io_uring both enabled and disabled. libuv's
  io_uring `epoll_ctl` batching ring is confirmed active on this kernel
  (`io_uring_setup(256, ...)` via strace), so that path is exercised, not
  skipped.
- **The wl event loop contains only wayland sockets.** overdraw registers
  nothing of its own (no `wl_event_loop_add_fd`/`add_timer`/`add_signal`), so
  the epoll holds the `AF_UNIX`/`SOCK_STREAM` listening socket from
  `wl_display_add_socket_auto`, one accepted client connection per client, and
  libwayland's own internal sources.

## What is not established

- **Why it fails.** The remaining variables are node 26 vs 24 and the
  CachyOS kernel -- not libuv. Unknown.
- **Whether the watcher thread fixes it.** Never confirmed on hardware. It
  removes the `uv_poll` failure modes below by construction, but nobody has
  observed the stall disappear.
- **Whether `POLLERR` is involved at all.** See the hole in that theory below.

## How a `uv_poll` watcher goes permanently deaf

With a level-triggered fd, a healthy `uv_poll` cannot go deaf -- the kernel
re-reports readiness every cycle. There are only three paths in libuv that
disarm one, and they have distinct signatures:

1. **`POLLERR` self-disarm** (`src/unix/poll.c`, `uv__poll_io`): on
   `POLLERR` without `POLLPRI`, libuv calls `uv__io_stop` + `uv__handle_stop`
   and reports `UV_EBADF`. Nothing rearms it.

   `UV_EBADF` here is **not** an `EBADF` diagnosis -- libuv never checks the
   fd, never calls `getsockopt(SO_ERROR)`, and blanket-relabels any `POLLERR`
   as `UV_EBADF`. Per `epoll(7)` an fd is auto-removed from the interest list
   once all descriptors for the open file description are closed, so a
   genuinely dead fd yields *no events*, not `POLLERR`. A `POLLERR` arriving
   via epoll means the fd is still valid. (Exception: a `dup` keeps the
   description, and the epoll entry, alive after the number is closed.)

   Signature: callback fires once with `status == -9`, then silence.

2. **Watcher/kernel disagreement** (`src/unix/linux.c`, `uv__io_poll`): if
   `loop->watchers[fd]` is `NULL` while the fd is still registered, libuv
   issues `EPOLL_CTL_DEL` and **never calls the callback at all**. Silent.

   Signature: no further callbacks, no status, nothing logged.

3. **`uv__platform_invalidate_fd`**, reached via `uv__poll_stop`.

**The hole in the `POLLERR` theory:** nested epoll collapses inner conditions
to `EPOLLIN`. An epoll file's poll operation reports `EPOLLIN` iff its ready
list is non-empty; it does not forward the *nature* of inner events. So a
client socket going `POLLERR`/`POLLHUP` inside the wl epoll surfaces to libuv
as plain `EPOLLIN`, and an epoll file does not report `EPOLLERR` from its own
poll op. No plausible `POLLERR` source for this fd has been identified.

Path 2 fits the evidence better. libuv keys everything by fd **number**
(`loop->watchers[fd]`, `e.data.fd = w->fd`), making it sensitive to fd reuse
and stray closes -- and node 24 and node 26 do not allocate the same fd
numbers, which would flip machine-to-machine while libuv stayed identical.
See the open fd-churn follow-ups (`CommitDmabuf` peek+close, fd-0-free churn)
and the SCM_RIGHTS passing across the wire. This is a hypothesis, not a
finding.

## Known issues in the current implementation

- **Re-entrant `stop()` is unsafe.** `onAsync` runs `onPump_`/`dispatchScope_`,
  which reach into JS. If any path there triggers shutdown, `stop()` joins the
  watcher and calls `uv_sem_destroy(&dispatchedSem_)`, then the stack unwinds
  back into `onAsync`, which posts to a destroyed semaphore. Guard with a flag
  checked after the dispatch body.
- **Persistent `POLLERR` would spin.** `watchLoop` treats `POLLERR` as a
  dispatch condition. That is the right call for a transient error (dispatch
  lets libwayland surface the per-source error and drop the client), but if the
  condition never clears, `poll` returns immediately forever: dispatch ->
  `sem_post` -> `poll` -> `POLLERR` -> repeat, burning both threads. The old
  code went deaf; this one may burn a core.
- **`POLLNVAL` busy-spins.** It is not in the `(POLLIN | POLLERR | POLLHUP)`
  test, so an invalid `wlFd_` makes `watchLoop` `continue` and re-poll at 100%
  CPU. Unreachable on the normal path (`stop()` joins before
  `wl_display_destroy`), but a silent hard spin is a bad failure mode.
- **`errno` is used in `watchLoop` without `<cerrno>`**, compiling only via a
  transitive glibc include.

## Recommendations

1. **Diagnose before hardening.** The thread is currently insurance against an
   unidentified cause. Establish the mechanism first; the answer decides
   whether the thread is necessary or whether a smaller fix is.
2. **Never swallow `uv_poll` status.** The removed code was
   `if (status < 0) return;`, which turned a *reported* failure into an
   invisible permanent stall. Whatever the root cause, that line was a bug on
   our side: libuv said the watcher died and we discarded the message. Audit
   the other `uv_poll_start` sites (wire, ctrl, libinput, seat, xwayland, xwm)
   for the same pattern -- those are sockets and char devices, where `POLLERR`
   is far more plausible than on an epoll fd, and a swallowed status silently
   kills the GPU wire or input.
3. **Do not treat `POLLERR` as fatal.** Dispatch on it and let libwayland drop
   the broken client. If a smaller fix than a thread is wanted, this plus
   logging the status is it -- `POLLERR` is recoverable in nearly every case
   (see the `UV_EBADF` note above).
4. **Check `uv_poll_init`'s return value.** The removed code ignored it.
5. **Fix the re-entrancy and `POLLNVAL` issues above** regardless of outcome.
6. **Record the environment in bug commits.** "libuv 1.52" named a library
   that turned out not to be the variable, and omitted node version and distro
   -- the things that actually differ.

## Diagnosing on the failing machine

Arch links libuv dynamically, so an instrumented build can be swapped under
node **without rebuilding node**:

```
cd libuv && git checkout v1.52.1     # match the system version
# add logging to the three disarm paths above, then build, then:
LD_PRELOAD=/path/to/build/libuv.so.1 <run overdraw>
```

`LD_PRELOAD` is preferred over `LD_LIBRARY_PATH`, which loses to `DT_RPATH`
if node has one. Confirm the override took, rather than assuming:

```
grep libuv /proc/<node-pid>/maps      # must show the instrumented path
node -p process.versions.uv           # still 1.52.1
```

The addon inherits it: `overdraw.node` does not link libuv itself, so its
`uv_*` symbols resolve from whatever node loaded.

Cheapest first step, before any instrumentation -- restore the `uv_poll` path
and log instead of swallow:

```c
if (status < 0) { fprintf(stderr, "[wl] uv_poll DIED: %s\n", uv_strerror(status)); return; }
```

Combined with the target of `/proc/self/fd/<wlFd_>` at stall time, this
separates the candidates: `status == -9` implicates path 1; no callback at all
plus an fd that is no longer `anon_inode:[eventpoll]` implicates path 2; and
neither would mean the mechanism is something not yet considered.

## Appendix: nested-epoll reproducer

Mirrors the wayland setup: inner epoll fd ~ `wl_event_loop_get_fd()`, pipe ~ a
client socket, callback drain ~ `wl_event_loop_dispatch`. Writes arrive from a
separate thread so nothing else wakes the loop. On Arch, building against
`-luv` exercises the same libuv code node runs. PASS = 10 callbacks; FAIL = 1,
then deaf.

```c
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <unistd.h>
#include <uv.h>

#define N_WRITES 10
static int inner_epfd, pipefd[2], callbacks, drained;
static uv_poll_t poller;
static uv_async_t stopper;

static void on_readable(uv_poll_t* h, int status, int events) {
    struct epoll_event evs[8];
    int n;
    printf("  callback #%d (status=%d %s, events=%d)\n", ++callbacks, status,
           status < 0 ? uv_strerror(status) : "ok", events);
    n = epoll_wait(inner_epfd, evs, 8, 0);   /* ~ wl_event_loop_dispatch */
    for (int i = 0; i < n; i++) { char b[64]; if (read(pipefd[0], b, sizeof(b)) > 0) drained++; }
    fflush(stdout);
}
static void on_stop(uv_async_t* h) {
    uv_poll_stop(&poller);
    uv_close((uv_handle_t*)&poller, NULL);
    uv_close((uv_handle_t*)&stopper, NULL);
}
static void* writer(void* a) {
    for (int i = 0; i < N_WRITES; i++) { usleep(100000); write(pipefd[1], "x", 1); }
    usleep(400000);
    uv_async_send(&stopper);   /* wakes the loop even if uv_poll went deaf */
    return NULL;
}
int main(void) {
    struct epoll_event e;
    pthread_t t;
    printf("libuv %s\n", uv_version_string());
    inner_epfd = epoll_create1(EPOLL_CLOEXEC);
    if (pipe(pipefd)) return 1;
    memset(&e, 0, sizeof(e));
    e.events = EPOLLIN;        /* level-triggered, like libwayland */
    e.data.fd = pipefd[0];
    if (epoll_ctl(inner_epfd, EPOLL_CTL_ADD, pipefd[0], &e)) return 1;
    uv_async_init(uv_default_loop(), &stopper, on_stop);
    uv_poll_init(uv_default_loop(), &poller, inner_epfd);
    uv_poll_start(&poller, UV_READABLE, on_readable);
    pthread_create(&t, NULL, writer, NULL);
    uv_run(uv_default_loop(), UV_RUN_DEFAULT);
    pthread_join(t, NULL);
    printf("\n%d writes -> %d callbacks, %d drained: %s\n", N_WRITES, callbacks,
           drained, (callbacks >= N_WRITES && drained == N_WRITES) ? "PASS" : "FAIL");
    return 0;
}
```

Build and run both ways -- if `UV_USE_IO_URING=0` changes the verdict,
io_uring is implicated:

```
gcc -O1 -g repro.c -o repro -luv -lpthread
./repro
UV_USE_IO_URING=0 ./repro
```
