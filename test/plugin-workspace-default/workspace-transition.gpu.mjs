// Phase 8 step 5: workspace plugin uses sdk.transitions for animated
// show. Two clients tile the output; we move one to workspace 2; then
// workspace.show({index:2, transition:{kind, duration}}) animates the
// swap. Verifies:
//
//   1. While the transition runs, the on-screen output shows
//      transition-pass pixels (a blend of the FROM and TO snapshots),
//      not the normal composite of either stack.
//   2. After the transition resolves, the compositor's setOutputStack
//      has been applied (the new workspace's window is on screen at
//      its expected tile; the old workspace's window is gone).
//
// This is the end-to-end smoke for phase 8: caller -> workspace plugin
// -> sdk.compose -> sdk.transitions -> compositor.setActiveTransition
// -> per-frame transition pass -> commit (atomic setOutputStack) ->
// next renderFrame draws the new state, no glitch.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setupCompositor, canRunGpu, pixelAt, pixelMatches, settled,
} from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 320, height: 240 };
const FILL = "--fill-configured";
const DURATION = 400;

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

async function readUntil(c, pred, { timeoutMs = 2000 } = {}) {
  return await settled(() => c.frameReadback(),
    (px) => px && pred(px),
    { timeoutMs, intervalMs: 16, what: "frame readback" });
}

test("workspace.show with transition: animated swap, post-transition state visible",
  { skip }, async () => {
  // opts.transitions = true brings up the scene registry + transition
  // evaluator + broker + the inThreadGpu bundle so the bundled
  // workspace plugin gets sdk.compose + sdk.transitions wired.
  const c = await setupCompositor({ headless: OUT, transitions: true });
  try {
    const cA = 0xffff0000;   // red
    const cB = 0xff0000ff;   // blue
    const bgraA = argbToBgra(cA);
    const bgraB = argbToBgra(cB);
    const BLACK = [0, 0, 0, 255];

    // Spawn A + B; both tile workspace 1.
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]);
    await b.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "A+B mapped" });
    await c.runtime.flush();
    await settled(
      () => c.runtime.invokeAction("workspace.list", { outputId: 0 }),
      (l) => l[0]?.members?.length === 2,
      { what: "workspace 1 has both members" });

    // WM master-stack: windows[0] is master (B), [1] is stack (A).
    const snap = c.query();
    const master = snap.windows[0]; // B
    const stack = snap.windows[1];  // A
    const mcx = master.rect.x + (master.rect.width >> 1);
    const mcy = master.rect.y + (master.rect.height >> 1);
    const scx = stack.rect.x + (stack.rect.width >> 1);
    const scy = stack.rect.y + (stack.rect.height >> 1);

    // Wait for the baseline: both tiles show their client's color.
    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(px, OUT.width, scx, scy), bgraA, 4));

    // Create workspace 2 and move B to it. Now workspace 1 has [A],
    // workspace 2 has [B]; workspace 1 is shown.
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.move-window",
      { surfaceId: master.surfaceId, index: 2 });
    await c.runtime.flush();

    // Baseline after move: master-tile (B's location) is black
    // (B is on hidden workspace 2), stack-tile shows A's red.
    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), BLACK, 4)
      && pixelMatches(pixelAt(px, OUT.width, scx, scy), bgraA, 4));

    // Now: animated show of workspace 2. This is the path under test.
    // The plugin: captures FROM snapshot of [A], captures TO snapshot
    // of [B], runs the transition, applies setOutputStack on commit.
    const showPromise = c.runtime.invokeAction("workspace.show",
      { index: 2, transition: { kind: "crossfade", duration: DURATION } });

    // Mid-transition: somewhere between baseline FROM (red at A's tile,
    // black at B's tile) and TO (black at A's tile, blue at B's tile)
    // there's a blended frame. We're lenient about exactly which frame
    // we sample; just need to see SOMETHING that isn't the FROM or TO
    // pure state in the middle of the animation (the readback at
    // master's center should be partway between black and blue).
    //
    // Poll for an explicitly transition-y center pixel: either bluish
    // (transition past midpoint) or part of an in-progress blend. The
    // mid-frame on either side won't match the pure FROM/TO any more.
    let sawMid = false;
    const tMid = Date.now();
    while (Date.now() - tMid < DURATION + 50) {
      const px = await c.frameReadback();
      if (!px) { await new Promise((r) => setTimeout(r, 8)); continue; }
      const mp = pixelAt(px, OUT.width, mcx, mcy);
      // A frame where master-tile center is BETWEEN pure black
      // (FROM at master, hidden) and pure blue (TO at master) is
      // unambiguous transition output. Tolerate either side of
      // midpoint by checking blue channel > 16 (out of pure black)
      // AND we haven't yet hit the post-transition steady state.
      if (mp[0] > 16 && mp[0] < 250) {
        sawMid = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 8));
    }
    assert.ok(sawMid,
      "did not observe an in-flight transition frame (master-tile center " +
      "should pass through intermediate blue values between FROM=black " +
      "and TO=blue)");

    // Wait for the transition to complete + commit to apply.
    await showPromise;

    // After the transition, the new stack is in place. Master-tile
    // shows B's blue; stack-tile shows black (A is on hidden ws1).
    const px2 = await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(p, OUT.width, scx, scy), BLACK, 4));
    assert.ok(pixelMatches(pixelAt(px2, OUT.width, mcx, mcy), bgraB, 4),
      `post-transition: master-tile should show B; got ${pixelAt(px2, OUT.width, mcx, mcy)}`);
    assert.ok(pixelMatches(pixelAt(px2, OUT.width, scx, scy), BLACK, 4),
      `post-transition: stack-tile should be cleared; got ${pixelAt(px2, OUT.width, scx, scy)}`);

    // And the workspace plugin's state-of-record reflects the shown ws.
    const cur = await c.runtime.invokeAction("workspace.current", { outputId: 0 });
    assert.equal(cur.index, 2,
      `post-transition: workspace.current should be 2, got ${cur?.index}`);
  } finally {
    await c.teardown();
  }
});

test("workspace.show without transition: plain swap still works (regression)",
  { skip }, async () => {
  // Non-transition path must keep working after the transition wiring.
  // Same setup, no transition param -> instant swap.
  const c = await setupCompositor({ headless: OUT, transitions: true });
  try {
    const cA = 0xffff0000, cB = 0xff0000ff;
    const bgraA = argbToBgra(cA), bgraB = argbToBgra(cB);
    const BLACK = [0, 0, 0, 255];

    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A" });
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]);
    await b.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "A+B" });
    await c.runtime.flush();

    const snap = c.query();
    const master = snap.windows[0];
    const stack = snap.windows[1];
    const mcx = master.rect.x + (master.rect.width >> 1);
    const mcy = master.rect.y + (master.rect.height >> 1);
    const scx = stack.rect.x + (stack.rect.width >> 1);
    const scy = stack.rect.y + (stack.rect.height >> 1);

    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(px, OUT.width, scx, scy), bgraA, 4));

    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.move-window",
      { surfaceId: master.surfaceId, index: 2 });
    await c.runtime.flush();
    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), BLACK, 4));

    // No transition field -> instant swap.
    await c.runtime.invokeAction("workspace.show", { index: 2 });
    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(px, OUT.width, scx, scy), BLACK, 4));
  } finally {
    await c.teardown();
  }
});
