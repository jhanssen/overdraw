// Producer/consumer ring abstractions on top of SlotStates (surface-slots.ts).
//
// A cross-device dmabuf surface is a ring of slots (typically 3). One device
// writes (the producer) while the other reads (the consumer). The slots are
// physically distinct dmabufs so producer and consumer can work concurrently
// on different slots; the SAB-CAS slot-state machine prevents either side
// from touching a slot the other still owns. Per-slot SharedFence brackets
// (in the GPU process) serialize writes-before-reads on the same slot, and
// the SlotStates DRAINING->FREE edge waits on the consumer's GPU completion
// (afterCurrentFrame) so a slot is never recycled while a Dawn submit still
// references it.
//
// Both halves are direction-agnostic:
//
//   - SurfaceProducer wraps "FREE -> ACQUIRED -> PRESENTED" + writing producer
//     BeginAccess/EndAccess on the PRODUCER's wire. Used by:
//       * the plugin overlay path (plugin = producer, plugin wire).
//       * the compose-live core (core = producer, core wire) -- phase 5b-live.
//
//   - SurfaceConsumer wraps "PRESENTED -> DRAINING -> FREE" + writing consumer
//     BeginAccess/EndAccess on the CONSUMER's wire. Used by:
//       * the overlay broker core-side (core = consumer, core wire).
//       * the compose-live worker (plugin = consumer, plugin wire) -- phase 5b-live.
//
// Both sides receive "wire writers" + "texture wrappers" as constructor deps;
// the abstractions don't bake in which addon (core's overdraw_native vs the
// plugin's overdraw_plugin_native) or which device (core's vs the worker's).

import { SlotStates, SLOT_FREE, SLOT_PRESENTED } from "./surface-slots.js";

// --- shared types ------------------------------------------------------------

// Per-slot identifiers + handles the producer/consumer need. The two halves
// fill this in differently (e.g. the producer-side textures come from the
// PRODUCER's device; the consumer-side textures from the CONSUMER's device),
// but the shape is the same.
export interface SlotMap {
  // surfaceBufId per slot (the wire-level id the GPU process uses to find the
  // SurfaceBuf). Both sides share these ids -- they identify the dmabuf, not
  // the side.
  surfaceBufIds: ReadonlyArray<number>;
  // Pre-wrapped GPUTexture per slot, on the LOCAL device (producer-side ring's
  // textures are on the producer device; consumer-side on the consumer device).
  // Lazily filled by the caller before the slot is first used; the ring just
  // hands them out by index.
  textureFor: (slot: number) => GPUTexture | null;
}

// --- producer ---------------------------------------------------------------

export interface SurfaceProducerDeps {
  slots: SlotMap;
  slotStates: SlotStates;
  // Write producer Begin/End wire frames on the PRODUCER's wire (kind=1/kind=2
  // SurfaceAccessPayload with producer=true). The GPU process opens/closes
  // its producer bracket in FIFO order against the producer's render commands.
  writeBegin: (surfaceBufId: number) => void;
  writeEnd: (surfaceBufId: number) => void;
  // Called after CAS ACQUIRED -> PRESENTED. The overlay path uses this to send
  // a surface.present round-trip to the broker; compose-live uses it to swap
  // the live target's "next consumer slot" so a sample() picks up the new
  // frame. Synchronous return; awaits happen in caller.
  onPresented: (slot: number, surfaceBufId: number) => void | Promise<void>;
  // Quiesce: if set, acquire() returns a never-resolving Promise (parks the
  // caller's render loop while the host is tearing down).
  isStopped?: () => boolean;
}

// Producer-half of the ring. The owner calls acquire() -> renders into the
// returned texture -> submits -> present(slot). The slot-state edges + wire
// brackets happen here; the device + texture-wrapping happens in the caller
// (via SlotMap.textureFor).
export class SurfaceProducer {
  private readonly deps: SurfaceProducerDeps;
  private acquired = -1;  // the slot tryAcquire most recently handed out

  constructor(deps: SurfaceProducerDeps) { this.deps = deps; }

  // Claim the next FREE slot. Awaits if all slots are non-FREE (a healthy
  // backpressure -- the producer is faster than the consumer's drain).
  // Re-entrant acquire WITHIN the same render returns the same slot
  // idempotently until present() (matches the overlay path's behavior).
  async acquire(): Promise<{ slot: number; texture: GPUTexture }> {
    if (this.deps.isStopped?.()) {
      return new Promise<{ slot: number; texture: GPUTexture }>(() => {});
    }
    if (this.acquired >= 0) {
      const tex = this.deps.slots.textureFor(this.acquired);
      if (!tex) throw new Error(`SurfaceProducer.acquire: no texture for slot ${this.acquired}`);
      return { slot: this.acquired, texture: tex };
    }
    for (;;) {
      const slot = this.deps.slotStates.tryAcquire();
      if (slot >= 0) {
        this.acquired = slot;
        // Open the producer write bracket BEFORE the caller's render commands
        // are submitted. writeBegin's wire frame is FIFO-ordered before those
        // commands, so the GPU process opens the bracket before HandleCommands
        // decodes them.
        this.deps.writeBegin(this.deps.slots.surfaceBufIds[slot]);
        const tex = this.deps.slots.textureFor(slot);
        if (!tex) throw new Error(`SurfaceProducer.acquire: no texture for slot ${slot}`);
        return { slot, texture: tex };
      }
      // No free slot: wait on slot 0; the consumer will Atomics.notify when a
      // DRAINING slot frees. Slot-0 wait is a polling point; ANY state change
      // wakes us and we retry tryAcquire.
      const w = Atomics.waitAsync(this.deps.slotStates.states, 0, this.deps.slotStates.state(0));
      if (w.async) await w.value; else await Promise.resolve();
    }
  }

  // Close the producer bracket, CAS ACQUIRED -> PRESENTED, invoke the
  // onPresented hook (overlay path: sends surface.present to the broker;
  // compose-live: updates "latest presented" for sample()). Throws if no
  // prior acquire.
  async present(): Promise<void> {
    if (this.deps.isStopped?.()) return;
    if (this.acquired < 0) {
      throw new Error("SurfaceProducer.present(): no acquired slot");
    }
    const slot = this.acquired;
    this.acquired = -1;
    const surfaceBufId = this.deps.slots.surfaceBufIds[slot];
    // Close the producer bracket AFTER the caller's render submit (kind=2
    // wire frame, FIFO after the submit's wire batch).
    this.deps.writeEnd(surfaceBufId);
    this.deps.slotStates.present(slot);
    await this.deps.onPresented(slot, surfaceBufId);
  }
}

// --- consumer ---------------------------------------------------------------

export interface SurfaceConsumerDeps {
  slots: SlotMap;
  slotStates: SlotStates;
  // Write consumer Begin/End wire frames on the CONSUMER's wire. FIFO-ordered
  // before/after the consumer's sample commands.
  writeBegin: (surfaceBufId: number) => void;
  writeEnd: (surfaceBufId: number) => void;
  // Schedule a callback for AFTER the consumer's most recent GPU submit
  // completes. Required for the DRAINING -> FREE edge (the slot must not be
  // recycled while Dawn still has a queued sample of it). For overlays, the
  // core compositor's afterCurrentFrame. For compose-live worker-side, the
  // worker's plugin device queue's onSubmittedWorkDone callback.
  afterReadDone: (cb: () => void) => void;
}

// Consumer-half of the ring. The owner observes "a new slot was presented"
// (poll via slotStates.presentedSlot() or react to a producer-side notify),
// then calls beginConsume(slot) to open the bracket and get the slot's
// CONSUMER-side GPUTexture. After sampling, calls release(slot) which demotes
// the slot, schedules consumer End + DRAINING->FREE on afterReadDone.
//
// release() can take a "newer slot" arg (overlay path) -- a new slot just
// presented, so the current slot is no longer the latest. Or it can stand
// alone (compose-live: each sample() opens + releases the same slot).
export class SurfaceConsumer {
  private readonly deps: SurfaceConsumerDeps;
  // The slot we currently have a consumer Begin OPEN on. -1 = none open.
  // Used by overlay path's "swap" pattern: open new, release prior. Could be
  // -1 at any time for compose-live's "open-each-sample" pattern.
  private openSlot = -1;

  constructor(deps: SurfaceConsumerDeps) { this.deps = deps; }

  // Open consumer Begin on `slot`. Returns the slot's CONSUMER-side texture.
  // Throws if another slot is already open (the caller should release() it
  // first if swapping).
  beginConsume(slot: number): GPUTexture {
    if (this.openSlot >= 0 && this.openSlot !== slot) {
      throw new Error(
        `SurfaceConsumer.beginConsume(${slot}): slot ${this.openSlot} already open ` +
        `(call release() first or use swapToLatest)`,
      );
    }
    if (this.openSlot === slot) {
      const t = this.deps.slots.textureFor(slot);
      if (!t) throw new Error(`SurfaceConsumer: no texture for slot ${slot}`);
      return t;
    }
    this.deps.writeBegin(this.deps.slots.surfaceBufIds[slot]);
    this.openSlot = slot;
    const t = this.deps.slots.textureFor(slot);
    if (!t) throw new Error(`SurfaceConsumer: no texture for slot ${slot}`);
    return t;
  }

  // Close the consumer bracket on the currently-open slot + demote + free
  // (via afterReadDone). After this, openSlot is -1. Idempotent.
  endConsume(): void {
    if (this.openSlot < 0) return;
    const slot = this.openSlot;
    this.openSlot = -1;
    const surfaceBufId = this.deps.slots.surfaceBufIds[slot];
    // Demote PRESENTED -> DRAINING synchronously. (If it was already DRAINING
    // -- e.g. another swap happened first -- demote returns false; the slot's
    // already in flight to be freed and our End/free below still finish it.)
    this.deps.slotStates.demote(slot);
    // Schedule consumer End + DRAINING -> FREE on afterReadDone. The wire End
    // frame must come AFTER the consumer's most recent sample submit so the
    // GPU process closes the bracket only after decoding the reads. The
    // DRAINING -> FREE edge must wait on GPU completion so a Dawn submit
    // can't sample a slot that's just been recycled to the producer.
    const deps = this.deps;
    this.deps.afterReadDone(() => {
      deps.writeEnd(surfaceBufId);
      // Some callers may have already freed the slot via a teardown path; we
      // only call free() if we can CAS DRAINING -> FREE (no throw on
      // mismatch). The SlotStates.free() is the authority; double-free is a
      // bug we want to surface, so we don't paper over it here.
      try { deps.slotStates.free(slot); } catch { /* already freed */ }
    });
  }

  // Overlay-style "newer slot is presented; swap from the prior to the new".
  // Opens consumer Begin on the new slot BEFORE releasing the prior (so the
  // texture is always available between renderFrames). Returns the new slot's
  // CONSUMER texture.
  swapToLatest(newSlot: number): GPUTexture {
    const prev = this.openSlot;
    if (prev === newSlot) {
      const t = this.deps.slots.textureFor(newSlot);
      if (!t) throw new Error(`SurfaceConsumer: no texture for slot ${newSlot}`);
      return t;
    }
    // Open the new slot BEFORE closing the prior (no gap where neither is
    // open -- the consumer always has a sampleable texture). Trick: we
    // temporarily allow two open slots, but the prior is immediately
    // released to afterReadDone, so by the next sample only one is truly
    // open from the GPU process's perspective.
    this.deps.writeBegin(this.deps.slots.surfaceBufIds[newSlot]);
    this.openSlot = newSlot;
    if (prev >= 0) {
      const prevBufId = this.deps.slots.surfaceBufIds[prev];
      this.deps.slotStates.demote(prev);
      const deps = this.deps;
      deps.afterReadDone(() => {
        deps.writeEnd(prevBufId);
        try { deps.slotStates.free(prev); } catch { /* already */ }
      });
    }
    const t = this.deps.slots.textureFor(newSlot);
    if (!t) throw new Error(`SurfaceConsumer: no texture for slot ${newSlot}`);
    return t;
  }

  // Tear down: close any open bracket. Caller is responsible for then
  // releasing the underlying surfaceBufs (e.g. ReleaseSurfaceBuf to the GPU
  // process) via separate machinery.
  destroy(): void {
    if (this.openSlot >= 0) this.endConsume();
  }
}

// --- helpers ----------------------------------------------------------------

// Used by both the producer and the consumer halves to wait until at least
// one slot is PRESENTED (i.e. there's something for the consumer to read).
// Polls; intended for compose-live's sample() flow.
export async function awaitPresentedSlot(states: SlotStates): Promise<number> {
  for (;;) {
    const s = states.presentedSlot();
    if (s >= 0) return s;
    const w = Atomics.waitAsync(states.states, 0, states.state(0));
    if (w.async) await w.value; else await Promise.resolve();
  }
}

// Re-export from surface-slots for callers that import from here.
export { SlotStates, SLOT_FREE, SLOT_PRESENTED } from "./surface-slots.js";
