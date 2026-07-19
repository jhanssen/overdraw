// Pure-unit tests for the Xwayland HiDPI effective-scale resolver. No xcb, no GPU.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveXwaylandScale } from "../packages/core/dist/xwayland/scale.js";

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
