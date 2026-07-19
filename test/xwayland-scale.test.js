// Pure-unit tests for the Xwayland HiDPI effective-scale resolver. No xcb, no GPU.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveXwaylandScale, sizeHintsToLogical } from "../packages/core/dist/xwayland/scale.js";

function stateWith(scales) {
  const outputs = new Map();
  let id = 0;
  for (const s of scales) outputs.set(++id, { id, scale: s });
  return { outputs };
}

test("explicit configScale in 1..3 is returned verbatim, ignoring outputs", () => {
  for (const n of [1, 1.5, 2, 2.25, 3]) {
    assert.equal(resolveXwaylandScale(stateWith([1]), n), n);
    assert.equal(resolveXwaylandScale(stateWith([3]), n), n);
    assert.equal(resolveXwaylandScale(stateWith([]), n), n);
  }
});

test("configScale=0 (auto) returns the max output scale exactly", () => {
  assert.equal(resolveXwaylandScale(stateWith([1]), 0), 1);
  assert.equal(resolveXwaylandScale(stateWith([1.5]), 0), 1.5);
  assert.equal(resolveXwaylandScale(stateWith([1.25, 1.5]), 0), 1.5);
  assert.equal(resolveXwaylandScale(stateWith([2]), 0), 2);
  assert.equal(resolveXwaylandScale(stateWith([2.5]), 0), 2.5);
  assert.equal(resolveXwaylandScale(stateWith([1, 2.5, 1.5]), 0), 2.5);
});

test("auto with no outputs falls back to 1", () => {
  assert.equal(resolveXwaylandScale({ outputs: new Map() }, 0), 1);
  assert.equal(resolveXwaylandScale({}, 0), 1);
});

test("scales above 3 are clamped to 3 (explicit and auto)", () => {
  assert.equal(resolveXwaylandScale(stateWith([4]), 0), 3);
  assert.equal(resolveXwaylandScale(stateWith([99]), 0), 3);
  // The config loader rejects explicit > 3, but the resolver clamps
  // defensively anyway.
  assert.equal(resolveXwaylandScale(stateWith([1]), 99), 3);
});

test("scales below 1 floor to 1", () => {
  assert.equal(resolveXwaylandScale(stateWith([0.5]), 0), 1);
  assert.equal(resolveXwaylandScale(stateWith([-1]), 0), 1);
});

test("NaN / non-finite in an output scale is ignored", () => {
  assert.equal(resolveXwaylandScale(stateWith([NaN, 1.5]), 0), 1.5);
});

test("sizeHintsToLogical divides X-device hints by the scale", () => {
  assert.deepEqual(
    sizeHintsToLogical({ width: 800, height: 600 }, { width: 1600, height: 1200 }, 2),
    { minSize: { width: 400, height: 300 }, maxSize: { width: 800, height: 600 } });
  assert.deepEqual(
    sizeHintsToLogical({ width: 300, height: 150 }, null, 1.5),
    { minSize: { width: 200, height: 100 }, maxSize: null });
  assert.deepEqual(
    sizeHintsToLogical(null, null, 2),
    { minSize: null, maxSize: null });
});

test("sizeHintsToLogical rounds conservatively: ceil min, floor max", () => {
  // 801/1.5 = 534, 1601/1.5 = 1067.33...
  assert.deepEqual(
    sizeHintsToLogical({ width: 801, height: 601 }, { width: 1601, height: 1201 }, 1.5),
    { minSize: { width: 534, height: 401 }, maxSize: { width: 1067, height: 800 } });
});

test("sizeHintsToLogical keeps min <= max for fixed-size hints", () => {
  // min == max == 1000 at 1.5: ceil(666.67)=667 vs floor(666.67)=666
  // would invert; max lifts to min.
  assert.deepEqual(
    sizeHintsToLogical({ width: 1000, height: 1000 }, { width: 1000, height: 1000 }, 1.5),
    { minSize: { width: 667, height: 667 }, maxSize: { width: 667, height: 667 } });
});
