import { test } from "node:test";
import assert from "node:assert/strict";

import { OutputDamageMap } from "../packages/core/dist/gpu/output-damage-map.js";

function out(id, x, y, w, h) {
  return { outputId: id, logicalX: x, logicalY: y, logicalWidth: w, logicalHeight: h };
}

const SLOT_0 = 1n;
const SLOT_1 = 2n;

// --- setOutputs + take on fresh outputs ---

test("first take on a new output is full (no damage seen yet)", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  assert.deepEqual(m.take(0, SLOT_0), { mode: "full" });
});

test("take on an unknown outputId returns full", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  assert.deepEqual(m.take(7, SLOT_0), { mode: "full" });
});

test("size reflects the registered outputs", () => {
  const m = new OutputDamageMap();
  assert.equal(m.size(), 0);
  m.setOutputs([out(0, 0, 0, 100, 100), out(1, 100, 0, 100, 100)]);
  assert.equal(m.size(), 2);
});

// --- damageRect dispatch ---

test("damage entirely inside one output dirties only that output", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100), out(1, 100, 0, 100, 100)]);
  // Prime both slots with full() then take() so the next take sees a
  // partial region (not the first-sight full).
  m.full();
  m.take(0, SLOT_0); m.take(1, SLOT_0);

  m.damageRect(20, 20, 10, 10);
  assert.deepEqual(m.take(0, SLOT_0),
    { mode: "partial", box: { x: 20, y: 20, w: 10, h: 10 } });
  // Output 1 saw nothing -> take is full (empty region collapses to full).
  // (OutputDamageRing's contract: empty region post-take = full to be safe.)
  assert.deepEqual(m.take(1, SLOT_0), { mode: "full" });
});

test("damage spanning two outputs dirties both with clipped local boxes", () => {
  // Two outputs side by side: 0 at [0..100), 1 at [100..200).
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100), out(1, 100, 0, 100, 100)]);
  m.full();
  m.take(0, SLOT_0); m.take(1, SLOT_0);

  // Damage rect from x=80 width 40 -> covers x in [80, 120). Crosses the
  // boundary. Output 0 sees [80..100); output 1 sees [100..120) which in
  // global coords is x=100 width 20.
  m.damageRect(80, 10, 40, 5);
  assert.deepEqual(m.take(0, SLOT_0),
    { mode: "partial", box: { x: 80, y: 10, w: 20, h: 5 } });
  assert.deepEqual(m.take(1, SLOT_0),
    { mode: "partial", box: { x: 100, y: 10, w: 20, h: 5 } });
});

test("damage outside the union is a no-op", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  m.full();
  m.take(0, SLOT_0);

  m.damageRect(500, 500, 10, 10);
  // No damage was unioned; take returns full (empty-region safe collapse).
  assert.deepEqual(m.take(0, SLOT_0), { mode: "full" });
});

test("damage at a non-origin output uses that output's local space", () => {
  // Output 1 is positioned at x=200,y=100 in global space.
  const m = new OutputDamageMap();
  m.setOutputs([out(1, 200, 100, 100, 100)]);
  m.full();
  m.take(1, SLOT_0);

  m.damageRect(210, 110, 10, 10);
  // Returned box is in GLOBAL coords (matches the input).
  assert.deepEqual(m.take(1, SLOT_0),
    { mode: "partial", box: { x: 210, y: 110, w: 10, h: 10 } });
});

test("damage extending past the union edge is clipped to the union", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  m.full();
  m.take(0, SLOT_0);

  // Rect x=80 w=50 -> would extend to x=130; clipped to x=80 w=20.
  m.damageRect(80, 10, 50, 5);
  assert.deepEqual(m.take(0, SLOT_0),
    { mode: "partial", box: { x: 80, y: 10, w: 20, h: 5 } });
});

// --- buffer age (per-slot damage carry) ---

test("a slot not rendered this frame accumulates damage from intervening frames", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  // Frame 1 on slot 0: first sight, full.
  assert.equal(m.take(0, SLOT_0).mode, "full");
  // Frame 2: first sight of slot 1, full.
  assert.equal(m.take(0, SLOT_1).mode, "full");
  // Now both slots are tracked. Damage two regions; render only slot 0.
  m.damageRect(10, 10, 5, 5);
  m.damageRect(80, 80, 5, 5);
  // Slot 0 gets the bounding box of both regions.
  assert.deepEqual(m.take(0, SLOT_0),
    { mode: "partial", box: { x: 10, y: 10, w: 75, h: 75 } });
  // Slot 1 still has both regions accumulated.
  m.damageRect(50, 50, 2, 2);
  assert.deepEqual(m.take(0, SLOT_1),
    { mode: "partial", box: { x: 10, y: 10, w: 75, h: 75 } });
});

// --- full() ---

test("full() forces every output's next take to full", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100), out(1, 100, 0, 100, 100)]);
  m.take(0, SLOT_0); m.take(1, SLOT_0);  // settle to tracked

  m.damageRect(10, 10, 5, 5);
  m.full();
  assert.equal(m.take(0, SLOT_0).mode, "full");
  assert.equal(m.take(1, SLOT_0).mode, "full");
});

// --- output set changes ---

test("a removed output's ring is dropped", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100), out(1, 100, 0, 100, 100)]);
  m.setOutputs([out(0, 0, 0, 100, 100)]);  // drop output 1
  assert.equal(m.size(), 1);
  // take on the gone output is treated as unknown -> full.
  assert.deepEqual(m.take(1, SLOT_0), { mode: "full" });
});

test("an output that survives a setOutputs keeps its accumulated damage", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  m.full(); m.take(0, SLOT_0);  // settle

  m.damageRect(10, 10, 5, 5);
  // Re-call setOutputs with the same output -> the ring is preserved.
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  assert.deepEqual(m.take(0, SLOT_0),
    { mode: "partial", box: { x: 10, y: 10, w: 5, h: 5 } });
});

test("resizing an output forces a full repaint", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  m.full(); m.take(0, SLOT_0);

  m.damageRect(10, 10, 5, 5);
  // New dims -> ring is recreated (slot textures will be recreated too).
  m.setOutputs([out(0, 0, 0, 200, 200)]);
  assert.equal(m.take(0, SLOT_0).mode, "full");
});

test("moving an output (logical position) preserves accumulated damage", () => {
  const m = new OutputDamageMap();
  m.setOutputs([out(0, 0, 0, 100, 100)]);
  m.full(); m.take(0, SLOT_0);

  m.damageRect(10, 10, 5, 5);
  // Same size, new global position. Damage stored in local coords carries
  // over; the take returns the (now-translated) global box.
  m.setOutputs([out(0, 500, 500, 100, 100)]);
  assert.deepEqual(m.take(0, SLOT_0),
    { mode: "partial", box: { x: 510, y: 510, w: 5, h: 5 } });
});
