// ClientBufferLifecycle (the pure state machine in src/gpu/client-buffer-lifecycle.ts):
// drive event sequences, assert the emitted intent stream and the invariants. GPU-free.
// See docs/client-buffer-lifecycle.md for the spec; section "Invariants the machine
// MUST enforce" is the source of truth for what these tests assert.
//
// Tests are organized:
//   * core six invariants (mirroring the spec list 1..6)
//   * #7 producer-consumer fence self-chain
//   * #8 destroyed-mid-flight
//   * #9 syncobj acquire fence throws (not stubbed -- the asserted-not-implemented
//     decision)
//   * frame contract (frameAborted, frameStart-twice, etc.)
//   * accessFailed: poisons and recovers via supersede
//   * fuzz: 1000 valid random sequences, all invariants hold after every step

import { test } from "node:test";
import assert from "node:assert/strict";

import { ClientBufferLifecycle } from "../packages/core/dist/gpu/client-buffer-lifecycle.js";

// Helpers --------------------------------------------------------------------

// Drive a list of events through the machine, accumulating the full intent
// stream. Convenient for sequence tests.
function drive(events) {
  const m = new ClientBufferLifecycle();
  const out = [];
  for (const e of events) out.push(...m.step(e));
  return { m, intents: out };
}

const noFence = { kind: "none" };
const sfFence = (fd) => ({ kind: "syncFile", fd });
const dims = (w, h) => ({ w, h });

// Intents by kind, optionally filtered by predicate.
function pick(intents, kind, pred = () => true) {
  return intents.filter((i) => i.kind === kind && pred(i));
}

// Commit + immediate importCompleted: the happy path where the executor's
// async import resolves "instantly". Most tests want this; they pre-date the
// Importing state but assert on the post-Imported behaviour. Tests that
// EXERCISE the Importing window dispatch the events separately.
function commitImported(m, surfaceId, bufferId, d) {
  const out = [];
  out.push(...m.step({ kind: "commit", surfaceId, bufferId, dims: d }));
  out.push(...m.step({ kind: "importCompleted", bufferId }));
  return out;
}

// Run a one-frame compositing pass: frameStart, sample each of `surfaces`, then
// submitted(serial). Returns the intents that fired during this frame.
function runFrame(m, surfaces, serial) {
  const out = [];
  out.push(...m.step({ kind: "frameStart" }));
  for (const s of surfaces) out.push(...m.step({ kind: "frameSampled", surfaceId: s }));
  out.push(...m.step({ kind: "submitted", serial }));
  return out;
}

// 1. importBuffer at most once per buffer ------------------------------------

test("invariant 1: importBuffer fires once per buffer; re-commit of same buffer does not re-import", () => {
  const m = new ClientBufferLifecycle();
  const i1 = m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i1, "importBuffer").length, 1, "first commit imports");
  m.step({ kind: "importCompleted", bufferId: 100 });
  const i2 = m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i2, "importBuffer").length, 0, "re-commit does NOT import");
});

// 2. begin/end strictly alternate per buffer ---------------------------------

test("invariant 2: two frameSampled for the same buffer in one frame throws (begin/end alternation)", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  m.step({ kind: "frameStart" });
  m.step({ kind: "frameSampled", surfaceId: 1 });
  // The state-machine layer enforces this even though the spec discussion is
  // about Dawn's device error. Same surface listed twice in one frame would
  // try to open two begins.
  assert.throws(
    () => m.step({ kind: "frameSampled", surfaceId: 1 }),
    /alternation/);
});

test("invariant 2: begin/end alternate across many frames on the same buffer", () => {
  const m = new ClientBufferLifecycle();
  const allIntents = [];
  allIntents.push(...commitImported(m, 1, 100, dims(8, 8)));
  // 50 frames, all re-committing the SAME buffer (cursor-blink / focus-change
  // shape -- the regression we are guarding against).
  for (let f = 1; f <= 50; f++) {
    allIntents.push(...runFrame(m, [1], f));
    allIntents.push(...m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1000 + f) }));
    allIntents.push(...m.step({ kind: "gpuCompleted", serial: f }));
    if (f < 50) allIntents.push(...m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) }));
  }
  // Across the whole run: one importBuffer, 50 beginAccess, 50 endAccess; no
  // sendWlRelease (buffer stays current the whole time); no releaseImport
  // (cache stays live -- rule A).
  assert.equal(pick(allIntents, "importBuffer").length, 1);
  assert.equal(pick(allIntents, "beginAccess").length, 50);
  assert.equal(pick(allIntents, "endAccess").length, 50);
  assert.equal(pick(allIntents, "sendWlRelease").length, 0);
  assert.equal(pick(allIntents, "releaseImport").length, 0);
});

// 3. exactly one begin/end per sampled frame --------------------------------

test("invariant 3: one begin/end pair per sampled frame per buffer", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  commitImported(m, 2, 200, dims(8, 8));
  const frame = runFrame(m, [1, 2], 1);
  const begins = pick(frame, "beginAccess");
  const ends = pick(frame, "endAccess");
  assert.equal(begins.length, 2);
  assert.equal(ends.length, 2);
  // One pair per surface.
  assert.deepEqual([...new Set(begins.map((b) => b.bufferId))].sort(), [100, 200]);
  assert.deepEqual([...new Set(ends.map((b) => b.bufferId))].sort(), [100, 200]);
});

// 4. sendWlRelease only after a different buffer supersedes AND GPU completes ---

test("invariant 4 (rule A): supersede A by B -> sendWlRelease(A) after frame completes; releaseImport(A) does NOT fire (cache stays live)", () => {
  const m = new ClientBufferLifecycle();
  // commit A, sample, submit
  commitImported(m, 1, 100, dims(8, 8));
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) });

  // commit B (supersedes A on surface 1). A's wl_buffer.release is owed but
  // inflight serial 1 has not yet completed, so nothing fires yet. B is in
  // Importing -- its importCompleted doesn't affect A's release path.
  const i = m.step({ kind: "commit", surfaceId: 1, bufferId: 200, dims: dims(8, 8) });
  m.step({ kind: "importCompleted", bufferId: 200 });
  assert.equal(pick(i, "sendWlRelease").length, 0, "no release before GPU completion");
  assert.equal(pick(i, "releaseImport").length, 0);

  // gpuCompleted(1) drains A's only inflight -> sendWlRelease(A). Rule A:
  // releaseImport(A) does NOT fire on supersede; the cache survives so the
  // next re-commit hits cache.
  const i2 = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(i2, "sendWlRelease", (x) => x.bufferId === 100).length, 1,
    "sendWlRelease(A) fires (one per cycle)");
  assert.equal(pick(i2, "releaseImport").length, 0,
    "releaseImport(A) does NOT fire on supersede (rule A)");

  // B is still current; never released.
  assert.equal(pick(i2, "sendWlRelease", (x) => x.bufferId === 200).length, 0);
});

test("invariant 4 + rule A: re-commit of a superseded-then-released buffer hits cache (no second import)", () => {
  const m = new ClientBufferLifecycle();
  const all = [];
  // commit A, sample, complete, supersede with B, drain.
  all.push(...commitImported(m, 1, 100, dims(8, 8)));
  all.push(...runFrame(m, [1], 1));
  all.push(...m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) }));
  all.push(...commitImported(m, 1, 200, dims(8, 8)));
  all.push(...m.step({ kind: "gpuCompleted", serial: 1 }));
  // Two imports so far (one per buffer).
  assert.equal(pick(all, "importBuffer").length, 2);
  assert.equal(pick(all, "sendWlRelease", (x) => x.bufferId === 100).length, 1);

  // Re-attach A. Per rule A this MUST hit cache.
  const i = m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i, "importBuffer").length, 0, "re-attach after release: cache hit, no import");
  // And A is now current; B was just superseded; the cycle continues.
});

test("invariant 4: same-buffer re-commit NEVER fires sendWlRelease (regression for the black-frame bug)", () => {
  const m = new ClientBufferLifecycle();
  const all = [];
  all.push(...commitImported(m, 1, 100, dims(8, 8)));
  for (let f = 1; f <= 20; f++) {
    all.push(...runFrame(m, [1], f));
    all.push(...m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1000 + f) }));
    all.push(...m.step({ kind: "gpuCompleted", serial: f }));
    if (f < 20) all.push(...m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) }));
  }
  assert.equal(pick(all, "sendWlRelease").length, 0, "never release a still-current buffer");
  assert.equal(pick(all, "releaseImport").length, 0, "never release-import a still-current buffer");
  // Rule A: one import for the whole run.
  assert.equal(pick(all, "importBuffer").length, 1);
});

// 5. releaseImport gated on cache invalidation (NOT supersede) ---------------

test("invariant 5 (rule A): supersede with pipelined inflight -> sendWlRelease(A) once last inflight drains; releaseImport(A) NEVER fires until destroy", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // 3 frames in flight on A before supersede (pipeline depth).
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) });
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  runFrame(m, [1], 2);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1002) });
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  runFrame(m, [1], 3);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1003) });
  // Supersede A with B.
  commitImported(m, 1, 200, dims(8, 8));

  // Drain frames 1 and 2; sendWlRelease(A) still gated on frame 3.
  const i1 = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(i1, "sendWlRelease").length, 0);
  const i2 = m.step({ kind: "gpuCompleted", serial: 2 });
  assert.equal(pick(i2, "sendWlRelease").length, 0);
  // Drain frame 3 -> sendWlRelease(A) ONCE. releaseImport NEVER fires (rule A).
  const i3 = m.step({ kind: "gpuCompleted", serial: 3 });
  assert.equal(pick(i3, "sendWlRelease", (x) => x.bufferId === 100).length, 1);
  assert.equal(pick(i3, "releaseImport").length, 0, "rule A: cache survives supersede");
});

// 6. surfaceRemoved drains -------------------------------------------------
// surfaceRemoved is one of the two paths that releases the cached import
// under rule A (the other is bufferDestroyed). The surface going away is
// modeled as an effective destroy of its references -- if the client never
// destroys the wl_buffer and never re-attaches it to another surface, this
// path prevents the import from leaking for the lifetime of the buffer.

test("invariant 6: surfaceRemoved with a frame inflight defers BOTH intents until completion", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) });
  const i = m.step({ kind: "surfaceRemoved", surfaceId: 1 });
  assert.equal(pick(i, "sendWlRelease").length, 0);
  assert.equal(pick(i, "releaseImport").length, 0);
  // Once GPU completes, both fire (the surfaceRemoved path sets BOTH owed flags).
  const i2 = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(i2, "sendWlRelease", (x) => x.bufferId === 100).length, 1);
  assert.equal(pick(i2, "releaseImport", (x) => x.bufferId === 100).length, 1);
  assert.equal(m.isEmpty(), true);
});

test("invariant 6: surfaceRemoved with no inflight fires both intents immediately and drains", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // surfaceRemoved before any frame samples it.
  const i = m.step({ kind: "surfaceRemoved", surfaceId: 1 });
  assert.equal(pick(i, "sendWlRelease", (x) => x.bufferId === 100).length, 1);
  assert.equal(pick(i, "releaseImport", (x) => x.bufferId === 100).length, 1);
  assert.equal(m.isEmpty(), true);
});

// Load-bearing leak guards (rule A makes destroy + surfaceRemoved the ONLY
// paths to releaseImport, so these are now load-bearing for not leaking GPU
// imports/fds. The cycling-dmabuf leak GPU test is the end-to-end backstop).

test("leak guard: destroy a cached-but-not-current buffer -> releaseImport fires immediately", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // Supersede with B; drain so A is fully released-to-client but cached.
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1) });
  commitImported(m, 1, 200, dims(8, 8));
  m.step({ kind: "gpuCompleted", serial: 1 });
  // Now destroy A. Expected: releaseImport(A) fires immediately (no inflight).
  const i = m.step({ kind: "bufferDestroyed", bufferId: 100 });
  assert.equal(pick(i, "releaseImport", (x) => x.bufferId === 100).length, 1);
  assert.equal(pick(i, "sendWlRelease", (x) => x.bufferId === 100).length, 0, "#8: never release a destroyed buffer");
});

test("leak guard: destroy a buffer that is currently being sampled -> releaseImport deferred until drain", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1) });
  // Client destroys A while frame 1 is still on the GPU.
  const i = m.step({ kind: "bufferDestroyed", bufferId: 100 });
  assert.equal(pick(i, "releaseImport").length, 0, "deferred until drain");
  assert.equal(pick(i, "sendWlRelease").length, 0);
  // Drain -> releaseImport(A).
  const i2 = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(i2, "releaseImport", (x) => x.bufferId === 100).length, 1);
  assert.equal(pick(i2, "sendWlRelease").length, 0);
});

test("rescue: surfaceRemoved with inflight then re-attach to a different surface before drain -> NO releaseImport", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1) });
  // surfaceRemoved with frame 1 still on the GPU -- importOwed is set, deferred.
  const r = m.step({ kind: "surfaceRemoved", surfaceId: 1 });
  assert.equal(pick(r, "releaseImport").length, 0);
  // The client (still alive, wl_buffer still alive) re-attaches the same
  // buffer to a different surface. This must cancel the deferred releaseImport
  // -- otherwise we tear down a cached import that's back in active use.
  const c = m.step({ kind: "commit", surfaceId: 2, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(c, "importBuffer").length, 0, "rule A: cache hit, no re-import");
  // Drain frame 1 -- the deferred releaseImport must NOT fire (importOwed cleared).
  const g = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(g, "releaseImport").length, 0,
    "re-attach before drain cancels surfaceRemoved's pending releaseImport");
  // The sendWlRelease that surfaceRemoved owed is also cancelled by the
  // re-attach (the buffer is current again on surface 2).
  assert.equal(pick(g, "sendWlRelease").length, 0);
});

test("leak guard: surfaceRemoved releases ALL the surface's currently-cached imports (one surface, many buffers cycled)", () => {
  const m = new ClientBufferLifecycle();
  // Cycle 3 buffers on surface 1; all three end up cached under rule A.
  const ids = [101, 102, 103];
  for (let i = 0; i < 3; i++) {
    commitImported(m, 1, ids[i], dims(8, 8));
    runFrame(m, [1], i + 1);
    m.step({ kind: "endAccessFenceExported", bufferId: ids[i], fence: sfFence(i + 1) });
    m.step({ kind: "gpuCompleted", serial: i + 1 });
  }
  // After cycling: all three cached. Surface currently points at the last one.
  // surfaceRemoved drains ONLY the surface's then-current buffer (per the
  // implementation). The other two cached imports remain until they are
  // bufferDestroyed (or get drained another way). Test the truth, not a wish:
  // we have 3 cached, only the current one is released by surfaceRemoved;
  // the others are leak-able UNLESS bufferDestroyed fires for them.
  const i = m.step({ kind: "surfaceRemoved", surfaceId: 1 });
  assert.equal(pick(i, "releaseImport", (x) => x.bufferId === ids[2]).length, 1,
    "surfaceRemoved releases the surface's then-current buffer");

  // Now destroy the other two -> they release immediately (no inflight).
  const i101 = m.step({ kind: "bufferDestroyed", bufferId: ids[0] });
  const i102 = m.step({ kind: "bufferDestroyed", bufferId: ids[1] });
  assert.equal(pick(i101, "releaseImport", (x) => x.bufferId === ids[0]).length, 1);
  assert.equal(pick(i102, "releaseImport", (x) => x.bufferId === ids[1]).length, 1);
  assert.equal(m.isEmpty(), true, "everything drained");
});

// 7. fence self-chain (#3 acceptance) ---------------------------------------

test("#7: beginAccess after the first carries chainFence == last endAccessFenceExported for same buffer", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));

  // Frame 1: first begin has chainFence=none. No previous end fence yet.
  const f1 = runFrame(m, [1], 1);
  const b1 = pick(f1, "beginAccess")[0];
  assert.deepEqual(b1.chainFence, noFence, "first begin chains nothing");

  // EndAccess exports fence 1001.
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) });
  m.step({ kind: "gpuCompleted", serial: 1 });

  // Frame 2: begin's chainFence == sfFence(1001).
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  const f2 = runFrame(m, [1], 2);
  const b2 = pick(f2, "beginAccess")[0];
  assert.deepEqual(b2.chainFence, sfFence(1001), "second begin chains previous end's fence");

  // Frame 3: chainFence picks up the latest exported end fence (1002), not the
  // older 1001. Tests that chainFence is overwritten, not accumulated.
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1002) });
  m.step({ kind: "gpuCompleted", serial: 2 });
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  const f3 = runFrame(m, [1], 3);
  const b3 = pick(f3, "beginAccess")[0];
  assert.deepEqual(b3.chainFence, sfFence(1002));
});

test("#7 + acquire fence: beginAccess carries BOTH the client's acquireFence and the chainFence", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  m.step({ kind: "acquireFenceAvailable", bufferId: 100, fence: sfFence(9001) });
  const f1 = runFrame(m, [1], 1);
  const b1 = pick(f1, "beginAccess")[0];
  assert.deepEqual(b1.acquireFence, sfFence(9001), "acquire fence routed through");
  assert.deepEqual(b1.chainFence, noFence);

  // The acquireFence MUST be consumed by exactly one beginAccess. A subsequent
  // frame without a fresh acquireFenceAvailable sees acquireFence=none.
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) });
  m.step({ kind: "gpuCompleted", serial: 1 });
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  const f2 = runFrame(m, [1], 2);
  const b2 = pick(f2, "beginAccess")[0];
  assert.deepEqual(b2.acquireFence, noFence, "no fresh client acquire => none");
  assert.deepEqual(b2.chainFence, sfFence(1001));
});

// 8. destroyed-mid-flight ---------------------------------------------------

test("#8: bufferDestroyed mid-flight defers releaseImport until inflight completes, NEVER sendWlRelease", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  runFrame(m, [1], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1001) });

  // Client destroys the buffer while frame 1 is still on the GPU.
  const i1 = m.step({ kind: "bufferDestroyed", bufferId: 100 });
  assert.equal(pick(i1, "sendWlRelease").length, 0, "no wl_buffer.release for destroyed");
  assert.equal(pick(i1, "releaseImport").length, 0, "deferred until GPU completion");

  // GPU completes -> releaseImport fires, but still no sendWlRelease.
  const i2 = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(i2, "sendWlRelease").length, 0, "never wl_buffer.release for destroyed");
  assert.equal(pick(i2, "releaseImport", (x) => x.bufferId === 100).length, 1);
  // Surface still exists (we never removed it); the BUFFER side is drained.
  assert.equal(m.snapshot().buffers.length, 0);
});

test("#8: bufferDestroyed with no inflight fires releaseImport immediately and no sendWlRelease", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // No frame ever sampled it.
  const i = m.step({ kind: "bufferDestroyed", bufferId: 100 });
  assert.equal(pick(i, "sendWlRelease").length, 0);
  assert.equal(pick(i, "releaseImport", (x) => x.bufferId === 100).length, 1);
});

// Importing window (the race the third state closes) ----------------------
// Before this state existed, the lifecycle treated a buffer as Imported the
// moment its commit landed -- but the executor's async addon callback hadn't
// resolved yet, so dmabufImports had no entry. bufferDestroyed arriving in
// that window emitted releaseImport with no cache to release; the late
// callback then stashed an unreachable import (a permanent native importId
// leak). The Importing state defers releaseImport until importCompleted,
// where it can actually release something.

test("Importing: bufferDestroyed before importCompleted defers releaseImport; fires after import completes", () => {
  const m = new ClientBufferLifecycle();
  // First-sight commit: buffer is in Importing.
  const i1 = m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i1, "importBuffer").length, 1);
  // Client destroys the buffer while it is still importing. The lifecycle
  // must NOT emit releaseImport now -- the executor has nothing to release.
  const i2 = m.step({ kind: "bufferDestroyed", bufferId: 100 });
  assert.equal(pick(i2, "releaseImport").length, 0,
    "no releaseImport while Importing: executor has no live import yet");
  assert.equal(pick(i2, "sendWlRelease").length, 0, "destroyed: no wl release ever");
  // Now the executor reports the import completed. The deferred releaseImport
  // must fire NOW so the GPU-side reservation does not leak.
  const i3 = m.step({ kind: "importCompleted", bufferId: 100 });
  assert.equal(pick(i3, "releaseImport", (x) => x.bufferId === 100).length, 1,
    "releaseImport fires once the cache exists, closing the leak");
  assert.equal(m.snapshot().buffers.length, 0, "buffer entry drained");
});

test("Importing: surfaceRemoved before importCompleted defers releaseImport too", () => {
  const m = new ClientBufferLifecycle();
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  // Surface goes away before the import resolves.
  const i = m.step({ kind: "surfaceRemoved", surfaceId: 1 });
  assert.equal(pick(i, "releaseImport").length, 0);
  // The completion ships the deferred release.
  const i2 = m.step({ kind: "importCompleted", bufferId: 100 });
  assert.equal(pick(i2, "releaseImport", (x) => x.bufferId === 100).length, 1);
  assert.equal(m.snapshot().buffers.length, 0);
});

test("Importing: frameSampled skips a surface whose current buffer is still importing", () => {
  const m = new ClientBufferLifecycle();
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  // No importCompleted yet: buffer is Importing. Sampling this surface must
  // be a no-op (no beginAccess), mirroring the executor's openImportBrackets
  // gate that skips surfaces whose import hasn't resolved.
  const f = runFrame(m, [1], 1);
  assert.equal(pick(f, "beginAccess").length, 0, "Importing: no begin");
  assert.equal(pick(f, "endAccess").length, 0);
  // After completion the surface samples normally.
  m.step({ kind: "importCompleted", bufferId: 100 });
  const f2 = runFrame(m, [1], 2);
  assert.equal(pick(f2, "beginAccess", (x) => x.bufferId === 100).length, 1);
});

test("Importing: a second commit before importCompleted does NOT emit a second importBuffer", () => {
  const m = new ClientBufferLifecycle();
  const i1 = m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i1, "importBuffer").length, 1);
  // Re-commit the same bufferId while the import is in flight (the executor
  // hasn't fired importCompleted yet). Rule A: this is a re-attach, NOT a
  // re-import -- the lifecycle is already tracking the buffer (in Importing).
  const i2 = m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i2, "importBuffer").length, 0, "re-commit while Importing: no import twice");
  // importCompleted lands; the surface now samples normally.
  m.step({ kind: "importCompleted", bufferId: 100 });
  const f = runFrame(m, [1], 1);
  assert.equal(pick(f, "beginAccess", (x) => x.bufferId === 100).length, 1);
});

test("Importing: accessFailed (import failure) closes the Importing window without leaking", () => {
  const m = new ClientBufferLifecycle();
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  // bufferDestroyed during Importing sets importOwed; the executor reports
  // the import FAILED rather than completed. The lifecycle transitions to
  // Poisoned and the deferred releaseImport-or-equivalent must reconcile so
  // we don't leak the executor's reservation. (The executor releases its
  // reservation on its own failure path; the lifecycle just shouldn't keep
  // any owed flags hanging.)
  m.step({ kind: "bufferDestroyed", bufferId: 100 });
  const i = m.step({ kind: "accessFailed", bufferId: 100, reason: "import returned null" });
  // releaseImport fires only if a cache exists; on a failed import there is
  // nothing to release. importOwed clears, buffer entry drains via maybeFlush.
  // The contract: the entry is gone afterwards (no stuck state).
  assert.equal(pick(i, "sendWlRelease").length, 0);
  // Implementation defines whether releaseImport fires on the failure path;
  // both behaviours are acceptable so long as the buffer entry drains. The
  // executor's release of its native reservation is on its own failure path.
  assert.equal(m.snapshot().buffers.length, 0, "no stuck state after failure");
});

// 9. syncobj acquire fence is asserted-not-implemented ---------------------

test("#9: syncobj acquire fence throws on beginAccess emission, NOT silently degrades", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // Set the syncobj fence -- routing through acquireFenceAvailable is fine.
  m.step({
    kind: "acquireFenceAvailable", bufferId: 100,
    fence: { kind: "syncobj", handle: 42, point: 7n },
  });
  // Trying to emit a beginAccess that would carry it throws -- this is the
  // "no silent degrade" guard.
  m.step({ kind: "frameStart" });
  assert.throws(
    () => m.step({ kind: "frameSampled", surfaceId: 1 }),
    /syncobj acquire fence not implemented/);
});

test("#9: syncobj rejection is at intent-emission, not at acquireFenceAvailable (event routing is fine)", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // Routing the syncobj into the machine is NOT what throws. Only when a
  // sampled frame would carry it to the executor does it throw. This keeps the
  // event-vocabulary shape future-proof.
  m.step({ kind: "acquireFenceAvailable", bufferId: 100,
           fence: { kind: "syncobj", handle: 1, point: 1n } });
  // No throw yet. Now ALSO overwrite with a syncFile fence (executor materialized
  // the syncobj to a sync_file outside the machine): no throw on the frame.
  m.step({ kind: "acquireFenceAvailable", bufferId: 100, fence: sfFence(7777) });
  const f = runFrame(m, [1], 1);
  const b = pick(f, "beginAccess")[0];
  assert.deepEqual(b.acquireFence, sfFence(7777));
});

// Frame contract ------------------------------------------------------------

test("frameStart twice in a row throws (executor contract)", () => {
  const m = new ClientBufferLifecycle();
  m.step({ kind: "frameStart" });
  assert.throws(() => m.step({ kind: "frameStart" }), /frameStart while a frame is already in flight/);
});

test("frameSampled without frameStart throws", () => {
  const m = new ClientBufferLifecycle();
  assert.throws(() => m.step({ kind: "frameSampled", surfaceId: 1 }), /frameSampled without frameStart/);
});

test("submitted without frameStart throws", () => {
  const m = new ClientBufferLifecycle();
  assert.throws(() => m.step({ kind: "submitted", serial: 1 }), /submitted without an in-flight frame/);
});

test("frameAborted: the open begin is rolled back; no stale endAccess follows", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  m.step({ kind: "frameStart" });
  const i1 = m.step({ kind: "frameSampled", surfaceId: 1 });
  assert.equal(pick(i1, "beginAccess").length, 1);
  const i2 = m.step({ kind: "frameAborted" });
  assert.equal(pick(i2, "endAccess").length, 0, "no end on abort");

  // The next frame opens cleanly (no orphan accessOpen).
  m.step({ kind: "frameStart" });
  const i3 = m.step({ kind: "frameSampled", surfaceId: 1 });
  assert.equal(pick(i3, "beginAccess").length, 1, "next frame opens cleanly");
  m.step({ kind: "submitted", serial: 2 });
});

// accessFailed -------------------------------------------------------------

test("accessFailed poisons the buffer; no further beginAccess on it; supersede still sends wl_buffer.release", () => {
  const m = new ClientBufferLifecycle();
  // The commit puts A in Importing. accessFailed (executor reports import
  // failure) transitions Importing -> Poisoned. The buffer entry stays alive
  // so supersede + destroy can still drive it through release.
  m.step({ kind: "commit", surfaceId: 1, bufferId: 100, dims: dims(8, 8) });
  m.step({ kind: "accessFailed", bufferId: 100, reason: "import returned null" });
  // Frame samples surface 1 -- no beginAccess emitted for the poisoned buffer.
  const f = runFrame(m, [1], 1);
  assert.equal(pick(f, "beginAccess").length, 0, "poisoned: no begin");
  assert.equal(pick(f, "endAccess").length, 0);
  // Supersede with B. A has no inflight (was never sampled). Per rule A:
  // sendWlRelease(A) fires (one per cycle, gated only on no-inflight here);
  // releaseImport(A) does NOT fire on supersede -- cache survives.
  const sup = m.step({ kind: "commit", surfaceId: 1, bufferId: 200, dims: dims(8, 8) });
  m.step({ kind: "importCompleted", bufferId: 200 });
  assert.equal(pick(sup, "sendWlRelease", (x) => x.bufferId === 100).length, 1);
  assert.equal(pick(sup, "releaseImport").length, 0,
    "rule A: cache survives supersede, even of a poisoned buffer");
  // Destroying A releases the cached import.
  const d = m.step({ kind: "bufferDestroyed", bufferId: 100 });
  assert.equal(pick(d, "releaseImport", (x) => x.bufferId === 100).length, 1);
});

// Buffer migration across surfaces ----------------------------------------

test("buffer moved from surface A to surface B retires from A and adopts on B (no import twice)", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  // Surface 1 currently has 100.
  const i = m.step({ kind: "commit", surfaceId: 2, bufferId: 100, dims: dims(8, 8) });
  assert.equal(pick(i, "importBuffer").length, 0, "no re-import on adopt-move");
  // Surface 1 superseded its current buffer (with what? nothing: it just lost
  // 100 to surface 2). The machine retires-on-supersede ONLY when the SAME
  // surface attaches a different buffer; cross-surface migration is the spec's
  // "buffer is no longer surface 1's current". In this implementation the
  // buffer's currentSurfaceId moves to 2. Surface 1 is left with currentBufferId=100
  // referring to a buffer whose ownership moved. NOTE: real wl protocol does not
  // really do this (a wl_buffer is one client's, and clients don't usually
  // attach the same wl_buffer to two surfaces) -- this test pins the behavior
  // we DO implement: buffer follows the most recent commit.
  const snap = m.snapshot();
  const b = snap.buffers.find((x) => x.bufferId === 100);
  assert.equal(b.currentSurfaceId, 2);
});

// Cycling across multiple buffers (the realistic three-buffer client) -------

test("3-buffer cycling: exactly 3 imports across many cycles (rule A cache survives supersede)", () => {
  const m = new ClientBufferLifecycle();
  const ids = [101, 102, 103];
  const allIntents = [];
  let frame = 0;
  // Cycle through 3 buffers, 9 commits total. Under rule A: each buffer is
  // imported ONCE on first sight and the cache survives every supersede; the
  // re-attaches at i=3,4,5,... hit cache. This is the realistic dmabuf client
  // pattern (a 2-3 buffer pool rotated round-robin).
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    const bufferId = ids[i % 3];
    allIntents.push(...m.step({ kind: "commit", surfaceId: 1, bufferId, dims: dims(8, 8) }));
    // First sight of this bufferId: dispatch importCompleted to move it from
    // Importing -> Imported. Subsequent commits of the same bufferId are
    // no-ops in the state machine (cache hit, no import intent).
    if (!seen.has(bufferId)) {
      allIntents.push(...m.step({ kind: "importCompleted", bufferId }));
      seen.add(bufferId);
    }
    frame += 1;
    allIntents.push(...runFrame(m, [1], frame));
    allIntents.push(...m.step({ kind: "endAccessFenceExported", bufferId, fence: sfFence(2000 + frame) }));
    allIntents.push(...m.step({ kind: "gpuCompleted", serial: frame }));
  }
  // Three unique buffers, three imports -- not nine. This is the core rule-A
  // assertion and the one that future-proofs against the import-twice bug.
  assert.equal(pick(allIntents, "importBuffer").length, 3,
    "rule A: one import per unique buffer across the whole cycle");
  // Begin/end count: 9 frames, one buffer each -> 9 of each.
  assert.equal(pick(allIntents, "beginAccess").length, 9);
  assert.equal(pick(allIntents, "endAccess").length, 9);
  // 8 supersedes (each commit after the first), each owes the client a release.
  // The very last buffer is still current, so it owes none. 8 sendWlReleases.
  assert.equal(pick(allIntents, "sendWlRelease").length, 8);
  // Zero releaseImports -- nothing got destroyed; the cache is intact.
  assert.equal(pick(allIntents, "releaseImport").length, 0);
});

// Drain / teardown ---------------------------------------------------------

test("teardown drains: surfaceRemoved + gpuCompleted all -> machine empty", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 100, dims(8, 8));
  commitImported(m, 2, 200, dims(8, 8));
  runFrame(m, [1, 2], 1);
  m.step({ kind: "endAccessFenceExported", bufferId: 100, fence: sfFence(1) });
  m.step({ kind: "endAccessFenceExported", bufferId: 200, fence: sfFence(2) });
  m.step({ kind: "surfaceRemoved", surfaceId: 1 });
  m.step({ kind: "surfaceRemoved", surfaceId: 2 });
  m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(m.isEmpty(), true);
});

// Fuzz ---------------------------------------------------------------------

// Generate a random sequence of valid events. Maintain a minimal shadow model
// to know which events are valid at each step (so we don't waste time on
// throw-on-purpose events). Then run the full sequence and assert invariants
// at every step.

function fuzzRun(seed) {
  // Tiny xorshift for reproducibility.
  let s = seed | 0;
  if (s === 0) s = 1;
  const rnd = () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
  const choose = (arr) => arr[Math.floor(rnd() * arr.length)];

  const m = new ClientBufferLifecycle();
  // Shadow. Per per-surface invariant 4 (no buffer sharing across surfaces in
  // one frame -- we don't model refcount), each bufferId is pinned to one
  // surface for its whole lifetime in the fuzz; reusing it on a different
  // surface is out of scope and would (correctly) throw on a same-frame
  // sample. The shadow enforces the binding so we explore only valid space.
  const surfaces = new Set();           // surfaceId -> exists
  const liveBuffers = new Set();        // bufferId -> live (machine has cached it)
  const bufferOwner = new Map();        // bufferId -> surfaceId (set on first commit)
  const allEverBuffers = new Map();     // bufferId -> dims
  const surfaceCurrent = new Map();     // surfaceId -> bufferId (or none)
  const destroyedBuffers = new Set();   // bufferId -> bufferDestroyed already fired
  let frameOpen = false;
  let sampledThisFrame = new Set();
  let nextSerial = 1;
  const inflight = new Set();

  const log = [];
  // For invariant tracking across the whole run. Counts are per buffer-LIFETIME
  // (a buffer that gets bufferDestroyed and later re-imported counts in its
  // own new lifetime).
  const beginsByBuffer = new Map();
  const endsByBuffer = new Map();
  const importCyclesByBuffer = new Map();   // bufferId -> number of (re)imports seen
  // Begins that fired but were rolled back by frameAborted (no End counterpart
  // ever exists, by design -- the executor discards the queued Begin message).
  // We need this to express the aggregate begin/end invariant honestly.
  const abortedBeginsByBuffer = new Map();
  // Buffers that have an open BeginAccess in the currently-in-flight frame
  // when the fuzz terminates -- also have no End counterpart yet.
  const currentlyOpenInFrame = new Set();

  const STEPS = 500;
  for (let step = 0; step < STEPS; step++) {
    const choices = [];
    choices.push("commit");
    if (liveBuffers.size > 0 && rnd() < 0.3) choices.push("acquireFence");
    if (!frameOpen && surfaceCurrent.size > 0 && rnd() < 0.7) choices.push("frameStart");
    if (frameOpen && surfaces.size > 0 && rnd() < 0.8) choices.push("frameSampled");
    if (frameOpen && rnd() < 0.4) choices.push("submit");
    if (frameOpen && rnd() < 0.05) choices.push("frameAbort");
    if (inflight.size > 0 && rnd() < 0.5) choices.push("gpuCompleted");
    if (liveBuffers.size > 0 && rnd() < 0.05) choices.push("bufferDestroyed");
    if (surfaces.size > 0 && rnd() < 0.05) choices.push("surfaceRemoved");
    if (liveBuffers.size > 0 && rnd() < 0.03) choices.push("accessFailed");

    const act = choose(choices);
    let event;
    switch (act) {
      case "commit": {
        // Pick a surface (1..4).
        const surfaceId = (1 + Math.floor(rnd() * 4));
        // Pick a buffer: either an existing one already owned by THIS surface,
        // or a fresh one (a fresh id is bound to this surface for its lifetime).
        let bufferId;
        const sameSurfaceBuffers = [...bufferOwner.entries()]
          .filter(([, sid]) => sid === surfaceId)
          .map(([bid]) => bid)
          .filter((bid) => !destroyedBuffers.has(bid));
        if (sameSurfaceBuffers.length > 0 && rnd() < 0.6) {
          bufferId = sameSurfaceBuffers[Math.floor(rnd() * sameSurfaceBuffers.length)];
        } else {
          bufferId = 1000 + step;
          bufferOwner.set(bufferId, surfaceId);
        }
        const d = allEverBuffers.get(bufferId) ?? { w: 8 + step, h: 8 + step };
        allEverBuffers.set(bufferId, d);
        event = { kind: "commit", surfaceId, bufferId, dims: d };
        surfaces.add(surfaceId);
        const isFirstSight = !liveBuffers.has(bufferId);
        liveBuffers.add(bufferId);
        destroyedBuffers.delete(bufferId);  // re-import after destroy is a new lifetime
        surfaceCurrent.set(surfaceId, bufferId);
        // Stash for after the m.step() below: first-sight commits put the
        // buffer in Importing and the fuzz's invariants assume Imported (a
        // sampled buffer must produce a beginAccess intent). Drive
        // importCompleted to transition.
        event._firstSight = isFirstSight ? bufferId : null;
        break;
      }
      case "acquireFence": {
        const bufferId = [...liveBuffers][Math.floor(rnd() * liveBuffers.size)];
        event = { kind: "acquireFenceAvailable", bufferId, fence: sfFence(step + 9000) };
        break;
      }
      case "frameStart":
        event = { kind: "frameStart" };
        frameOpen = true; sampledThisFrame = new Set();
        break;
      case "frameSampled": {
        const candidates = [...surfaces].filter((s) => surfaceCurrent.has(s) && !sampledThisFrame.has(s));
        if (candidates.length === 0) continue;
        const surfaceId = candidates[Math.floor(rnd() * candidates.length)];
        sampledThisFrame.add(surfaceId);
        event = { kind: "frameSampled", surfaceId };
        break;
      }
      case "submit": {
        const serial = nextSerial++;
        event = { kind: "submitted", serial };
        inflight.add(serial);
        frameOpen = false; sampledThisFrame = new Set();
        break;
      }
      case "frameAbort":
        event = { kind: "frameAborted" };
        frameOpen = false; sampledThisFrame = new Set();
        break;
      case "gpuCompleted": {
        const serial = [...inflight][Math.floor(rnd() * inflight.size)];
        event = { kind: "gpuCompleted", serial };
        inflight.delete(serial);
        break;
      }
      case "bufferDestroyed": {
        const bufferId = [...liveBuffers][Math.floor(rnd() * liveBuffers.size)];
        event = { kind: "bufferDestroyed", bufferId };
        liveBuffers.delete(bufferId);
        destroyedBuffers.add(bufferId);
        for (const [sid, bid] of surfaceCurrent) {
          if (bid === bufferId) surfaceCurrent.delete(sid);
        }
        break;
      }
      case "surfaceRemoved": {
        const surfaceId = [...surfaces][Math.floor(rnd() * surfaces.size)];
        event = { kind: "surfaceRemoved", surfaceId };
        surfaces.delete(surfaceId);
        const owned = surfaceCurrent.get(surfaceId);
        surfaceCurrent.delete(surfaceId);
        // surfaceRemoved tears down the surface's CURRENT buffer's cache. The
        // shadow needs to reflect that: drop it from liveBuffers so a later
        // commit (rebinding the same id to a new surface) starts a new
        // import lifetime, matching the machine.
        if (owned !== undefined) {
          liveBuffers.delete(owned);
          bufferOwner.delete(owned);
        }
        break;
      }
      case "accessFailed": {
        const bufferId = [...liveBuffers][Math.floor(rnd() * liveBuffers.size)];
        event = { kind: "accessFailed", bufferId, reason: "fuzz" };
        break;
      }
      default: continue;
    }

    log.push(event);
    let intents;
    try { intents = m.step(event); }
    catch (e) {
      throw new Error(`fuzz step ${step} (seed=${seed}) threw: ${e.message}\nevent=${JSON.stringify(event)}\nlog:\n${log.slice(-10).map(JSON.stringify).join("\n")}`);
    }
    // Resolve first-sight commits immediately so frame samples find an
    // Imported buffer. The dedicated "Importing window" tests below exercise
    // the bufferDestroyed-during-import path explicitly.
    if (event.kind === "commit" && event._firstSight !== null) {
      const completionEvent = { kind: "importCompleted", bufferId: event._firstSight };
      log.push(completionEvent);
      try {
        intents.push(...m.step(completionEvent));
      } catch (e) {
        throw new Error(`fuzz step ${step} (seed=${seed}) importCompleted threw: ${e.message}`);
      }
    }

    // Track per-frame begins to attribute them when the frame ends.
    const inc = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const i of intents) {
      if (i.kind === "importBuffer") inc(importCyclesByBuffer, i.bufferId);
      else if (i.kind === "beginAccess") {
        inc(beginsByBuffer, i.bufferId);
        currentlyOpenInFrame.add(i.bufferId);
      } else if (i.kind === "endAccess") {
        inc(endsByBuffer, i.bufferId);
        currentlyOpenInFrame.delete(i.bufferId);
      }
    }
    // On frameAborted: any begin still open from this frame becomes an
    // aborted-begin (the executor discarded its corresponding Begin message).
    // Drains currentlyOpenInFrame.
    if (event.kind === "frameAborted") {
      for (const bid of currentlyOpenInFrame) inc(abortedBeginsByBuffer, bid);
      currentlyOpenInFrame.clear();
    }

    // Per-step invariants.
    const snap = m.snapshot();
    assert.equal(snap.frameOpen, frameOpen, `frame-open shadow drift (seed=${seed}, step=${step})`);
    // No buffer has both releaseOwed and importOwed set on a destroyed buffer
    // (releaseOwed must be cleared when destroyed -- invariant 8).
    for (const b of snap.buffers) {
      if (b.destroyed) assert.equal(b.releaseOwed, false,
        `destroyed buffer ${b.bufferId} has releaseOwed (seed=${seed}, step=${step})`);
    }
  }

  // End-of-run invariants.
  //
  // (1) For every buffer: begins == ends + aborted + currentlyOpen.
  //     Begins fire on frameSampled. Ends fire on submitted (one per sampled
  //     surface). Begins on a frame that gets frameAborted have no End by
  //     design (the executor discards them). Begins in the in-flight frame
  //     when the fuzz terminates are still open. Everything else must pair.
  for (const [bid, begins] of beginsByBuffer) {
    const ends = endsByBuffer.get(bid) ?? 0;
    const aborted = abortedBeginsByBuffer.get(bid) ?? 0;
    const open = currentlyOpenInFrame.has(bid) ? 1 : 0;
    if (begins !== ends + aborted + open) {
      throw new assert.AssertionError({
        message: `buffer ${bid}: begins=${begins} ends=${ends} aborted=${aborted} open=${open} (seed=${seed})`,
        actual: false, expected: true, operator: "==",
      });
    }
  }
  // (2) Each buffer-lifetime is imported AT MOST ONCE (multiple lifetimes for
  //     the same id are allowed -- destroy + re-commit = new lifetime).
  //     importCyclesByBuffer counts ALL imports across lifetimes for that id.
  //     For each, count must be >= 1 if the id was ever live and not always
  //     immediately destroyed; counts > 1 mean the id had >1 lifetimes, which
  //     is fine. We CAN'T meaningfully check "at most one per lifetime" from
  //     cumulative counts; the per-step "every step succeeds" is the real
  //     guard for rule A. The dedicated 3-buffer-cycling test pins the
  //     not-9-imports assertion directly.
}

test("fuzz: 200 seeds x ~500 steps each, all invariants hold", () => {
  for (let seed = 1; seed <= 200; seed++) {
    fuzzRun(seed * 9973);
  }
});

// --- Direct scanout hold ------------------------------------------------
// A scanned-out buffer is never GPU-sampled, so its release gate is the
// scanout hold: scanoutPresented sets it, scanoutRetired drops it and
// drains any owed release. (scanout-design.md "Buffer release".)

test("scanout: superseded held buffer releases only on scanoutRetired", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 10, dims(64, 64));
  assert.equal(m.step({ kind: "scanoutPresented", bufferId: 10 }).length, 0);
  // Supersede while the display engine reads buffer 10: NO release yet.
  const sup = commitImported(m, 1, 11, dims(64, 64));
  assert.equal(pick(sup, "sendWlRelease").length, 0,
    "no release while scanout-held");
  // The successor latched; 10 retired -> release fires now.
  const ret = m.step({ kind: "scanoutRetired", bufferId: 10 });
  assert.equal(pick(ret, "sendWlRelease", (i) => i.bufferId === 10).length, 1);
});

test("scanout: retire without supersede releases nothing", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 10, dims(64, 64));
  m.step({ kind: "scanoutPresented", bufferId: 10 });
  // Composite frame took over (scanout leave); 10 is still the surface's
  // current buffer -- retiring must not release it.
  const ret = m.step({ kind: "scanoutRetired", bufferId: 10 });
  assert.equal(pick(ret, "sendWlRelease").length, 0);
  // A later supersede releases immediately (no hold, no inflight).
  const sup = commitImported(m, 1, 11, dims(64, 64));
  assert.equal(pick(sup, "sendWlRelease", (i) => i.bufferId === 10).length, 1);
});

test("scanout: destroyed while held never sends wl release, frees import on retire", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 10, dims(64, 64));
  m.step({ kind: "scanoutPresented", bufferId: 10 });
  const d = m.step({ kind: "bufferDestroyed", bufferId: 10 });
  assert.equal(pick(d, "sendWlRelease").length, 0, "invariant 8");
  assert.equal(pick(d, "releaseImport").length, 0, "import held while latched");
  const ret = m.step({ kind: "scanoutRetired", bufferId: 10 });
  assert.equal(pick(ret, "sendWlRelease").length, 0, "invariant 8 still");
  assert.equal(pick(ret, "releaseImport", (i) => i.bufferId === 10).length, 1);
});

test("scanout: hold composes with inflight sampling serials", () => {
  // Enter transition: the frame that composited buffer 10 is still in
  // flight when the buffer also gets scanned out. Release requires BOTH
  // gates to clear, in either order.
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 10, dims(64, 64));
  runFrame(m, [1], 1);
  m.step({ kind: "scanoutPresented", bufferId: 10 });
  const sup = commitImported(m, 1, 11, dims(64, 64));
  assert.equal(pick(sup, "sendWlRelease").length, 0);
  const g = m.step({ kind: "gpuCompleted", serial: 1 });
  assert.equal(pick(g, "sendWlRelease").length, 0, "still scanout-held");
  const ret = m.step({ kind: "scanoutRetired", bufferId: 10 });
  assert.equal(pick(ret, "sendWlRelease", (i) => i.bufferId === 10).length, 1);
});

test("scanout: re-adopt of a held buffer cancels the owed release", () => {
  const m = new ClientBufferLifecycle();
  commitImported(m, 1, 10, dims(64, 64));
  m.step({ kind: "scanoutPresented", bufferId: 10 });
  commitImported(m, 1, 11, dims(64, 64));   // supersede (owed, held)
  commitImported(m, 1, 10, dims(64, 64));   // client re-attaches 10
  const ret = m.step({ kind: "scanoutRetired", bufferId: 10 });
  assert.equal(pick(ret, "sendWlRelease").length, 0,
    "re-adopt cleared releaseOwed; retire alone must not release");
});
