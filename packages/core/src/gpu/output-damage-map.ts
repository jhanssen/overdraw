// Per-output composite damage, indexed by outputId.
//
// One OutputDamageRing per known output, lazily created on first damage to
// that output. Each ring stores damage in OUTPUT-LOCAL logical coordinates
// (origin = that output's top-left in global logical space); the map
// converts global-space damage rects into per-output clipped local rects
// and back to global coords on take(), so callers operate entirely in
// global space.
//
// This generalizes the previous single-ring model (which only produced a
// valid partial scissor when a single output sat at the global origin) to
// any multi-output layout: each output gets a damage-optimal partial
// scissor whose extent matches what actually changed inside that output's
// region.

import { OutputDamageRing } from "./output-damage-ring.js";
import type { DamageBox, RepaintRegion } from "./output-damage-ring.js";

export interface OutputBounds {
  outputId: number;
  // Top-left in global logical space.
  logicalX: number;
  logicalY: number;
  // Logical dimensions of this output's render space.
  logicalWidth: number;
  logicalHeight: number;
}

interface Entry {
  bounds: OutputBounds;
  ring: OutputDamageRing;
}

export class OutputDamageMap {
  private entries = new Map<number, Entry>();
  // Per-output dirty bit. Set by every damageRect/full call for an output
  // the dirty signal touches; cleared by clearDirty(outputId) on successful
  // present. Independent of the per-slot damage rings: the rings answer
  // "what region needs to be redrawn" given that we ARE drawing this slot;
  // the dirty bit answers "should this output be rendered at all this
  // vblank." Without the second predicate, an idle compositor would re-
  // render every output every flip-complete (set wantNext + acquire a free
  // slot + present) at the panel's refresh rate, burning CPU.
  private dirty = new Set<number>();

  // Replace the full set of known outputs. Outputs no longer present have
  // their rings dropped; outputs present in both old and new sets keep
  // their rings (their accumulated damage carries over) but their bounds
  // are refreshed -- a logicalSize change forces a full repaint on that
  // output since the slot textures have to be recreated anyway. New
  // outputs get a fresh empty ring whose first take() returns full.
  setOutputs(outputs: ReadonlyArray<OutputBounds>): void {
    const next = new Map<number, Entry>();
    for (const b of outputs) {
      const prev = this.entries.get(b.outputId);
      if (prev && prev.bounds.logicalWidth === b.logicalWidth
               && prev.bounds.logicalHeight === b.logicalHeight) {
        // Bounds size unchanged; position may have moved but stored
        // damage is local and still valid (the output's local space is
        // unchanged; only how global-space damage maps into it shifts,
        // which subsequent damageRect calls handle).
        prev.bounds = b;
        prev.ring.setBounds(b.logicalWidth, b.logicalHeight);
        next.set(b.outputId, prev);
      } else {
        const ring = new OutputDamageRing();
        ring.setBounds(b.logicalWidth, b.logicalHeight);
        if (prev) ring.full();  // size changed; carry over the stale signal
        next.set(b.outputId, { bounds: b, ring });
        // A new or resized output needs an initial frame.
        this.dirty.add(b.outputId);
      }
    }
    // Drop dirty bits for outputs that went away.
    for (const id of [...this.dirty]) {
      if (!next.has(id)) this.dirty.delete(id);
    }
    this.entries = next;
  }

  // Clear damage state on every tracked output. Each ring's next take()
  // returns full. Used for changes that can affect arbitrary screen
  // regions (stack reorder, per-surface fx, full repaint on output set
  // change).
  full(): void {
    for (const e of this.entries.values()) {
      e.ring.full();
      this.dirty.add(e.bounds.outputId);
    }
  }

  // Union a global-logical-space rect into the rings of every output it
  // overlaps, clipping the rect into each output's local space first.
  // Outside-the-union rects (no overlap) are silent no-ops.
  damageRect(gx: number, gy: number, w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const gx1 = gx + w;
    const gy1 = gy + h;
    for (const e of this.entries.values()) {
      const b = e.bounds;
      const lx0 = Math.max(gx,  b.logicalX);
      const ly0 = Math.max(gy,  b.logicalY);
      const lx1 = Math.min(gx1, b.logicalX + b.logicalWidth);
      const ly1 = Math.min(gy1, b.logicalY + b.logicalHeight);
      if (lx1 <= lx0 || ly1 <= ly0) continue;
      // Translate from global to this output's local space (origin = its
      // logical top-left). OutputDamageRing.damageRect itself clips to
      // setBounds, so a slight overflow is fine; we just hand it the
      // already-clipped local rect.
      e.ring.damageRect(lx0 - b.logicalX, ly0 - b.logicalY,
                        lx1 - lx0, ly1 - ly0);
      this.dirty.add(b.outputId);
    }
  }

  // True iff `outputId` has work to draw this vblank: a damageRect/full
  // signal landed on it since the last clearDirty. Unknown outputIds
  // return false (the map has no entry for them). Consulted by the
  // compositor's per-output render gate.
  isDirty(outputId: number): boolean {
    return this.dirty.has(outputId);
  }

  // Mark an output dirty without supplying geometry. For sources that want
  // the per-output render gate to fire but don't know (or don't care
  // about) the affected region -- e.g. an active animation evaluator that
  // hasn't yet pushed its per-surface damage, an active transition pass,
  // a live producer that re-samples every frame. The per-slot damage ring
  // is not modified here; the slot's take() will return its usual region
  // (or full() if first-sight), which is correct.
  markDirty(outputId: number): void {
    if (this.entries.has(outputId)) this.dirty.add(outputId);
  }

  // Drop the dirty bit for `outputId`. Called by the compositor after the
  // output's present commits, so the next vblank is gated on fresh damage.
  clearDirty(outputId: number): void {
    this.dirty.delete(outputId);
  }

  // Consume the accumulated damage for `outputId`'s slot identified by
  // `slotKey` (the scanout-ring handle, or the headless sentinel). Returns
  // the scissor box in GLOBAL logical coords (composite() shifts it by the
  // output's origin), or "full" for a whole-output repaint. An unknown
  // outputId returns full (the next setOutputs will create the ring).
  take(outputId: number, slotKey: bigint): RepaintRegion {
    const e = this.entries.get(outputId);
    if (!e) return { mode: "full" };
    const local = e.ring.take(slotKey);
    if (local.mode === "full") return local;
    return { mode: "partial", box: this.toGlobal(e.bounds, local.box) };
  }

  // For tests / introspection: how many outputs the map currently tracks.
  size(): number { return this.entries.size; }

  private toGlobal(b: OutputBounds, box: DamageBox): DamageBox {
    return { x: box.x + b.logicalX, y: box.y + b.logicalY, w: box.w, h: box.h };
  }
}
