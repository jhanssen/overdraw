// Scene compose tests. Drives JsCompositor.composeRegion / composeOutput /
// registerLiveScene directly + sdk.compose through the in-thread plugin SDK
// against the test harness (real Wayland clients, real GPU). One test
// exercises sdk.compose through the in-thread plugin SDK to prove the
// SDK plumbing path.
//
// Run: npm run test:gpu

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches } from "./harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 320, height: 240 };
const FILL = "--fill-configured";

// ARGB 0xFFRRGGBB -> BGRA readback bytes [B,G,R,A].
function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff, g = (argb >>> 8) & 0xff, b = argb & 0xff,
        a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

async function readbackTexture(jsCompositor, tex, w, h) {
  const r = await jsCompositor.readbackTexture(tex, w, h);
  return r.data;
}

async function waitMappedColored(c, color) {
  const bgra = argbToBgra(color);
  // Wait for the window + a frame whose center shows the color.
  await c.waitFor(c.query, (s) => s.windows.length >= 1, { what: "window" });
  for (let i = 0; i < 60; i++) {
    const px = await c.frameReadback();
    const snap = c.query();
    const w = snap.windows[0];
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);
    if (px && pixelMatches(pixelAt(px, OUT.width, cx, cy), bgra, 4)) {
      return { snap, w, cx, cy, bgra };
    }
    await new Promise((r) => setTimeout(r, 16));
  }
  throw new Error(`window never composited with color ${color.toString(16)}`);
}

// ---------- snapshot ----------

test("compose.scene snapshot equals the on-screen composite", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xff2080c0;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const { w } = await waitMappedColored(c, color);

    // Snapshot scene of the same window list (flat draw list, full output,
    // scale 1 -- equivalent to the on-screen composite of this one window).
    const result = c.jsCompositor.composeRegion({
      drawList: [w.surfaceId],
      region: { x: 0, y: 0, w: OUT.width, h: OUT.height }, scale: 1,
    });
    try {
      const composed = await readbackTexture(c.jsCompositor,
        result.texture, result.outW, result.outH);
      const onscreen = await c.frameReadback();
      assert.equal(composed.length, onscreen.length);
      let mismatches = 0;
      for (let i = 0; i < composed.length; i++) {
        if (composed[i] !== onscreen[i]) mismatches++;
      }
      assert.equal(mismatches, 0, `expected byte-identical; ${mismatches} differ`);
    } finally {
      result.texture.destroy();
    }
  } finally {
    await c.teardown();
  }
});

test("compose.scene snapshot is frozen across subsequent state changes",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xff2080c0;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const { w } = await waitMappedColored(c, color);

    const result = c.jsCompositor.composeRegion({
      drawList: [w.surfaceId],
      region: { x: 0, y: 0, w: OUT.width, h: OUT.height }, scale: 1,
    });
    try {
      // Snapshot taken; now mutate per-surface state and render.
      c.jsCompositor.setSurfaceOpacity(w.surfaceId, 0.2);
      c.jsCompositor.renderFrame();
      const onscreenAfter = await c.frameReadback();
      const composedFrozen = await readbackTexture(c.jsCompositor,
        result.texture, result.outW, result.outH);

      // Snapshot should NOT match the post-mutation on-screen frame:
      // the snapshot is frozen at call time; on-screen reflects the
      // new opacity.
      let differ = 0;
      for (let i = 0; i < composedFrozen.length; i++) {
        if (composedFrozen[i] !== onscreenAfter[i]) differ++;
      }
      assert.ok(differ > 0,
        "snapshot should be frozen; on-screen post-mutation should differ");

      // And the snapshot's center pixel should still show the original
      // full-opacity color.
      const cx = w.rect.x + (w.rect.width >> 1);
      const cy = w.rect.y + (w.rect.height >> 1);
      const bgra = argbToBgra(color);
      assert.ok(pixelMatches(pixelAt(composedFrozen, OUT.width, cx, cy), bgra, 4),
        `snapshot center should still be original color; got ${pixelAt(composedFrozen, OUT.width, cx, cy)}`);
    } finally {
      result.texture.destroy();
    }
  } finally {
    await c.teardown();
  }
});

// ---------- live ----------

test("compose.scene live reflects per-surface state changes", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xff2080c0;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const { w, cx, cy } = await waitMappedColored(c, color);
    const bgra = argbToBgra(color);

    const handle = c.jsCompositor.registerLiveScene({
      outputId: 0, windows: [w.surfaceId],
    });
    try {
      // First read: live texture should match the current state.
      c.jsCompositor.renderFrame();
      const live1 = await readbackTexture(c.jsCompositor,
        handle.texture, handle.outW, handle.outH);
      assert.ok(pixelMatches(pixelAt(live1, OUT.width, cx, cy), bgra, 4),
        `live1 center should be original color; got ${pixelAt(live1, OUT.width, cx, cy)}`);

      // Mutate state; render; live texture should reflect it (premultiplied
      // at 0.5 -> each channel halved). Expected: each component of bgra
      // (except A, which composites to ~255 over opaque-black background)
      // is about half its original.
      c.jsCompositor.setSurfaceOpacity(w.surfaceId, 0.5);
      c.jsCompositor.renderFrame();
      const live2 = await readbackTexture(c.jsCompositor,
        handle.texture, handle.outW, handle.outH);
      const p2 = pixelAt(live2, OUT.width, cx, cy);
      const halfTol = 6;
      for (let i = 0; i < 3; i++) {
        const want = bgra[i] >> 1;
        assert.ok(Math.abs(p2[i] - want) <= halfTol,
          `live2 channel ${i} should be ~${want}; got ${p2}`);
      }

      // And live should be byte-identical to the on-screen composite the
      // same frame.
      const onscreen = await c.frameReadback();
      let mismatches = 0;
      for (let i = 0; i < live2.length; i++) {
        if (live2[i] !== onscreen[i]) mismatches++;
      }
      assert.equal(mismatches, 0,
        `live should equal on-screen this frame; ${mismatches} differ`);
    } finally {
      handle.release();
    }
  } finally {
    await c.teardown();
  }
});

// ---------- two windows ----------

test("composeRegion produces one texture per window over its rect", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT, layout: { masterFraction: 0.5, gap: 0 } });
  try {
    const cA = 0xff3030c0, cB = 0xff30c030;
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]); await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "first" });
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]); await b.ready;
    const snap = await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "second" });

    // Wait for both composited.
    const bgraA = argbToBgra(cA), bgraB = argbToBgra(cB);
    const wA = snap.windows.find((w) => w.title === a.title) ?? snap.windows[1];
    const wB = snap.windows.find((w) => w.title === b.title) ?? snap.windows[0];

    // Wait until both colors visible somewhere.
    let frame;
    for (let i = 0; i < 60; i++) {
      frame = await c.frameReadback();
      const cxA = wA.rect.x + (wA.rect.width >> 1);
      const cyA = wA.rect.y + (wA.rect.height >> 1);
      const cxB = wB.rect.x + (wB.rect.width >> 1);
      const cyB = wB.rect.y + (wB.rect.height >> 1);
      if (pixelMatches(pixelAt(frame, OUT.width, cxA, cyA), bgraA, 4)
          && pixelMatches(pixelAt(frame, OUT.width, cxB, cyB), bgraB, 4)) break;
      await new Promise((r) => setTimeout(r, 16));
    }

    // Compose each window's subtree over its own rect (device scale 1).
    const result = [wA, wB].map((win) => {
      const rect = { x: win.rect.x, y: win.rect.y, w: win.rect.width, h: win.rect.height };
      const cr = c.jsCompositor.composeRegion({ drawList: [win.surfaceId], region: rect, scale: 1 });
      return { id: win.surfaceId, texture: cr.texture, w: cr.outW, h: cr.outH };
    });
    assert.equal(result.length, 2);
    try {
      // Each texture should be a solid color of its corresponding client.
      for (const { id, texture, w: tw, h: th } of result) {
        const composed = await readbackTexture(c.jsCompositor, texture, tw, th);
        const exp = id === wA.surfaceId ? bgraA : bgraB;
        const px = pixelAt(composed, tw, tw >> 1, th >> 1);
        assert.ok(pixelMatches(px, exp, 4),
          `window ${id} center should be its client color; got ${px}, expected ${exp}`);
      }
    } finally {
      for (const r of result) r.texture.destroy();
    }
  } finally {
    await c.teardown();
  }
});

// ---------- release ----------

test("compose.scene release destroys the texture and removes the live registration",
    { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xff2080c0;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const { w } = await waitMappedColored(c, color);

    // Register a bunch of live scenes; verify the list grows and release
    // shrinks it. We reach into the compositor's internal state for the
    // assertion (acceptable in a GPU integration test; the field is part
    // of the verified surface).
    const handles = [];
    for (let i = 0; i < 5; i++) {
      handles.push(c.jsCompositor.registerLiveScene({
        outputId: 0, windows: [w.surfaceId],
      }));
    }
    assert.equal(c.jsCompositor.liveScenes.length, 5);
    // Frame still runs successfully with multiple live composers.
    c.jsCompositor.renderFrame();

    // Release each.
    for (const h of handles) h.release();
    assert.equal(c.jsCompositor.liveScenes.length, 0);
    // Idempotent.
    handles[0].release();
    assert.equal(c.jsCompositor.liveScenes.length, 0);
  } finally {
    await c.teardown();
  }
});

// ---------- SDK roundtrip ----------

test("createInThreadCompose wraps the compositor compose methods", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  const { createInThreadCompose } = await import(
    "../packages/core/dist/plugins/compose-sdk.js"
  );
  const { makeComposeFlatteners } = await import(
    "../packages/core/dist/subsurfaces.js"
  );
  try {
    const color = 0xff2080c0;
    const { ready } = c.spawnClient([FILL, "--color", color.toString(16)]);
    await ready;
    const { w } = await waitMappedColored(c, color);

    const fl = makeComposeFlatteners(c.state);
    const sdkCompose = createInThreadCompose(
      c.jsCompositor, (id) => id === 0, undefined,
      fl.flattenWindows, fl.outputRegion, fl.windowRegion);
    assert.ok(sdkCompose, "createInThreadCompose returns non-null when compositor exposes the methods");

    // snapshot
    const snap = await sdkCompose.scene({
      outputId: 0, windows: [w.surfaceId], mode: "snapshot",
    });
    assert.equal(snap.outW, OUT.width);
    assert.equal(snap.outH, OUT.height);
    const px = await readbackTexture(c.jsCompositor, snap.texture, snap.outW, snap.outH);
    const cx = w.rect.x + (w.rect.width >> 1);
    const cy = w.rect.y + (w.rect.height >> 1);
    assert.ok(pixelMatches(pixelAt(px, OUT.width, cx, cy), argbToBgra(color), 4),
      "snapshot through SDK has the expected center color");
    await snap.release();

    // live
    const live = await sdkCompose.scene({
      outputId: 0, windows: [w.surfaceId], mode: "live",
    });
    const before = c.jsCompositor.liveScenes.length;
    assert.equal(before, 1, "live registration tracked in compositor");
    await live.release();
    assert.equal(c.jsCompositor.liveScenes.length, 0, "release deregisters");

    // outputId rejection
    let threw = false;
    try {
      await sdkCompose.scene({ outputId: 99, windows: [], mode: "snapshot" });
    } catch (e) { threw = true; assert.match(e.message, /outputId=99/); }
    assert.ok(threw, "unknown outputId throws");
  } finally {
    await c.teardown();
  }
});
