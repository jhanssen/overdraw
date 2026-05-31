# overdraw — agent notes

Project-specific operational notes. Design lives in `docs/architecture.md`;
ground-truth status in `docs/status.md`. Before working on any protocol, read the
"Protocol gaps & skeletons (READ FIRST)" section at the top of `docs/status.md` —
it lists what is advertised-but-incomplete (silent-gap risks: `xdg_toplevel`
WM-state no-ops, fabricated `wl_output`, `wl_region`).

## Debugging discipline (read first)

- **Surface architectural problems; do not patch over them.** If a bug's real
  cause is structural (e.g. a missing buffer-release lifecycle, a synchronous
  call blocking the event loop, no completion signal for GPU work), STOP and
  tell the user plainly: "this is an architectural problem — here is the
  fundamental issue." Do not stack symptomatic patches (timer guesses, eager
  releases, retry bumps) hoping one sticks. A string of small fixes that each
  "help a bit" but don't resolve it is the signature of papering over a design
  flaw — name it instead. Burning hundreds of thousands of tokens iterating on
  patches is the failure mode to avoid.
- **When you catch yourself theorizing in a loop, get ground truth instead of
  guessing.** After ~2 hypotheses that don't pan out, proactively ask the user
  to run under gdb (backtrace the suspect thread), or insert logging / counters /
  timing and run it — rather than reasoning about what *might* be happening.
  Measure, don't speculate. The user has the running system and a GPU; use them.
  Prefer a single decisive experiment (gdb backtrace, a counter, a timing print,
  a readback) over another round of plausible-sounding theory.
- Empirical claims about the driver, Dawn, the client, or the kernel are
  hypotheses until verified by a test in the current session. Verify before
  building on them.

## Process management (GPU process)

The compositor fork+execs a separate `overdraw-gpu-process`. When running tests
or harnesses that call `addon.start(...)`, that child process must be tracked
and cleaned up carefully.

- **Do NOT identify the GPU process with `pgrep`/`pkill` by name.**
  - `pgrep -x overdraw-gpu-process` finds nothing: the name is >15 chars, so it
    is truncated to `overdraw-gpu-pr` in `/proc/<pid>/comm` and `pgrep -x` warns
    and returns zero matches.
  - `pgrep -f overdraw-gpu-process` is worse: `-f` matches the full command
    line, so it ALSO matches the shell/monitor script and the `node` process
    that have that string in their argv. Reading `/proc/<that pid>/wchan` then
    reports the wrong process (e.g. a shell parked in `sigsuspend`), which has
    sent debugging down a false path more than once.
- **Track the PID directly instead.** The addon knows the child pid
  (`spawnGpuProcess` returns it; `Compositor` holds `gpuPid_`). For ad-hoc
  inspection, capture the pid when you launch (e.g. write it to a file, or use
  the node child handle's `.pid`) and use `/proc/<pid>/...` with that exact pid.
- When you must discover it, filter by the truncated comm and exclude
  shells/node explicitly, and verify `comm` before trusting any `/proc` read:
  for `p` in candidates, check `cat /proc/$p/comm` is `overdraw-gpu-pr` (not
  `zsh`/`node`) before reading `wchan`/`stat`/`stack`.
- Per-thread state matters: the main thread is `tid == pid`; Vulkan driver
  threads (`[vkcf]`, `[vkrt]`, `[vkps]`) idle in `futex_do_wait` normally — that
  is not a hang. The interesting thread is usually the main one.
- **Always clean up after a test run**, and confirm zero remain (by exact pid,
  not name). Leaked GPU processes pile up across runs and hold the GPU.

## Crash vs. hang

- The GPU process installs a crash handler that writes a backtrace to
  `/tmp/overdraw-gpu-crash.txt` on SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE
  (`gpu-process/src/main.cpp`). **Before assuming a crash, check that file.**
  Absent file + live process in a kernel wait (`/proc/<pid>/wchan`) = a hang/
  deadlock, not a crash.
- A GPU main thread in `drm_syncobj_array_wait_timeout` is blocked on a
  DRM/Vulkan fence (e.g. inside `DeviceTick` waiting on submitted work). Often a
  synchronization/present-pacing entanglement, not a dead process.

## Running tests that need the GPU + host Wayland

- Tests that call `addon.start(gpuBin)` require a live host Wayland session
  (`WAYLAND_DISPLAY` set) and the GPU. They are NOT pure `node --test`. Pure
  protocol/trampoline tests (server-only) do not need the GPU process.
- The bash tool may appear to "time out" on commands that background a child
  holding the shell's stdout/stderr fds open — the command logic completed; the
  tool is waiting on fd EOF. Redirect child output to files and/or fully detach
  to avoid this.

## Testing policy (new protocols)

- **Every new Wayland protocol gets a test.** When you add or extend a protocol
  handler, add a unit test that exercises that protocol IN ISOLATION (its
  requests/events, opcodes, the specific behavior it adds) — not just "it didn't
  crash." Prefer the cheapest tier that proves the behavior:
  - pure-unit / structural (`test/**/*.test.js`, GPU-free) when the logic can be
    tested without the GPU/compositor (e.g. generator metadata, state transitions);
  - the integration harness (`test/*.gpu.mjs`, `setupCompositor` + a real client +
    `state.query()` / `frameReadback` / client-reported stdout) when it needs the
    live server.
- **If isolating the protocol genuinely doesn't make sense** (the behavior only
  manifests through interaction with other protocols, compositing, focus, etc.),
  then write a MORE COMPREHENSIVE test that covers it end-to-end through that
  interaction — and say so explicitly. Do not skip coverage and call it a "stub":
  a stub with no test is an untested path, which violates the no-gaps rule above.
  If you believe a protocol truly cannot/should not be tested yet, flag it to the
  user with the reason rather than silently leaving it uncovered.
- Keep `npm test` GPU-free; GPU/host-Wayland tests go in `test/*.gpu.mjs`
  (`npm run test:gpu`). No interactive (human-in-the-loop) tests.

## Bisecting wire / device-async issues

- Device/queue-level async ops over the Dawn wire (buffer `MapAsync`,
  `OnSubmittedWorkDone`) require the GPU process to advance the device queue via
  `dawn::native::DeviceTick(device)` — `InstanceProcessEvents` alone only drives
  instance-level ops (`RequestAdapter`/`RequestDevice`). See
  `gpu-process/src/main.cpp` pump loop.
- Buffer mapping over the wire may also need a `MemoryTransferService`
  (client + server) to shuttle mapped bytes; the wire descriptors set it to
  `nullptr` today.
