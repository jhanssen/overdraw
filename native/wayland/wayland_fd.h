// WaylandFd: the JS-facing wrapper for a file descriptor handed up from the
// trampoline (request fd args). The dup'd fd lives in a napi external owned by
// the JS object; there is no native fd table.
//
// Ownership / lifetime:
//   - Created OPEN, holding a dup'd fd.
//   - takeRawFd(): transfers the raw fd out (to native or a Node API), marks the
//     wrapper consumed; the finalizer will NOT close it. Throws if already
//     taken/closed.
//   - close(): closes the fd now. No-op if taken/closed.
//   - Finalizer (GC): closes the fd iff still OPEN, and warns -- reaching this
//     means JS leaked the wrapper (well-behaved code takes or closes it).
//
// Native consumers (shm pool, dmabuf import) call takeFd() to pull the raw fd
// out of a WaylandFd object directly (no JS round-trip of the integer).

#ifndef OVERDRAW_WAYLAND_WAYLAND_FD_H_
#define OVERDRAW_WAYLAND_WAYLAND_FD_H_

#include <node_api.h>

namespace overdraw::wayland {

// Build a WaylandFd JS object owning `fd` (already dup'd; the object closes it
// on finalize unless taken/closed). `fd` may be -1 (a null/invalid fd).
napi_value makeWaylandFd(napi_env env, int fd);

// Pull the raw fd out of a WaylandFd object, transferring ownership to the
// caller (who must close it) and marking the wrapper taken. Returns -1 if the
// value is not a WaylandFd or was already taken/closed. Used by native
// consumers (e.g. commitSurfaceDmabuf, shmCreatePool).
int takeWaylandFd(napi_env env, napi_value obj);

// Return a dup of the WaylandFd's fd WITHOUT consuming the wrapper (it stays
// valid for reuse). Caller owns/closes the returned fd. -1 if invalid/taken.
// Used for dmabuf wl_buffers, which a client re-attaches many times: the fd
// must survive across commits, so the import path dups instead of taking.
int peekWaylandFd(napi_env env, napi_value obj);

}  // namespace overdraw::wayland

#endif  // OVERDRAW_WAYLAND_WAYLAND_FD_H_
