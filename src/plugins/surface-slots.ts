// Lock-free slot-state for a plugin surface's producer/consumer ring, shared
// between the plugin Worker (producer) and the core (consumer) via a
// SharedArrayBuffer + Atomics. This is the authority on WHO OWNS each ring slot,
// so a slot is never handed to a producer while the consumer/GPU still uses it
// (the bug a blind round-robin `write` pointer caused), and so multiple producer
// threads can share one surface without stepping on each other (the FREE->ACQUIRED
// CAS is the mutual exclusion).
//
// IMPORTANT: this coordinates the two JS sides (worker producer <-> core consumer)
// only. The actual GPU read-before-write ordering is still enforced by the GPU
// process's SharedFence brackets. The DRAINING->FREE transition MUST be gated on
// the consumer's GPU completion (onSubmittedWorkDone) -- the atomic mirrors the
// fence, it does not replace it.
//
// Slot lifecycle (one Int32 per slot in the SAB):
//   FREE --getCurrentTexture (CAS, producer)--> ACQUIRED
//   ACQUIRED --present (CAS, the owning producer)--> PRESENTED
//   PRESENTED --a newer slot is presented (core demotes prior)--> DRAINING
//   DRAINING --consumer GPU read complete (core, in onSubmittedWorkDone)--> FREE
//
// Single-writer-per-edge (except the FREE->ACQUIRED race, which CAS resolves):
//   producer: FREE->ACQUIRED, ACQUIRED->PRESENTED
//   core:     PRESENTED->DRAINING, DRAINING->FREE

export const SLOT_FREE = 0;
export const SLOT_ACQUIRED = 1;
export const SLOT_PRESENTED = 2;
export const SLOT_DRAINING = 3;

// Allocate the shared state array for a surface with `slots` ring buffers. All
// slots start FREE. The returned SAB is shared to the Worker (by reference).
export function createSlotStates(slots: number): { sab: SharedArrayBuffer; states: Int32Array } {
  const sab = new SharedArrayBuffer(slots * Int32Array.BYTES_PER_ELEMENT);
  const states = new Int32Array(sab);   // zero-initialized == SLOT_FREE
  return { sab, states };
}

// A typed view over a surface's slot states (either side constructs one over the
// shared SAB). The producer methods run in the Worker; the consumer methods on
// the core. All transitions are atomic; notify wakes any awaiter.
export class SlotStates {
  readonly states: Int32Array;
  readonly slots: number;

  constructor(sab: SharedArrayBuffer) {
    this.states = new Int32Array(sab);
    this.slots = this.states.length;
  }

  // --- producer (Worker) ---

  // Try to claim a FREE slot (FREE->ACQUIRED). Returns the slot index, or -1 if
  // none is free right now. CAS makes this safe against other producer threads.
  tryAcquire(): number {
    for (let i = 0; i < this.slots; i++) {
      if (Atomics.compareExchange(this.states, i, SLOT_FREE, SLOT_ACQUIRED) === SLOT_FREE) {
        return i;
      }
    }
    return -1;
  }

  // Mark an ACQUIRED slot PRESENTED (the owning producer only). Wakes the core.
  // Throws if the slot was not ACQUIRED (invariant violation: present without a
  // matching acquire, or someone else touched it).
  present(slot: number): void {
    const prev = Atomics.compareExchange(this.states, slot, SLOT_ACQUIRED, SLOT_PRESENTED);
    if (prev !== SLOT_ACQUIRED) {
      throw new Error(`surface slot ${slot}: present() on non-ACQUIRED slot (state=${prev})`);
    }
    Atomics.notify(this.states, slot);
  }

  // --- consumer (core) ---

  // Demote the previously-latest slot PRESENTED->DRAINING (core, when a newer slot
  // is presented). No-op + returns false if it was not PRESENTED (already drained
  // or freed). DRAINING slots are freed later, gated on the GPU read completing.
  demote(slot: number): boolean {
    return Atomics.compareExchange(this.states, slot, SLOT_PRESENTED, SLOT_DRAINING) === SLOT_PRESENTED;
  }

  // Free a DRAINING slot (core, INSIDE onSubmittedWorkDone -- the consumer's GPU
  // read of this slot has completed). Wakes any producer awaiting a free slot.
  // Throws if the slot was not DRAINING (the free edge must be gated correctly).
  free(slot: number): void {
    const prev = Atomics.compareExchange(this.states, slot, SLOT_DRAINING, SLOT_FREE);
    if (prev !== SLOT_DRAINING) {
      throw new Error(`surface slot ${slot}: free() on non-DRAINING slot (state=${prev})`);
    }
    Atomics.notify(this.states, slot);
  }

  // --- shared reads ---

  state(slot: number): number { return Atomics.load(this.states, slot); }

  // The slot currently PRESENTED (the latest the consumer should sample), or -1.
  // There is at most one PRESENTED at a time (the core demotes the prior on each
  // new present).
  presentedSlot(): number {
    for (let i = 0; i < this.slots; i++) {
      if (Atomics.load(this.states, i) === SLOT_PRESENTED) return i;
    }
    return -1;
  }
}
