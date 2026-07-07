// Pure-unit coverage for the frozen-surface snapshot texture pool
// (JsCompositor.acquireSnapTex / releaseSnapTex). The pool must be bounded
// per size AND globally: without the global bound, a resize session that
// visits many distinct sizes pins up to SNAP_POOL_PER_SIZE textures per
// "WxH" bucket for the process lifetime.
//
// The two methods only touch snapPool/snapPoolCount/device/format/g, so
// they are driven against a fake `this` with a stub device -- no GPU.

import { test } from "node:test";
import assert from "node:assert/strict";

import { JsCompositor } from "../packages/core/dist/gpu/compositor.js";

const acquire = JsCompositor.prototype.acquireSnapTex;
const release = JsCompositor.prototype.releaseSnapTex;

function fakeCompositor() {
  let created = 0;
  const self = {
    snapPool: new Map(),
    snapPoolCount: 0,
    format: "bgra8unorm",
    g: { GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 } },
    device: {
      createTexture(desc) {
        created++;
        return {
          desc, destroyed: false,
          destroy() { this.destroyed = true; },
          createView: () => ({}),
        };
      },
    },
    createdCount: () => created,
  };
  return self;
}

function pooledTotal(self) {
  let n = 0;
  for (const arr of self.snapPool.values()) n += arr.length;
  return n;
}

test("release/acquire round-trips a texture through the pool", () => {
  const c = fakeCompositor();
  const snap = acquire.call(c, 100, 50);
  release.call(c, snap);
  assert.equal(pooledTotal(c), 1);
  const again = acquire.call(c, 100, 50);
  assert.equal(again.tex, snap.tex, "same texture reused");
  assert.equal(c.createdCount(), 1);
  assert.equal(pooledTotal(c), 0);
  assert.equal(c.snapPool.size, 0, "emptied bucket is deleted");
});

test("per-size cap: a fifth release of the same size destroys the texture", () => {
  const c = fakeCompositor();
  const snaps = Array.from({ length: 5 }, () => acquire.call(c, 64, 64));
  for (const s of snaps.slice(0, 4)) release.call(c, s);
  assert.equal(pooledTotal(c), 4);
  release.call(c, snaps[4]);
  assert.equal(pooledTotal(c), 4);
  assert.equal(snaps[4].tex.destroyed, true);
});

test("global cap: pooled textures across many sizes stay bounded, oldest size evicted", () => {
  const c = fakeCompositor();
  // 8 distinct sizes x 4 releases each = 32 releases; the pool must hold
  // no more than the global cap, evicting from the least-recent sizes.
  const sizes = Array.from({ length: 8 }, (_, i) => [100 + i, 100 + i]);
  for (const [w, h] of sizes) {
    const snaps = Array.from({ length: 4 }, () => acquire.call(c, w, h));
    for (const s of snaps) release.call(c, s);
  }
  assert.ok(pooledTotal(c) <= 16, `pooled ${pooledTotal(c)} > global cap`);
  assert.equal(c.snapPoolCount, pooledTotal(c), "count bookkeeping consistent");
  // The earliest size's bucket was evicted entirely.
  assert.equal(c.snapPool.has("100x100"), false);
  // The most recent size's bucket is intact.
  assert.equal(c.snapPool.get("107x107").length, 4);
});

test("re-releasing a hot size keeps it resident while colder sizes are evicted", () => {
  const c = fakeCompositor();
  // Fill the hot bucket.
  const hot = Array.from({ length: 4 }, () => acquire.call(c, 10, 10));
  for (const s of hot) release.call(c, s);
  // Cycle colder sizes to push the pool past the cap, but touch the hot
  // size between each so its recency stays fresh.
  for (let i = 0; i < 8; i++) {
    const cold = Array.from({ length: 4 }, () => acquire.call(c, 200 + i, 200 + i));
    for (const s of cold) release.call(c, s);
    const h = acquire.call(c, 10, 10);
    release.call(c, h);
  }
  assert.ok(c.snapPool.has("10x10"), "hot size stays pooled");
  assert.ok(pooledTotal(c) <= 16);
});
