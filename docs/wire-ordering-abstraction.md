# Requirements: generalize wire/ctrl cross-channel ordering (and fix decoration resize)

Status: IMPLEMENTED (see the "Implementation notes (post-hoc)" section at the
bottom of this doc for what was actually built vs. what this spec described,
and which empirical claims in the spec turned out to be wrong).

This was a handoff spec for a fresh implementer. Read it for context. It has
two deliverables: (A) an abstraction that removes a repeatedly-reinvented
ordering pattern, and (B) the concrete bug that motivated it.

The tree is clean at commit `7ac6aa6` (`feat(wm): master-stack tiling ...`); `npm
test` and `npm run test:gpu` pass there. A prior attempt at deliverable B was
abandoned and fully reverted (it is NOT in the tree). That attempt got the *idea*
right (defer the GPU-side inject until the handle recycle is applied) but captured
the ordering serial at the wrong moment and bolted a third ad-hoc queue on instead
of abstracting. Implement this from scratch per the spec; don't reconstruct the
abandoned attempt.

## 1. Background: the system

overdraw is a nested Wayland compositor. Three processes / two async channels matter
here (see `docs/architecture.md` "IPC (three sockets)"):

- **core** (Node + N-API addon, Dawn **wire client**) — hosts protocol/WM/compositing
  JS and the plugin runtime.
- **GPU process** (native Dawn + **wire server**) — owns the real GPU, GBM allocator,
  the host output.
- **plugin Worker(s)** — each its own Dawn **wire client** on its own wire socket.

Two transports between core and GPU process:
- **wire socket** (`SOCK_STREAM`, length-prefixed): Dawn wire commands (object
  create/destroy, render commands). Plugin Workers have their OWN wire socket to the
  GPU process.
- **control side channel** (`SOCK_SEQPACKET`): fixed-size POD messages
  (`native/ipc/side_channel.h`), incl. `ImportClientTex`, `AllocSurfaceBuf`,
  `ProducerEnd`, `ReleaseSurfaceBuf`. SCM_RIGHTS fd passing here.

### The hazard this is all about: recycled wire handles across two channels

Dawn wire object handles are `{id, generation}`. **Ids are recycled**: after a
handle is reclaimed (`ReclaimTextureReservation` -> emits an `UnregisterObjectCmd`
on the wire), the next `ReserveTexture` reuses the id at `generation+1`.

A texture is *reserved* on one channel (wire) but *injected/imported/released* via
the other (ctrl). For an inject at a recycled id to succeed, the GPU-process wire
server **must have already processed the wire commands up to the point of the
reserve** (the prior `UnregisterObjectCmd` that freed the id, and the new
`ReserveTexture` that re-created it at gen+1). If the ctrl-channel inject is
processed *before* the wire reader catches up, the inject targets a stale/occupied
handle and **fails**.

The codebase already solves this for client dmabuf import with a **wire-serial
happens-before**:
- core: after `ReserveTexture`, `link_->flush()`, capture
  `link_->wireBytesQueued()` (cumulative framed wire bytes = an ordering serial),
  tag the ctrl message with it. See `native/core/compositor.cpp:194-204`
  (`ImportClientTex`; serial captured `:198`, tagged `:202`).
- GPU process: hold the ctrl op in a "pending" queue until
  `wireReader.bytesConsumed() >= msg.wireSerial`, then run it. See
  `gpu-process/src/main.cpp:577-581` (`drainPendingImports`) and `:906-911`
  (defer-or-run on receipt).
- The serial counter is `FdSerializer::bytesQueued()` /
  `FrameReader::bytesConsumed()` in `native/ipc/transport.h:78,159` — they are
  defined to match (framed length prefix + payload), so "bytes queued by sender" ==
  "bytes the receiver must have consumed".

## 2. The problem: this pattern is copy-pasted, and the copies drift

The same "defer a ctrl op until the reader consumed past a serial" logic is
hand-rolled **twice** in `gpu-process/src/main.cpp` (and deliverable B needs a
third), each with its own struct, vector, and drain loop:

1. `pendingImports` (`main.cpp:371-372`, drain `:577-581`, defer-or-run `:906-911`)
   — gated on the **core** wire reader (`wireReader.bytesConsumed()`).
2. `pendingProducerEnds` (`:489-490`, drain `:491-503`, pushed `:780-781`, purged by
   surfaceBufId `:801-804`) — gated on a **plugin conn** reader
   (`pc->reader->bytesConsumed()`, `:496`).

(The decoration-resize fix in deliverable B will need a THIRD instance of this same
pattern — for the `AllocSurfaceBuf` inject. That is the whole point of the
abstraction: it should be a *use* of the shared barrier, not a third copy.)

And the send side captures the serial in multiple places in
`native/core/compositor.cpp` (`:198/202`, `:372`), each doing
flush-then-`wireBytesQueued()` by hand.

The drift / footgun that cost a day: the serial MUST be captured *after the wire
command is committed into the FdSerializer*. A Dawn wire client call like
`ReserveTexture` does not put bytes into our `FdSerializer` until the client's
serializer is flushed; reading `wireBytesQueued()` too early yields a serial BELOW
the reserve, so the GPU "catches up" before the reserve is actually applied and the
inject still fails. There is no single chokepoint that makes capturing-too-early
impossible — every call site can get it wrong independently.

## 3. Deliverable A: the abstraction

Goal: make the happens-before pattern exist in ONE place on each side, so (a) the
serial is always captured correctly and (b) "defer until applied" is one tested
code path that new ops reuse.

### A1. GPU process: a generic wire barrier (replaces the pending* vectors)

Add a small reusable type (suggested: `gpu-process/src/wire_barrier.h`, header-only):

```cpp
// Runs deferred actions once a wire reader has consumed past a recorded serial.
// One instance per reader (the core wire reader; one per plugin conn).
class WireBarrier {
 public:
  // Run `action` when this reader has consumed >= serial. If already satisfied,
  // runs immediately (synchronously) inside after().
  void after(uint64_t serial, std::function<void()> action,
             uint64_t consumedNow);
  // Reader advanced: run all now-satisfied actions in FIFO order.
  void drain(uint64_t consumedNow);
  // Drop deferred actions matching a predicate (e.g. surface destroyed before its
  // deferred op fired). Returns count dropped. Used where pendingProducerEnds is
  // currently filtered by surfaceBufId (main.cpp:842-845).
  size_t cancel(const std::function<bool(/* action tag */)>& pred);
  // Teardown: number still pending (for the fd-close-on-exit sweep at :1047-1048).
};
```

Design notes / requirements:
- FIFO order of satisfied actions (matches current vector iteration).
- `after()` runs immediately if already satisfied — preserves current behavior where
  most ops are not actually deferred.
- The `cancel`/tagging need: `pendingProducerEnds` is purged by `surfaceBufId` when a
  surface is released early (`main.cpp:801-804`). Either carry an opaque tag with
  each deferred action, or expose `cancel(pred)`. Don't lose this — dropping a
  deferred producer-end whose wire serial will never arrive is required (the comment
  just above it explains why).
- The deferred action for imports owns an fd that must be closed if never run
  (`main.cpp:1004-1005`). The barrier must run a cleanup on leftover actions at
  shutdown, or expose them for the caller to close. Keep fd ownership explicit.

Then **migrate the two existing queues onto it** with NO behavior change:
- `pendingImports` -> `coreWireBarrier.after(m.wireSerial, [=]{ runImport(m, fd); },
  wireReader.bytesConsumed())`. Drain at the same points (`:946,:957,:989`).
- `pendingProducerEnds` -> a per-conn barrier
  (`pc->barrier.after(serial, [=]{ runSurfaceEnd(...); }, pc->reader->bytesConsumed())`),
  drained where `drainPendingProducerEnds()` is called (`:980,:992`), cancelled by
  surfaceBufId where `:801-804` does.

VERIFY after migration: `npm run test:gpu` is fully green (the dmabuf, dmabuf-leak,
plugin-overlay, decoration, xdev-fence tests exercise both queues). This step is a
pure refactor; if any GPU test changes behavior, the abstraction is wrong — fix it
before moving on.

### A2. core + worker: capture the serial in ONE helper (make too-early impossible)

Add a single tagged-reservation helper on each wire-client side so no call site
reads the serial by hand:

- core (`native/core/compositor.*`): replace the inline
  reserve+flush+`wireBytesQueued()` at `compositor.cpp:194-202` with
  ```cpp
  struct TaggedReservation { dawn::wire::ReservedTexture rt; uint64_t wireSerial; };
  TaggedReservation reserveTextureTagged(uint32_t w, uint32_t h);
  // body: ReserveTexture; link_->flush(); return { rt, link_->wireBytesQueued() };
  ```
  Use its `.wireSerial` for the ctrl message tag. The point: flush is INSIDE the
  helper, between reserve and the serial read, so the serial is always correct.

- plugin worker (`native/plugin-napi/worker_wire.*`): `reserveProducerTexture`
  should return `{ texture, device, wireSerial }` where `wireSerial` is captured
  AFTER the commit-to-wire flush. CRITICAL: a Dawn wire client call is only
  committed into the FdSerializer when the CLIENT serializer is flushed. Verify the
  flush you call actually drains dawn.node's pending commands (the worker's
  `flush()`/`pump()` path is `link_->flush()` -> `WireClient::Flush`). If
  `wireBytesQueued()` does not advance across a `reserveProducerTexture` in a unit
  check, the flush is not committing the reserve — that is the exact trap from the
  abandoned attempt. Add a native or integration assertion that the serial strictly
  increases across a reserve, so this can't silently regress.

### A3. (optional, only if it falls out cleanly) a JS-side wrapper

The plugin SDK / gpu-broker thread the serial through `surface.bindProducer` ->
`AllocSurfaceBuf`. Keep the field name meaningful (it is a "reserve point serial",
not "reclaim serial" — the abandoned attempt mislabeled it `reclaimSerial`). Don't
over-engineer JS; the load-bearing abstraction is A1+A2.

## 4. Deliverable B: the actual bug to fix (the reason this exists)

Symptom: run the compositor with the example decoration plugin
(`test/fixtures/plugins/decoration-surface.mjs` via the plugin runtime, as the
decoration GPU tests wire it up). Map two windows whose app_id matches the provider.
**The second window shows only its (blue) decoration bar, not its content.**

Cause chain (all verified):
1. The WM is now a master-stack tiler (commit `7ac6aa6`). Mapping window 2 SHRINKS
   window 1's tile, so window 1's decoration must be redrawn at the new size.
2. The decoration is a plugin-owned GPU "ring" surface (producer/consumer dmabuf
   slots, injected into the GPU process at reserved wire handles). Resizing a ring
   means destroy-old + create-new (rings are fixed-size at alloc).
3. The re-allocation reuses recycled producer-texture wire handle ids while the GPU
   process still has the OLD textures injected there (their release is gated on a
   GPU read completing). `InjectTexture` at the occupied/stale handle FAILS
   (measured: GPU log `AllocSurfaceBuf id=N: alloc/import/inject failed`, the failing
   step is `InjectTexture` at the plugin-reserved handle).
4. The failed/stale decoration ends up painting over the neighbor window's content.

Required behavior after the fix: BOTH tiled windows show their own content, each with
its decoration drawn at its current tile size, after any number of
maps/unmaps/retiles. No leaked GPU buffers/fds across repeated resizes.

### The fix, using the abstraction

The decoration-resize plumbing above the GPU layer does NOT exist in the tree (a
prior version was reverted). You will (re)create it as part of this deliverable; it
is small and was a correct direction:
- WM detects a decorated window's outer tile changed on relayout, repositions the
  decoration surface, and notifies a decoration-resize sink. Suggested:
  `DecorationResizeSink` + `repositionDecoration()` called from `relayout()`/
  `unmapWindow()` in `src/wm/index.ts`; the WM `Window` already carries
  `decorationSurfaceId`/`insets`/`outer`.
- A `decoration.resized` event (`src/events/types.ts` `DECORATION_EVENT` +
  `DecorationResizedEvent { windowId, outerRect, contentRect, insets }`), emitted by
  the broker (`src/plugins/decoration-broker.ts`) to the owning plugin, wired via a
  settable `state.decorationResize` indirection so the WM need not know the broker.
- An `onResized(cb)` handler in the plugin SDK (`src/plugins/decorations.ts`,
  alongside `onAssigned`/`onDeregistered`) with an inbound payload validator.
- The example fixture (`test/fixtures/plugins/decoration-surface.mjs`) redraws its
  decoration at the new outer rect on `onResized` (destroy old ring surface, create
  a new one at the new size — destroy-before-recreate; keep per-window surface
  handles so the old one is destroyed first).

What's actually missing/broken is ONLY the ring realloc ordering. With A1+A2 in
place:

- The new ring's producer-texture reservation carries a correctly-captured wire
  serial (A2).
- `AllocSurfaceBuf` (ctrl) is deferred on the plugin-conn `WireBarrier` (A1) until
  that serial is consumed — i.e. until the GPU wire server has applied the
  `UnregisterObject` of the old handle AND the new `ReserveTexture`. Then the inject
  targets a fresh, reserved, un-injected handle and succeeds.
- Decide and document the reclaim ordering: EITHER (a) the old reservation's reclaim
  is ordered-before the new reserve on the same wire (so the recycle is clean), OR
  (b) defer reclaiming old producer reservations until the new ring has taken fresh
  ids (no id reuse at all). (b) is simplest and provably race-free; (a) matches the
  existing client-tex pattern. Pick one, write down why, don't do both.

### Don't forget the non-GPU half (already in `7ac6aa6`, keep it working)

- The old decoration surface must stop being drawn the instant it is replaced
  (the WM swaps `decorationSurfaceId`); do NOT `compositor.removeSurface()` a live
  wrapped ring texture from the WM — that throws in dawn.node (documented at
  `src/gpu/compositor.ts` `removeSurface`). Ring teardown is the gpu-broker's job.
- `surface.destroy` -> `afterCurrentFrame` -> `ReleaseSurfaceBuf` frees the old GPU
  textures only after the sampling frame completes; the realloc must be ordered
  after that release on the ctrl channel (FIFO) OR via the barrier. Make
  `await surface.destroy()` mean "old ring fully released" if the plugin relies on
  destroy-before-recreate.

## 5. Tests (required)

1. **Barrier unit test** (GPU-free, `test/*.test.js`): `WireBarrier` — immediate run
   when already satisfied, deferral + FIFO drain when not, cancel-by-tag, leftover
   cleanup. If `WireBarrier` is header-only C++, add a tiny native test target like
   `test/scm-rights-test.cpp` is wired, OR exercise it via a thin napi shim.
2. **Serial-capture regression** (native or integration): assert the wire serial
   strictly increases across a producer-texture reserve (guards the too-early trap).
3. **Two-window decoration GPU test** (`test/*.gpu.mjs`): the headless harness
   (`setupCompositor` + plugin runtime + `decoration-surface.mjs` fixture; model it
   on `test/decoration-surface.gpu.mjs` / `test/decoration-occlusion.gpu.mjs` for
   the runtime+broker wiring), map two windows with the matching app_id, assert via
   `frameReadback` that BOTH windows' content centers show the client color (not the
   decoration color). The `harness-client` supports `--fill-configured` (commit
   `7ac6aa6`) so a client fills its tile; use it. While developing, set
   `OVERDRAW_GPU_LOG` and confirm no `[gpu] AllocSurfaceBuf id=N: alloc/import/inject
   failed` appears.
4. Full `npm test` (GPU-free + lint) and `npm run test:gpu` green.

## 6. Process discipline (from CLAUDE.md — the abandoned attempt violated these)

- This IS a structural problem; the abstraction is the point. Do not stack
  symptomatic patches (multiple serial-gating variants) — that is exactly what
  burned a day here.
- After ~2 hypotheses that don't pan out, MEASURE: the GPU process honors
  `OVERDRAW_GPU_LOG=/path` (set it; it `freopen`s the GPU stdout+stderr to the file
  — `gpu-process/src/main.cpp:1329`). The GPU process's own stdout/stderr is NOT
  reliably captured by `node --test`, so use this env var to see
  `[gpu] AllocSurfaceBuf ... imported|failed` and add temporary granular logging to
  the four `ok = ...Inject/import...` steps to see WHICH fails. Remove such logging
  before committing.
- GPU process cleanup: track the child by exact pid, never `pgrep` by name (the comm
  is truncated to `overdraw-gpu-pr`). After any GPU test run, confirm zero
  `overdraw-gpu-pr` processes remain. See CLAUDE.md "Process management".
- Verify throwaway/scratch tests in the working tree and DELETE before committing;
  only commit tests for code meant to persist.

## 7. Key file/line index (at commit 7ac6aa6; re-grep, lines drift as you edit)

- Wire serial counter: `native/ipc/transport.h:78` (`bytesQueued_`), `:159`
  (`bytesConsumed_`).
- Client-tex happens-before (the GOOD reference pattern): send
  `native/core/compositor.cpp:194-202`; defer/run `gpu-process/src/main.cpp:577-581`
  (`drainPendingImports`) and `:906-911`; generation-matched client-tex release
  `:917` (`clientTextures.find` + generation check just below).
- Duplicated GPU-process queues to collapse: `pendingImports`
  (`main.cpp:371-372`, drain `:577-581`, defer-or-run `:906-911`),
  `pendingProducerEnds` (`:489-503`, push `:780-781`, purge-by-id `:801-804`).
  Drain call sites: `:946,:957,:980,:989,:992`. Shutdown fd sweep: `:1004-1005`.
- Producer-texture reserve/reclaim (worker): `native/plugin-napi/worker_wire.cpp`
  `reserveProducerTexture` (~`:74`), `releaseProducerTexture` (~`:96`); napi binding
  `native/plugin-napi/addon.cpp` `ReserveProducerTexture`/`ReleaseProducerTexture`.
- GPU-process AllocSurfaceBuf inject (where the failing `InjectTexture` lives):
  `gpu-process/src/main.cpp` `AllocSurfaceBuf` handler (~`:665`); the
  `ok = alloc.allocate(...)` -> `importTexture` x2 -> `InjectTexture` x2 chain at
  `:694-704` (the producer `InjectTexture` at `:699-701` is the one that fails on a
  recycled handle). Add temporary per-step logging here to confirm the failing step.
- Decoration resize plumbing to (re)create for deliverable B: `src/wm/index.ts`
  (add a `DecorationResizeSink`, `repositionDecoration`, hook into `relayout`),
  `src/plugins/decoration-broker.ts` (settable `state.decorationResize`),
  `src/plugins/decorations.ts` (`onResized` + validator), `src/events/types.ts`
  (`DECORATION_EVENT.resized` + `DecorationResizedEvent`),
  `test/fixtures/plugins/decoration-surface.mjs` (redraw on `onResized`). None of
  this is in the tree; it is small and described in section 4.

## 8. Definition of done

- One `WireBarrier` abstraction; `pendingImports` and `pendingProducerEnds`
  reimplemented on top of it with no GPU-test behavior change.
- One tagged-reservation helper per wire-client side; no call site reads the
  ordering serial by hand; a regression test pins serial-strictly-increases.
- Two tiled windows with decorations both render their own content through repeated
  retiles; no buffer/fd leak.
- `npm test` and `npm run test:gpu` green; zero leaked GPU processes; no debug
  logging or scratch files committed.

## 9. Implementation notes (post-hoc)

What was built:

- `native/ipc/wire_barrier.h` (header-only `ipc::WireBarrier`) and
  `test/wire-barrier-test.cpp` (native unit test; runs via
  `test/wire-barrier.test.js` in `npm test`). The two ad-hoc queues
  (`pendingImports`, `pendingProducerEnds`) were migrated onto it; a third
  use site (`AllocSurfaceBuf`'s two InjectTexture calls, one per wire reader)
  is the new caller the bug fix needed.
- `Compositor::reserveTextureTagged()` (`native/core/compositor.{h,cpp}`) and
  `WorkerWireClient::reserveProducerTexture()` (now returns `wireSerial`
  alongside texture/device handles) -- single chokepoints that capture the
  ordering serial AFTER the flush that committed any pending wire-client
  traffic. Threaded `reservePointSerial` through `surface.bindProducer` ->
  `pluginAllocSurfaceBufferW` -> `AllocSurfaceBuf` (new `Message.
  reservePointSerial` field).
- Decoration-resize plumbing: `WmOptions.decorationResize` sink + `state.
  decorationResize` settable indirection (`src/protocols/ctx.ts`,
  `src/wm/index.ts`); `DecorationBroker.onDecorationResized`; `DECORATION_
  EVENT.resized` + `DecorationResizedEvent` + SDK `onResized` validator;
  fixture (`test/fixtures/plugins/decoration-surface.mjs`) and example
  (`examples/decorations/animated-gradient.mjs`) updated to redraw on resize.
- Two-window GPU regression test: `test/decoration-two-windows.gpu.mjs`.

What turned out to be WRONG in the original spec (verified empirically in this
session via `test/wire-serial-regression.gpu.mjs`):

- **`ReserveTexture` does NOT emit wire bytes** in this Dawn build (it is
  pure client-side handle bookkeeping; the server materializes the texture via
  `InjectTexture`). So a "serial strictly increases across consecutive
  reserves" invariant is FALSE -- two back-to-back reserves with no other
  traffic between them produce identical serials.
- **`ReclaimTextureReservation` does NOT emit `UnregisterObjectCmd`** on the
  wire either. The wire-server WireServer object table retains its entry at
  `{id, gen}` even after the client reclaims, so a subsequent `InjectTexture`
  at `{id, gen+1}` for the recycled id CONFLICTS with the still-registered
  old object and fails.
- This means the GATE the barrier provides for AllocSurfaceBuf is "all prior
  wire activity has been processed" (which is what we want -- old-handle-
  referencing commands from prior frames must drain before the new inject)
  but it CANNOT be a strict gate-on-the-new-reserve, because the new reserve
  emits nothing. The barrier still makes the inject structurally safe by
  draining old wire traffic; it does not, however, free the wire-server slot.

The reclaim-ordering decision (section 4: pick (a) or (b)): **(b)** -- the old
producer-texture reservations are NOT reclaimed at all. Option (a) (emit
`UnregisterObjectCmd` ordered-before-the-new-reserve) would require changing
the Dawn wire-client behavior and is out of scope.

The policy is encoded in the abstraction, not at each call site:

- **`Compositor::TaggedReservation`** (`native/core/compositor.h`): a move-only
  RAII holder produced by `reserveTextureTagged()`. Exposes TWO terminal
  actions:
  - `commit()` -- the reservation has been (or will be) published to a peer
    (a ctrl message naming the id was sent). The destructor will NOT reclaim
    the wire id. This is the deferred-reclaim policy.
  - `discard()` -- the reservation never reached a peer (synchronous ctrl
    send failed). Reclaim is safe; do it now.
  Destructor default is `discard()` (so leaking via early return at least
  returns the id to the pool). `commitAndTake()` is a convenience for sites
  that need the underlying `dawn::wire::ReservedTexture` out (e.g. JS hand-off
  of the `wgpu::Texture`).

  Every former bespoke `ReclaimTextureReservation` site is routed through
  this: `importDmabufForJs` send-failed branch -> `discard()`;
  `releaseSurfaceBuf` -> `commit()` (the GPU process accepted the alloc);
  `drainCtrl` failure branches (SurfaceBufAllocated.ok=0,
  ClientTexImported.importOk=0) -> `commit()` (the GPU server may have
  partial registration); `shutdown()` -> `commit()` for in-flight entries.
  The only `ReclaimTextureReservation` calls remaining in the codebase are
  inside `TaggedReservation`'s own destructor / `discard()` / move-assign.

- **`WorkerWireClient::forgetProducerReservation`** (worker side, symmetric):
  the only termination call on a producer reservation slot. It drops the
  bookkeeping and does NOT reclaim the wire id. There is no API on the worker
  side that recycles a wire id, by design -- the type makes the
  recycled-handle hazard structurally impossible.

Cost: a few `{id, gen}` client-side reservation entries leak per resize,
bounded by total resizes (small; 32-bit ids).

The cross-channel serial machinery (`WireBarrier`, `TaggedReservation`,
`reservePointSerial`) IS still load-bearing: it ensures `InjectTexture` does
not run before old-handle-referencing wire commands have been applied, which
is the genuine ordering hazard. It is the deferred-reclaim policy that
removes the slot-recycle hazard the spec confused with the wire-ordering
hazard.
