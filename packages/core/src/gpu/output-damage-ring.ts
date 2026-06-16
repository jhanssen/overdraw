// Per-output-buffer composite damage, in output LOGICAL coordinates.
//
// One region per scanout-ring slot, keyed by the slot's stable
// acquireOutputTexture handle (the headless target uses a single fixed key).
// A handle absent from the map means "repaint the whole output" -- first sight
// of that slot, or after full() cleared the ring. A present-but-empty region
// means "nothing changed since this slot last rendered".
//
// Buffer age falls out for free: damageRect() unions into EVERY tracked slot,
// and take() resets only the slot being rendered. A slot left unrendered for
// several frames therefore accumulates every damage in the interim, so when it
// is next acquired the returned region covers all of it (its dmabuf still holds
// the frame from when it was last presented).

import { Region } from "../protocols/region.js";

export interface DamageBox { x: number; y: number; w: number; h: number }
export type RepaintRegion = { mode: "full" } | { mode: "partial"; box: DamageBox };

export class OutputDamageRing {
  private slots = new Map<bigint, Region>();
  private width = 1;
  private height = 1;

  // Output logical size, used to clip damage and to detect a full-output box.
  setBounds(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  // Mark the whole output stale for every slot (the next frame on any slot
  // repaints fully).
  full(): void {
    this.slots.clear();
  }

  // Union an output-logical rect into every tracked slot, clipped to bounds.
  damageRect(x: number, y: number, w: number, h: number): void {
    if (w <= 0 || h <= 0 || this.slots.size === 0) return;
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    for (const region of this.slots.values()) region.add(x0, y0, x1 - x0, y1 - y0);
  }

  // Consume the accumulated damage for the slot about to render, resetting it
  // (the slot becomes current). Other slots keep their damage. Returns how much
  // of the slot to repaint; a box spanning (nearly) the whole output collapses
  // to "full" so the caller takes the cheaper clear path.
  take(key: bigint): RepaintRegion {
    const existing = this.slots.get(key);
    this.slots.set(key, new Region());
    if (!existing) return { mode: "full" };           // first sight / after full()
    const rects = existing.snapshot();
    if (rects.length === 0) return { mode: "full" };  // spurious wake: full is safe
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) {
      if (r.x < x0) x0 = r.x;
      if (r.y < y0) y0 = r.y;
      if (r.x + r.width > x1) x1 = r.x + r.width;
      if (r.y + r.height > y1) y1 = r.y + r.height;
    }
    if (x0 <= 0 && y0 <= 0 && x1 >= this.width && y1 >= this.height) return { mode: "full" };
    return { mode: "partial", box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }
}
