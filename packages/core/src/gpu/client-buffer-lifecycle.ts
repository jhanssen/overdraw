// Per-client-dmabuf-buffer access lifecycle, as a pure state machine.
//
// The reason this exists at all is captured in docs/client-buffer-lifecycle.md
// (read that first). Every bug in this area has been a sequencing error --
// import-twice, begin-without-end, acquire-once-instead-of-per-frame, release-
// the-wrong-thing, release-too-early -- so the rules live HERE, in one pure,
// GPU-free, exhaustively-unit-tested place. The GPU executor (compositor +
// gpu-process bracket) is a mechanical translator of the intents this emits.
//
// The machine takes events from the executor (commits, frame ticks, submit/
// completion serials, buffer/surface destruction, executor-side failures) and
// produces an ordered intent stream the executor runs. It contains no GPU
// calls, no Dawn types, no addon -- it runs under `node --test` with zero GPU.
//
// Key invariants the executor relies on (see docs and the tests):
//   1. importBuffer(B) at most once per B while the cache entry is live. A
//      bufferDestroyed (or surfaceRemoved that owns the only reference)
//      tears the cache down; a subsequent re-commit imports again.
//   2. beginAccess(B) / endAccess(B) strictly alternate per B.
//   3. Each sampled frame emits exactly one begin/end pair per sampled buffer.
//   4. sendWlRelease(B) fires when B is superseded on its surface (or its
//      surface is removed) AND every frame that sampled B has completed;
//      never for a buffer that is still a surface's current. Per cycle.
//   5. releaseImport(B) is gated on the cache being invalidated -- ONLY
//      bufferDestroyed(B) or the surfaceRemoved drain path -- NOT supersede.
//      A buffer-cycling client (the cursor-blink / 3-buffer-pool case) keeps
//      hitting cache across supersedes; this is rule A and is the point of
//      the whole abstraction.
//   6. surfaceRemoved drains the surface's then-current buffer: a release is
//      owed to the client (unless destroyed) AND the cached import is torn
//      down once in-flight serials complete.
//   7. Producer-consumer self-chain: beginAccess after the first carries the
//      chainFence from the previous endAccessFenceExported for the same B
//      (Dawn's per-access fence chaining).
//   8. bufferDestroyed never produces sendWlRelease for that B; releaseImport
//      still fires once in-flight frames complete.
//   9. Syncobj acquire fences are UNIMPLEMENTED: emitting a beginAccess that
//      would carry one THROWS. No silent degrade to "no acquire" (that would
//      reintroduce the black-frame bug for explicit-sync clients).

export type AcquireFence =
  | { kind: "none" }
  | { kind: "syncFile"; fd: number }
  | { kind: "syncobj"; handle: number; point: bigint };

export type ReleaseFence =
  | { kind: "none" }
  | { kind: "syncFile"; fd: number };

export type LifecycleEvent =
  | { kind: "commit"; surfaceId: number; bufferId: number; dims: { w: number; h: number } }
  | { kind: "acquireFenceAvailable"; bufferId: number; fence: AcquireFence }
  | { kind: "frameStart" }
  | { kind: "frameSampled"; surfaceId: number }
  | { kind: "frameAborted" }
  | { kind: "submitted"; serial: number }
  | { kind: "endAccessFenceExported"; bufferId: number; fence: ReleaseFence }
  | { kind: "gpuCompleted"; serial: number }
  | { kind: "bufferDestroyed"; bufferId: number }
  | { kind: "surfaceRemoved"; surfaceId: number }
  // Executor reports the async importBuffer intent completed: the GPU
  // import is now live, the buffer transitions Importing -> Imported, and
  // any owed releaseImport (a bufferDestroyed or surfaceRemoved-drain that
  // arrived while Importing) fires now via maybeFlush.
  | { kind: "importCompleted"; bufferId: number }
  | { kind: "accessFailed"; bufferId: number; reason: string }
  // Direct scanout: the buffer was handed to the display engine
  // (scanoutPresented -> hold release) and later displaced by a
  // subsequent flip (scanoutRetired -> the hold drops and any owed
  // release drains). A scanned-out buffer is never GPU-sampled, so
  // without the hold a supersede would release it while the display
  // engine still reads it.
  | { kind: "scanoutPresented"; bufferId: number }
  | { kind: "scanoutRetired"; bufferId: number };

export type LifecycleIntent =
  | { kind: "importBuffer"; bufferId: number; surfaceId: number; dims: { w: number; h: number } }
  | { kind: "beginAccess"; bufferId: number; surfaceId: number;
      acquireFence: AcquireFence; chainFence: ReleaseFence }
  | { kind: "endAccess"; bufferId: number; surfaceId: number }
  | { kind: "releaseImport"; bufferId: number }
  | { kind: "sendWlRelease"; bufferId: number };

// Per-buffer state. (Rule A: the cache lives until the buffer is destroyed
// or the only surface referencing it is torn down. Supersede does NOT drop
// the cache -- that's what makes a buffer-cycling client efficient and what
// fixes the import-twice bug for real.)
type BufferState = "Importing" | "Imported" | "Poisoned";
//   Importing: first sight; importBuffer intent fired, but the executor has
//              not yet reported its GPU import is live (the async addon
//              callback is in flight). frameSampled skips a surface whose
//              current buffer is Importing; releaseImport is held until
//              importCompleted lands. Without this state, bufferDestroyed
//              arriving during the import window emits releaseImport with
//              no cache yet -- the late callback then stashes an unreachable
//              import, leaking its native importId.
//   Imported:  cached server-side, may or may not currently be a surface's
//              current. Stays in this state across supersedes; only
//              bufferDestroyed/surfaceRemoved-drain takes it out.
//   Poisoned:  accessFailed (or import failure); no further begins; release
//              path still runs.
// (No explicit Released/Retiring: the entry is deleted once released.)

interface BufferRec {
  state: BufferState;
  // The surface that currently has this buffer as its current. 0 = none (the
  // buffer was superseded on its surface, the surface was removed, the buffer
  // was destroyed, or the buffer was never adopted by one).
  currentSurfaceId: number;
  // Sticky flag set by bufferDestroyed. Once true, never send wl_buffer.release
  // for this buffer (invariant 8); releaseImport still fires (gated on drain).
  destroyed: boolean;
  // Whether a release is owed back to the client (set when the buffer was
  // superseded or its surface was removed). Drained once inflight=0, gated on
  // !destroyed (invariant 8). Distinct from the import-release ownership.
  releaseOwed: boolean;
  // Whether the cached GPU import should be torn down once inflight=0. Set by
  // bufferDestroyed (the cache is invalidated when the wl_buffer dies) and by
  // surfaceRemoved on the surface that held it as current (the drain path).
  // Per rule A this is NOT set on supersede -- the cache survives buffer
  // cycling so the next re-commit hits cache.
  importOwed: boolean;
  // Whether the next beginAccess on this buffer is the first one (no prior
  // endAccess fence to chain). After the first end, chainFence = the last
  // exported fence.
  chainFence: ReleaseFence;
  // The most recently captured acquire fence from the client (consumed by the
  // NEXT beginAccess; cleared on use). Set by acquireFenceAvailable.
  pendingAcquireFence: AcquireFence;
  // Submit serials that sampled this buffer and have not yet been GPU-completed.
  // Drained as gpuCompleted(serial) arrives; once empty AND the buffer has an
  // outstanding release/import-release owed, the corresponding intents fire.
  inflightSerials: Set<number>;
  // Set if currently in the open BeginAccess bracket of the current frame
  // (between frameSampled and the frame's submitted/aborted). Used to enforce
  // begin/end alternation (invariant 2).
  accessOpen: boolean;
  // Held by the display engine (direct scanout): the buffer is latched on
  // (or in a pending flip toward) a KMS plane. Blocks maybeFlush exactly
  // like an inflight sampling serial; cleared by scanoutRetired.
  scanoutHeld: boolean;
  // Memoized dims (for the importBuffer intent on the first sight of the
  // buffer; tests / executor don't need them after that).
  dims: { w: number; h: number };
}

interface SurfaceRec {
  currentBufferId: number;
}

// Per-frame in-flight scratch state.
interface FrameRec {
  // Surfaces sampled this frame; the buffers they sampled are derived from
  // surface.currentBufferId at frameSampled time and pinned for the frame.
  sampled: Array<{ surfaceId: number; bufferId: number }>;
}

export class ClientBufferLifecycle {
  private buffers = new Map<number, BufferRec>();
  private surfaces = new Map<number, SurfaceRec>();
  private frame: FrameRec | null = null;
  // Submit serials whose endAccess has been emitted but whose exported fence
  // has not yet been reported back via endAccessFenceExported. Tracked so the
  // tests + future debug can sanity-check the executor (kept here so the
  // executor can be dumb).
  private pendingEndExports = new Map<number, number[]>();  // serial -> bufferIds

  // The intent buffer this step is filling. Cleared at the start of step().
  private out: LifecycleIntent[] = [];

  step(event: LifecycleEvent): LifecycleIntent[] {
    this.out = [];
    switch (event.kind) {
      case "commit": this.onCommit(event.surfaceId, event.bufferId, event.dims); break;
      case "acquireFenceAvailable": this.onAcquireFenceAvailable(event.bufferId, event.fence); break;
      case "frameStart": this.onFrameStart(); break;
      case "frameSampled": this.onFrameSampled(event.surfaceId); break;
      case "frameAborted": this.onFrameAborted(); break;
      case "submitted": this.onSubmitted(event.serial); break;
      case "endAccessFenceExported":
        this.onEndAccessFenceExported(event.bufferId, event.fence); break;
      case "gpuCompleted": this.onGpuCompleted(event.serial); break;
      case "bufferDestroyed": this.onBufferDestroyed(event.bufferId); break;
      case "surfaceRemoved": this.onSurfaceRemoved(event.surfaceId); break;
      case "importCompleted": this.onImportCompleted(event.bufferId); break;
      case "accessFailed": this.onAccessFailed(event.bufferId, event.reason); break;
      case "scanoutPresented": this.onScanoutPresented(event.bufferId); break;
      case "scanoutRetired": this.onScanoutRetired(event.bufferId); break;
    }
    return this.out;
  }

  // --- event handlers ---

  private onCommit(surfaceId: number, bufferId: number, dims: { w: number; h: number }): void {
    let s = this.surfaces.get(surfaceId);
    if (!s) { s = { currentBufferId: 0 }; this.surfaces.set(surfaceId, s); }

    // First sight of this buffer (or first re-sight after the cache was torn
    // down by bufferDestroyed): import and cache it. Cache hit = no import.
    // New entries start in Importing; the executor drives importCompleted
    // (success) or accessFailed (failure) to transition.
    let b = this.buffers.get(bufferId);
    if (!b) {
      b = {
        state: "Importing", currentSurfaceId: surfaceId, destroyed: false,
        releaseOwed: false, importOwed: false,
        chainFence: { kind: "none" }, pendingAcquireFence: { kind: "none" },
        inflightSerials: new Set(), accessOpen: false, scanoutHeld: false, dims,
      };
      this.buffers.set(bufferId, b);
      this.out.push({ kind: "importBuffer", bufferId, surfaceId, dims });
    }

    // Same-buffer-same-surface re-commit: nothing to do beyond noting it (the
    // per-frame begin/end pair still runs against the cached import with the
    // commit's fresh acquire fence). This is the cursor-blink / focus-change
    // hot path.
    if (s.currentBufferId === bufferId) return;

    // Superseding: the surface's previous current buffer is no longer current
    // and owes the client a wl_buffer.release once the last frame that sampled
    // it completes. The cached IMPORT is preserved -- rule A. The supersede
    // does not invalidate the cache.
    if (s.currentBufferId !== 0) this.markSupersededOnSurface(s.currentBufferId, surfaceId);

    // Adopt.
    s.currentBufferId = bufferId;
    b.currentSurfaceId = surfaceId;
    // Re-attaching cancels any pending owed-release/owed-import flags: the
    // buffer is back in active use. (releaseOwed: the executor MAY have
    // already emitted sendWlRelease in a prior frame -- that's the per-cycle
    // model -- but if the flag is still set with inflight>0, clear it; the
    // client is using the buffer again. importOwed: same logic -- a
    // surfaceRemoved with inflight>0 set importOwed pending drain; a re-
    // attach before drain rescues the cache.) bufferDestroyed cannot
    // produce this path: a destroyed wl_buffer's bufferId is stale and a
    // new commit would carry a different bufferId.
    b.releaseOwed = false;
    b.importOwed = false;
  }

  private onAcquireFenceAvailable(bufferId: number, fence: AcquireFence): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;  // commit hasn't arrived yet, or buffer destroyed/unknown
    b.pendingAcquireFence = fence;
  }

  private onFrameStart(): void {
    if (this.frame !== null) {
      // The previous frame never reached submitted/aborted. That is a contract
      // violation from the executor; surface it loudly.
      throw new Error("frameStart while a frame is already in flight (missing submitted/frameAborted)");
    }
    this.frame = { sampled: [] };
  }

  private onFrameSampled(surfaceId: number): void {
    if (this.frame === null) {
      throw new Error("frameSampled without frameStart");
    }
    const s = this.surfaces.get(surfaceId);
    if (!s || s.currentBufferId === 0) return;  // surface has no buffer yet
    const bufferId = s.currentBufferId;
    const b = this.buffers.get(bufferId);
    if (!b) return;
    if (b.state === "Poisoned") return;  // accessFailed: skip this surface's draw
    if (b.state === "Importing") return; // import in flight: executor has no
                                         // GPU handle yet to BeginAccess
                                         // against. Mirrors the executor's own
                                         // gate in openImportBrackets (skip
                                         // surfaces whose import hasn't
                                         // resolved). Surface stays last-good
                                         // until importCompleted.

    if (b.accessOpen) {
      // Invariant 2: a second beginAccess without an endAccess on the same B
      // in the same frame would be a Dawn validation error (the "is already
      // used to access" rule). It would mean the surface was listed twice in
      // frameSampled, or two surfaces share this buffer in one frame (which
      // we don't model per the per-surface invariant 4 decision).
      throw new Error(`frameSampled twice on buffer ${bufferId} in one frame (begin/end alternation)`);
    }

    // #9: syncobj acquire fence is unimplemented. Throw RATHER than silently
    // degrading to "no acquire" (which would reintroduce the black-frame bug
    // for explicit-sync clients). The intent-emission point is where we'd
    // hand the fence to the executor, so this is the right place to refuse.
    if (b.pendingAcquireFence.kind === "syncobj") {
      throw new Error("syncobj acquire fence not implemented");
    }

    const acquireFence = b.pendingAcquireFence;
    b.pendingAcquireFence = { kind: "none" };  // consumed
    b.accessOpen = true;

    this.frame.sampled.push({ surfaceId, bufferId });
    this.out.push({
      kind: "beginAccess",
      bufferId, surfaceId,
      acquireFence,
      chainFence: b.chainFence,
    });
  }

  private onFrameAborted(): void {
    if (this.frame === null) return;
    // Roll back any opened access brackets without emitting endAccess (no
    // submit happened, so Dawn never observed the Begin). The state-machine
    // invariant is "begin/end pair per frame OR neither", which an executor
    // implementing aborted-before-submit upholds by simply discarding the
    // queued begin messages.
    const sampled = this.frame.sampled;
    this.frame = null;
    for (const { bufferId } of sampled) {
      const b = this.buffers.get(bufferId);
      if (b) b.accessOpen = false;
      // The frame's open access blocked maybeFlush; now that it is closed
      // (and no inflight serial was added), re-attempt flush in case the
      // buffer was destroyed / superseded / its surface removed during the
      // frame.
      this.maybeFlush(bufferId);
    }
  }

  private onSubmitted(serial: number): void {
    if (this.frame === null) {
      throw new Error("submitted without an in-flight frame");
    }
    const sampled = this.frame.sampled;
    this.frame = null;
    const endedBuffers: number[] = [];
    for (const { surfaceId, bufferId } of sampled) {
      const b = this.buffers.get(bufferId);
      if (!b) continue;
      // Pair the begin from this frame: close accessOpen, add to inflight.
      // The inflight add means maybeFlush will defer until gpuCompleted.
      b.accessOpen = false;
      b.inflightSerials.add(serial);
      endedBuffers.push(bufferId);
      this.out.push({ kind: "endAccess", bufferId, surfaceId });
    }
    if (endedBuffers.length > 0) this.pendingEndExports.set(serial, endedBuffers);
  }

  private onEndAccessFenceExported(bufferId: number, fence: ReleaseFence): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    // Store as the chain fence for the next beginAccess on this buffer
    // (invariant 7). Overwrites any prior chainFence -- the most recent end's
    // fence is the only one that matters for ordering the next begin.
    b.chainFence = fence;
  }

  private onGpuCompleted(serial: number): void {
    this.pendingEndExports.delete(serial);
    for (const [bufferId, b] of [...this.buffers]) {
      if (!b.inflightSerials.delete(serial)) continue;
      this.maybeFlush(bufferId);
    }
  }

  private onBufferDestroyed(bufferId: number): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    b.destroyed = true;
    // The cache is invalidated (rule A): the import is torn down once any
    // in-flight frames complete.
    b.importOwed = true;
    // The client disclaimed the buffer, so it is no longer current on any
    // surface, and no wl_buffer.release is owed (invariant 8).
    if (b.currentSurfaceId !== 0) {
      const s = this.surfaces.get(b.currentSurfaceId);
      if (s && s.currentBufferId === bufferId) s.currentBufferId = 0;
      b.currentSurfaceId = 0;
    }
    b.releaseOwed = false;
    this.maybeFlush(bufferId);
  }

  private onSurfaceRemoved(surfaceId: number): void {
    const s = this.surfaces.get(surfaceId);
    if (!s) return;
    if (s.currentBufferId !== 0) {
      const b = this.buffers.get(s.currentBufferId);
      if (b && b.currentSurfaceId === surfaceId) {
        // Surface teardown: the surface's reference goes away. Both a
        // wl_buffer.release (the client deserves to know the buffer is free)
        // AND a releaseImport are owed -- the surface going away is, for
        // overdraw's bookkeeping, an effective destroy of the references to
        // this buffer. If a client later attaches the same wl_buffer to a
        // different surface, that's a fresh import (cache miss).
        if (!b.destroyed) b.releaseOwed = true;
        b.importOwed = true;
        b.currentSurfaceId = 0;
      }
    }
    this.surfaces.delete(surfaceId);
    if (s.currentBufferId !== 0) this.maybeFlush(s.currentBufferId);
  }

  private onAccessFailed(bufferId: number, _reason: string): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    b.state = "Poisoned";
    // The buffer keeps its surface/inflight state -- it can still be released
    // normally. We just won't emit any more beginAccess for it.
    // If the buffer was Importing when the failure landed, maybeFlush may now
    // emit a deferred releaseImport (e.g. bufferDestroyed arrived during
    // import). Without this, the executor's reservation leaks.
    this.maybeFlush(bufferId);
  }

  private onImportCompleted(bufferId: number): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    if (b.state !== "Importing") return;  // late: failure / supersede races
    b.state = "Imported";
    // If a bufferDestroyed (or surfaceRemoved drain) arrived while Importing,
    // the importOwed flag is set; emit the deferred releaseImport now that
    // the executor's import is live and can actually be released. maybeFlush
    // gates on inflightSerials/accessOpen, both empty in the Importing window
    // (frameSampled skipped this buffer), so it fires immediately.
    this.maybeFlush(bufferId);
  }

  // --- helpers ---

  // The surface's previous current buffer was just superseded (a different
  // buffer is now current on the same surface). The client deserves a
  // wl_buffer.release once the last sampling frame completes. Per rule A the
  // cached GPU IMPORT is preserved -- a client that cycles through a small
  // pool re-attaches a superseded buffer later and we want a cache hit, not
  // a re-import.
  private markSupersededOnSurface(bufferId: number, surfaceId: number): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    if (b.currentSurfaceId === surfaceId) b.currentSurfaceId = 0;
    if (!b.destroyed) b.releaseOwed = true;
    this.maybeFlush(bufferId);
  }

  // Emit any pending sendWlRelease / releaseImport for this buffer that can
  // fire now (no in-flight serial AND no open access bracket; the
  // corresponding "owed" flag is set). Deletes the buffer entry only when
  // its cached import is torn down (releaseImport fires) -- a buffer that is
  // merely superseded (releaseOwed set, importOwed not set) keeps its entry
  // for future cache hits per rule A.
  //
  // accessOpen gating: if a frame has called frameSampled on this buffer but
  // has not yet called submitted (or frameAborted), the End intent has not
  // yet fired and the entry must not be deleted out from under it. Wait for
  // the frame to close, after which gpuCompleted's maybeFlush will fire (or
  // frameAborted's rollback will, since aborted leaves no inflight serial).
  private maybeFlush(bufferId: number): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    if (b.inflightSerials.size > 0) return;
    if (b.accessOpen) return;
    if (b.scanoutHeld) return;            // the display engine reads the
                                          // buffer (direct scanout); wait
                                          // for scanoutRetired
    if (b.state === "Importing") return;  // wait for importCompleted: the
                                          // executor has no live import to
                                          // releaseImport against, and
                                          // sendWlRelease would race the
                                          // not-yet-completed import path

    if (b.releaseOwed) {
      // Invariant 8: never sendWlRelease for a destroyed buffer.
      if (!b.destroyed) this.out.push({ kind: "sendWlRelease", bufferId });
      b.releaseOwed = false;
    }
    if (b.importOwed) {
      this.out.push({ kind: "releaseImport", bufferId });
      this.buffers.delete(bufferId);
    }
  }

  private onScanoutPresented(bufferId: number): void {
    const b = this.buffers.get(bufferId);
    if (!b) return;
    b.scanoutHeld = true;
  }

  private onScanoutRetired(bufferId: number): void {
    const b = this.buffers.get(bufferId);
    if (!b || !b.scanoutHeld) return;
    b.scanoutHeld = false;
    this.maybeFlush(bufferId);
  }

  // --- introspection (for tests) ---

  // True if no buffers or surfaces remain in any state. The drain-on-teardown
  // test asserts this after surfaceRemoved + gpuCompleted of all in-flight.
  isEmpty(): boolean {
    return this.buffers.size === 0 && this.surfaces.size === 0
      && this.frame === null && this.pendingEndExports.size === 0;
  }

  // Snapshot for invariant checks in fuzz tests.
  snapshot(): {
    buffers: Array<{
      bufferId: number; state: BufferState; currentSurfaceId: number;
      destroyed: boolean; releaseOwed: boolean; importOwed: boolean;
      accessOpen: boolean; inflightCount: number;
    }>;
    surfaces: Array<{ surfaceId: number; currentBufferId: number }>;
    frameOpen: boolean;
  } {
    return {
      buffers: [...this.buffers.entries()].map(([bufferId, b]) => ({
        bufferId, state: b.state, currentSurfaceId: b.currentSurfaceId,
        destroyed: b.destroyed, releaseOwed: b.releaseOwed, importOwed: b.importOwed,
        accessOpen: b.accessOpen, inflightCount: b.inflightSerials.size,
      })),
      surfaces: [...this.surfaces.entries()].map(([surfaceId, s]) => ({
        surfaceId, currentBufferId: s.currentBufferId,
      })),
      frameOpen: this.frame !== null,
    };
  }
}
