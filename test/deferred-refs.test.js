// Pure-unit tests for the deferred-ref resolver. No runtime, no plugin
// harness -- just the walker over an arbitrary params payload.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveRefs, buildResolver }
  from "../packages/core/dist/plugins/deferred-refs.js";
import { ref, isDeferredRef }
  from "../packages/core/dist/config/refs.js";

// ---- ref exports ---------------------------------------------------------

test("ref exports: every name maps to a { $ref: name } sentinel", () => {
  for (const name of [
    "surfaceUnderPointer", "focusedWindow",
    "pointerX", "pointerY", "activeOutput", "currentWorkspace",
  ]) {
    const r = ref[name];
    assert.ok(r);
    assert.equal(r.$ref, name);
  }
});

test("isDeferredRef: recognizes { $ref: string }", () => {
  assert.equal(isDeferredRef(ref.focusedWindow), true);
  assert.equal(isDeferredRef({ $ref: "anything" }), true);
});

test("isDeferredRef: rejects non-refs", () => {
  assert.equal(isDeferredRef(null), false);
  assert.equal(isDeferredRef(undefined), false);
  assert.equal(isDeferredRef(42), false);
  assert.equal(isDeferredRef("ref"), false);
  assert.equal(isDeferredRef({}), false);
  assert.equal(isDeferredRef({ ref: "x" }), false);
  assert.equal(isDeferredRef({ $ref: "" }), false);     // empty name
  assert.equal(isDeferredRef([1, 2]), false);
});

// ---- resolveRefs ---------------------------------------------------------

test("resolveRefs: substitutes a top-level ref", () => {
  const r = resolveRefs(ref.focusedWindow, { focusedWindow: () => 42 });
  assert.equal(r, 42);
});

test("resolveRefs: substitutes a ref nested in an object", () => {
  const params = { surfaceId: ref.focusedWindow, index: 1 };
  const r = resolveRefs(params, { focusedWindow: () => 42 });
  assert.deepEqual(r, { surfaceId: 42, index: 1 });
});

test("resolveRefs: substitutes refs nested in arrays", () => {
  const r = resolveRefs([ref.pointerX, ref.pointerY], {
    pointerX: () => 100, pointerY: () => 200,
  });
  assert.deepEqual(r, [100, 200]);
});

test("resolveRefs: substitutes refs nested deeply", () => {
  const params = { a: { b: [{ c: ref.pointerX }] } };
  const r = resolveRefs(params, { pointerX: () => 5 });
  assert.deepEqual(r, { a: { b: [{ c: 5 }] } });
});

test("resolveRefs: unknown ref name -> undefined", () => {
  const r = resolveRefs({ x: ref.focusedWindow }, {});
  assert.deepEqual(r, { x: undefined });
});

test("resolveRefs: resolver returning null is preserved (not treated as unknown)", () => {
  const r = resolveRefs(ref.focusedWindow, { focusedWindow: () => null });
  assert.equal(r, null);
});

test("resolveRefs: does not mutate the input", () => {
  const original = { x: ref.focusedWindow, y: 7 };
  const snapshot = JSON.stringify(original);
  resolveRefs(original, { focusedWindow: () => 1 });
  assert.equal(JSON.stringify(original), snapshot);
});

test("resolveRefs: passes through primitives unchanged", () => {
  for (const v of [42, "hello", true, false, null, undefined]) {
    assert.equal(resolveRefs(v, {}), v);
  }
});

test("resolveRefs: resolver invoked once per occurrence (not memoized)", () => {
  let calls = 0;
  resolveRefs([ref.focusedWindow, ref.focusedWindow], {
    focusedWindow: () => ++calls,
  });
  assert.equal(calls, 2);
});

test("resolveRefs: resolver error propagates", () => {
  assert.throws(
    () => resolveRefs(ref.focusedWindow, { focusedWindow: () => { throw new Error("boom"); } }),
    /boom/);
});

// ---- buildResolver -------------------------------------------------------

test("buildResolver: returns a closed-over function", () => {
  const fn = buildResolver({ focusedWindow: () => 7 });
  assert.equal(fn({ id: ref.focusedWindow }).id, 7);
});

test("buildResolver: resolvers are live (read each invocation)", () => {
  let current = 1;
  const fn = buildResolver({ focusedWindow: () => current });
  assert.equal(fn(ref.focusedWindow), 1);
  current = 99;
  assert.equal(fn(ref.focusedWindow), 99);
});
