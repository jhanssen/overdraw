// GPU integration: real wayland clients + the bundled workspace plugin.
// Covers the plugin seeing window.map (single-client wiring) and the
// effect of workspace.move-window + workspace.show on what composites
// (two-client pixel verification).

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const FILL = "--fill-configured";

// 0xAARRGGBB as the client stores it -> BGRA readback bytes [B, G, R, A].
function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}

// Poll the readback until pred(px) passes (compositor may take a frame or
// two to reflect a stack change).
async function readUntil(c, pred, { timeoutMs = 2000 } = {}) {
  return await settled(() => c.frameReadback(),
    (px) => px && pred(px),
    { timeoutMs, intervalMs: 16, what: "frame readback" });
}

test("workspace plugin: a mapped window joins workspace 1's members", { skip }, async () => {
  const c = await setupCompositor({ headless: OUT });
  try {
    const a = c.spawnClient([FILL, "--color", "ff3030c0"]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "window mapped" });

    // window.map is emitted by the protocol layer's frame sweep, then
    // republished from coreBus to pluginBus, then dispatched to the
    // workspace plugin's onMap. flush() drains the in-flight plugin
    // requests; settled() catches any race the flush misses.
    await c.runtime.flush();
    const list = await settled(
      () => c.runtime.invokeAction("workspace.list", { outputId: 0 }),
      (l) => l[0]?.members?.length === 1,
      { what: "workspace 1 has one member" });

    assert.equal(list.length, 1);
    assert.equal(list[0].index, 1);
    assert.equal(list[0].members.length, 1);
    assert.equal(list[0].members[0], c.query().windows[0].surfaceId);
  } finally {
    await c.teardown();
  }
});

test("workspace plugin: move-window + show isolates a workspace's clients (pixel)", { skip }, async () => {
  // Core design (core-plugin-api.md): setOutputStack changes the COMPOSITOR's
  // per-output draw list, NOT the WM's layout. The WM keeps tiling all known
  // windows; the compositor only renders those listed by setOutputStack. So
  // when a window moves to a hidden workspace, the WM's layout still has
  // both tiles, but the hidden window's tile is cleared to black (the
  // compositor's clearValue) instead of showing that window's pixels.
  const c = await setupCompositor({ headless: OUT });
  try {
    const cA = 0xff3030c0;   // blue-ish
    const cB = 0xff30c030;   // green-ish
    const bgraA = argbToBgra(cA);
    const bgraB = argbToBgra(cB);
    const BLACK = [0, 0, 0, 255];

    // Spawn client A.
    const a = c.spawnClient([FILL, "--color", cA.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "A mapped" });

    // Spawn client B.
    const b = c.spawnClient([FILL, "--color", cB.toString(16)]);
    await b.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 2, { what: "A+B mapped" });
    await c.runtime.flush();
    await settled(
      () => c.runtime.invokeAction("workspace.list", { outputId: 0 }),
      (l) => l[0]?.members?.length === 2,
      { what: "workspace 1 has both members" });

    // WM master-stack: windows[0] is the master (last-mapped = B), [1] is
    // the stack (A).
    const snap2 = c.query();
    const master = snap2.windows[0]; // B
    const stack = snap2.windows[1];  // A
    const mcx = master.rect.x + (master.rect.width >> 1);
    const mcy = master.rect.y + (master.rect.height >> 1);
    const scx = stack.rect.x + (stack.rect.width >> 1);
    const scy = stack.rect.y + (stack.rect.height >> 1);

    // Baseline: composited output shows both colors at their tiles.
    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(px, OUT.width, scx, scy), bgraA, 4));

    // Create workspace 2 and move client B (master) there.
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.move-window",
      { surfaceId: master.surfaceId, index: 2 });
    await c.runtime.flush();
    await settled(
      () => c.runtime.invokeAction("workspace.list", { outputId: 0 }),
      (l) => l.length === 2 && l[0].members.length === 1 && l[1].members.length === 1,
      { what: "B moved to workspace 2" });

    // After the move, workspace 1 has only A: the layout-driver lays out a
    // 1-window master-stack, A spans the full tile region. The old master
    // tile (formerly B) and the old stack tile (formerly A) both now show
    // A's color.
    const px1 = await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, mcx, mcy), bgraA, 4)
      && pixelMatches(pixelAt(p, OUT.width, scx, scy), bgraA, 4));
    assert.ok(pixelMatches(pixelAt(px1, OUT.width, mcx, mcy), bgraA, 4),
      `master tile shows A after move; got ${pixelAt(px1, OUT.width, mcx, mcy)}`);
    assert.ok(pixelMatches(pixelAt(px1, OUT.width, scx, scy), bgraA, 4),
      `stack tile shows A after move; got ${pixelAt(px1, OUT.width, scx, scy)}`);

    // Show workspace 2 (B). Now workspace 2 has only B: B spans the full
    // tile region; A is gone from this output.
    await c.runtime.invokeAction("workspace.show", { index: 2 });
    const px2 = await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(p, OUT.width, scx, scy), bgraB, 4));
    assert.ok(pixelMatches(pixelAt(px2, OUT.width, mcx, mcy), bgraB, 4),
      `master tile shows B on workspace 2; got ${pixelAt(px2, OUT.width, mcx, mcy)}`);
    assert.ok(pixelMatches(pixelAt(px2, OUT.width, scx, scy), bgraB, 4),
      `stack tile shows B on workspace 2; got ${pixelAt(px2, OUT.width, scx, scy)}`);

    const cur = await c.runtime.invokeAction("workspace.current", { outputId: 0 });
    assert.equal(cur.index, 2);
  } finally {
    await c.teardown();
  }
});
