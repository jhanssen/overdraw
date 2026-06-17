import { test } from "node:test";
import assert from "node:assert/strict";

import { nextOutputPosition } from "../packages/core/dist/output/arrangement.js";

// Minimal OutputRecord shape the fallback reads.
function out(x, width, y = 0, height = 1080) {
  return {
    logicalPosition: { x, y },
    logicalSize: { width, height },
  };
}

test("nextOutputPosition: origin when there are no outputs", () => {
  assert.deepEqual(nextOutputPosition([]), { x: 0, y: 0 });
});

test("nextOutputPosition: right of a single output, top-aligned", () => {
  assert.deepEqual(nextOutputPosition([out(0, 2560)]), { x: 2560, y: 0 });
});

test("nextOutputPosition: right of the rightmost edge across several outputs", () => {
  // Two outputs already placed side by side; the next goes past both.
  const outputs = [out(0, 2560), out(2560, 1920)];
  assert.deepEqual(nextOutputPosition(outputs), { x: 4480, y: 0 });
});

test("nextOutputPosition: uses max right edge, not insertion order", () => {
  // Rightmost output listed first; still resolves to the furthest edge.
  const outputs = [out(2560, 1920), out(0, 2560)];
  assert.deepEqual(nextOutputPosition(outputs), { x: 4480, y: 0 });
});

test("nextOutputPosition: a non-origin left output still extends from its edge", () => {
  // An output whose x is offset; the next sits past x + width.
  assert.deepEqual(nextOutputPosition([out(100, 800)]), { x: 900, y: 0 });
});
