# Client-buffer access lifecycle

The per-client-dmabuf-buffer access rules live in one pure state machine:
`packages/core/src/gpu/client-buffer-lifecycle.ts`. Every historical bug in
this area was a sequencing error (import-twice, begin-without-end,
acquire-once-instead-of-per-frame, release-too-early, release-the-wrong-
thing), so the rules are encoded once, GPU-free and exhaustively
unit-tested, and the executor (`gpu/compositor.ts` + the GPU process's
bracket handler) is a mechanical translator of the intents the machine
emits. The invariants are numbered and documented at the top of the
machine's source; the tests in `test/client-buffer-lifecycle.test.js` pin
them. This doc covers what the code cannot: how fences flow today, why
that shape is a known limitation, and the design that completes it.

## Fence flow today

Two fences matter per sampled client buffer: the ACQUIRE fence (client's
rendering must finish before the compositor samples) and the RELEASE
fence (compositor's sampling must finish before the client reuses).

- **Explicit sync** (wp_linux_drm_syncobj): the protocol layer materializes
  the client's acquire point to a sync_file and passes it into
  `commitSurfaceDmabuf`, which stashes it in `bufferIdToAcquireFenceFd`
  keyed by bufferId. The first bracket-open that samples that buffer
  (`beginClientAccess`) consumes it via `writeBeginAccessWithFence`;
  re-samples of the unchanged buffer fall back to no explicit wait.
  Replacement on a same-buffer re-commit closes the stale fd.
- **Implicit sync**: the GPU process exports the dmabuf's reservation
  fence (`DMA_BUF_IOCTL_EXPORT_SYNC_FILE`, write fences) once, at IMPORT
  time, and feeds it into that import's first BeginAccess.
- **Release**: the real end-of-access fence lives in the GPU process and
  is chained intra-process between brackets; the core never sees it.

The state machine is told none of this. Its `acquireFenceAvailable` event
is always fed `{ kind: "none" }`, its `endAccessFenceExported` event a
`fd: -1` sentinel, and it deliberately THROWS if a beginAccess intent
would ever carry a syncobj fence — a tripwire so the executor cannot
silently drop a real fence (the black-frame bug for explicit-sync
clients).

## The two known limitations

1. **The acquire-fence fd lifecycle is out-of-band.** Consume-exactly-once,
   replace-and-close-stale, and close-on-teardown for
   `bufferIdToAcquireFenceFd` are hand-maintained in the executor — the
   exact class of bookkeeping the machine exists to own and test.
2. **Cached re-commits skip the implicit acquire.** The implicit sync_file
   is exported once at import time. A buffer-cycling client that re-commits
   a CACHED buffer (rule A: supersede does not drop the cache) gets no
   fresh acquire wait on its new frame's writes. Explicit-sync clients are
   unaffected (per-commit fences via the map); implicit-sync clients rely
   on the sampling GPU work being slower than their render, which is
   timing, not correctness.

## Completed design

### Step 1 — the machine owns acquire fences (no behavior change)

- `commitSurfaceDmabuf` feeds the real fence:
  `{ kind: "syncFile", fd }` when the commit carried one, else
  `{ kind: "none" }`. Syncobj points are materialized to sync_file BEFORE
  the machine, as today; the machine never sees a raw syncobj.
- The machine stores it as `pendingAcquireFence` (field already exists),
  emits it on the FIRST beginAccess intent that samples the buffer after
  that commit, and clears it (consume-once semantics, matching today's
  map-delete).
- New intent `{ kind: "discardAcquireFence"; bufferId; fence }` emitted
  when a pending fence is superseded by a newer commit's fence, or when
  bufferDestroyed / surfaceRemoved-drain tears the buffer down with a
  fence still pending. The executor closes the fd. This moves the
  replace-and-close and close-on-teardown paths under test.
- Executor: `beginClientAccess` becomes a translation of the intent —
  `writeBeginAccessWithFence(importId, intent.acquireFence.fd)` for
  syncFile, `writeBeginAccess(importId)` for none. The
  `bufferIdToAcquireFenceFd` map is deleted.
- The syncobj tripwire is retired with the feature: beginAccess carrying
  syncFile is now the implemented path; carrying syncobj still throws.
- Unit tests (pure, GPU-free): fence consumed exactly once on first
  sample; re-sample of unchanged buffer carries none; same-buffer
  re-commit discards the stale fence; teardown with pending fence
  discards; fence never crosses buffers.

Step 1 is a refactor with byte-identical wire behavior — verifiable by
the existing GPU suite alone.

### Step 2 — per-sample implicit acquire (fixes limitation 2)

- The wire Begin frame (`ClientTexAccessPayload`) gains a flag byte:
  `implicitAcquire`. On decode, the GPU process re-exports the dmabuf's
  current write-reservation sync_file (helper already exists:
  `exportDmabufAcquireFence`) and imports it into that BeginAccess.
- The machine models it as acquire kind `"implicit"`: emitted on the
  first beginAccess after a commit that carried no explicit fence.
  Re-samples of an unchanged buffer stay `"none"` (the first sample
  already waited the client's writes; later samples read an unchanged
  dmabuf).
- Cost: one ioctl per commit-then-first-sample, GPU-process side, off the
  core's frame path.

Step 2 changes sampling behavior for implicit-sync clients and needs
bare-metal verification (an implicit-sync client under load; NVIDIA,
which attaches no implicit fences, must show no regression on the
explicit path).

### Explicitly out of scope

Routing the RELEASE fence through the machine: the real end fence is
chained inside the GPU process and never crosses to the core; modeling
its value in the machine would be bookkeeping without authority. The
`endAccessFenceExported` sentinel remains what it is — an ordering event,
not a fence carrier.
