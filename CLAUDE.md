# overdraw — agent notes

Project-specific operational notes. Design lives in `docs/architecture.md`;
ground-truth status in `docs/status.md`. Before working on any protocol, read the
"Protocol gaps & skeletons (READ FIRST)" section at the top of `docs/status.md` —
it lists what is advertised-but-incomplete (silent-gap risks: `xdg_toplevel`
WM-state no-ops, fabricated `wl_output`, `wl_region`).

## Comments describe the code, not its history

Code comments describe what the code does right now. Never reference past
decisions, prior states, build phases, refactors, deleted code, or "what
this used to do." A reader a month from now has no context for any of that.
Forbidden in comments:

- Phase / milestone references ("Phase 2", "phase 0b", "post-Phase 3",
  "build-order.md phase 1"). The reader has never heard of phases.
- "Previously", "formerly", "no longer exists", "used to be", "rewritten",
  "moved from", "extracted from", "migrated to", "now lives in", "replaces
  the X path". Just describe what IS, not what WAS.
- Forward-looking ("Phase 6 will...", "future X"). Describe today's
  behavior; if a future change is genuinely relevant, frame it as a current
  limitation in `docs/status.md`, not a comment.
- Diff narration ("this fixes...", "this was changed to..."). Belongs in
  the commit message, not the source.

Allowed:

- Describing current behavior using verbs that incidentally look historical
  ("the surface no longer exists" = describes runtime state; "the previous
  buffer is superseded" = describes algorithm state). Test: would a reader
  who never saw the prior version of the code understand the comment? If
  yes, fine.
- Cross-references to design docs (`core-plugin-api.md §14`, `architecture.md
  "Frame clock"`) for rationale that lives elsewhere.

**When you change behavior, rewrite the comment.** Not "amend" — rewrite,
so the comment describes the new behavior with no trace of the old. A
comment that says "X now does Y (used to do Z)" is wrong; just say "X
does Y." If you edit a function, re-read every comment in/above it and
ask: would this comment still make sense to a reader who never saw the
previous version? If no, replace it.

When refactoring or extracting code, scrub the comments at the same time.
A comment that survives a refactor unchanged is usually stale.

## Comments must earn their place

Sparse comments, not paragraphs. The bar is high: the comment must tell
the reader something the code itself doesn't already say. Files where the
comments outweigh the code are a smell — they usually mean the same
information is being said three times (the code, the doc-comment, the
explanatory prose).

Worth keeping:

- A short module-level orientation (one paragraph, max) for what the file
  is and how it fits.
- Why something is non-obvious: a subtle invariant, an unusual ordering
  constraint, a contract with a peer module that isn't visible from this
  file, or a reason the obvious-looking alternative is wrong.
- Cross-references to design docs where rationale legitimately lives
  elsewhere.

Cut:

- Restating what the code does in prose ("Validate the config; throw on
  bad input" above `validateConfig`).
- Explaining well-known language features (closures, await, generics).
- Documentation-style header comments on internal helpers (`// Returns
  the foo.` above `function getFoo(): Foo`).
- Listing decided-not-to-do options inside a function body. If the
  rejection rationale matters, it goes in the design doc.
- "Why X and not Y" mini-essays when the choice is in a doc — link the
  doc instead.
- Boilerplate noise around obvious code ("Build the list", "Return the
  result").

Test for any given comment: does removing it make the code harder to read
or to maintain correctly? If no, delete it.

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
- `node --test` (the GPU test driver) ALSO trips this in inline mode. With
  output going straight to the bash tool's stdout, a multi-test suite stalls
  *during a test* even though the test itself is fine -- the suite was simply
  emitting output faster than the tool buffer drained, and the next `setTimeout`
  / `await` happened to fire while the parent was blocked on the pipe. The
  symptom is "second test in the file appears to hang." Redirect to a file
  (`> /tmp/test.log 2>&1`) and the same suite runs to completion. **If you
  think a GPU test has hung, redirect to a file before concluding so.**

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
- `npm test` runs BOTH tiers: it builds (js + native) then runs the GPU-free
  unit tests (`test/**/*.test.js`) AND the GPU tests (`test/**/*.gpu.mjs`,
  serialized). GPU tests must stay self-skipping so this is safe everywhere:
  headless tests skip without `dawn.node`; nested tests skip without a Wayland
  session (`canRunGpu()` = `WAYLAND_DISPLAY` set). `test:unit` / `test:gpu` are
  build-less sub-targets for iteration. GPU tests are part of the default run
  ON PURPOSE — keeping them separate let a readback regression slip through
  unnoticed across many commits. Do NOT split them back out. No interactive
  (human-in-the-loop) tests.
- **Do not COMMIT artifacts you already know you'll delete.** Verifying
  throwaway / scaffolding code (incremental milestone steps you'll replace,
  spikes) is still required — surface problems early. But the act of *committing*
  a test (or any file) you know is transient creates add-then-remove churn in the
  history, which is the waste. So: verify in the working tree (a scratch script,
  a temporary `test/` file you run via `node --test <file>` directly, a temporary
  assertion) and DELETE it before committing — it never enters git. Only commit
  tests for code meant to PERSIST. Decide "is this path throwaway?" BEFORE you
  commit, not after. Anti-pattern from this project: committing
  `plugin-connect.gpu.mjs` / `plugin-surface-fence.gpu.mjs` for the main-thread
  plugin path in one commit, then deleting them when the Worker path landed — the
  verification was right; committing the transient tests was not.

## Bisecting wire / device-async issues

- Device/queue-level async ops over the Dawn wire (buffer `MapAsync`,
  `OnSubmittedWorkDone`) require the GPU process to advance the device queue via
  `dawn::native::DeviceTick(device)` — `InstanceProcessEvents` alone only drives
  instance-level ops (`RequestAdapter`/`RequestDevice`). See
  `gpu-process/src/main.cpp` pump loop.
- Buffer mapping over the wire may also need a `MemoryTransferService`
  (client + server) to shuttle mapped bytes; the wire descriptors set it to
  `nullptr` today.
