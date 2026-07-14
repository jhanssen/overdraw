// GPU integration: the canvas plugin selected via the `canvas` config slice,
// driven through the exact flow the workspace plugin's GPU test uses --
// mapped windows join workspace 1, move-window + show-at-index isolate a
// workspace's clients (pixel-verified). Parity means these assertions are
// the same ones plugin-workspace-default passes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { setupCompositor, canRunGpu, pixelAt, pixelMatches, settled } from "../harness.mjs";

const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 1280, height: 720 };
const FILL = "--fill-configured";

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

test("canvas parity: move-window + show isolates a workspace's clients (pixel)", { skip }, async () => {
  const logs = [];
  const c = await setupCompositor({
    headless: OUT,
    config: { canvas: {} },
    log: (...args) => logs.push(args.join(" ")),
  });
  try {
    // The canvas plugin (not workspace-default) owns the namespace.
    assert.ok(logs.some((l) => l.includes("[plugin canvas] live")),
      `expected the canvas plugin to load; got ${JSON.stringify(logs)}`);
    assert.ok(!logs.some((l) => l.includes("[plugin workspace-default]")),
      "workspace-default must not load when the canvas slice is set");

    const cA = 0xff3030c0;
    const cB = 0xff30c030;
    const bgraA = argbToBgra(cA);
    const bgraB = argbToBgra(cB);

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

    const snap2 = c.query();
    const master = snap2.windows[0]; // B (last-mapped = master)
    const stack = snap2.windows[1];  // A
    const mcx = master.rect.x + (master.rect.width >> 1);
    const mcy = master.rect.y + (master.rect.height >> 1);
    const scx = stack.rect.x + (stack.rect.width >> 1);
    const scy = stack.rect.y + (stack.rect.height >> 1);

    // Baseline: both tiles composited.
    await readUntil(c, (px) =>
      pixelMatches(pixelAt(px, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(px, OUT.width, scx, scy), bgraA, 4));

    // Move B to a fresh workspace 2; workspace 1 retiles to A alone.
    await c.runtime.invokeAction("workspace.create", {});
    await c.runtime.invokeAction("workspace.move-window",
      { surfaceId: master.surfaceId, index: 2 });
    await c.runtime.flush();
    await settled(
      () => c.runtime.invokeAction("workspace.list", { outputId: 0 }),
      (l) => l.length === 2 && l[0].members.length === 1 && l[1].members.length === 1,
      { what: "B moved to workspace 2" });

    const px1 = await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, mcx, mcy), bgraA, 4)
      && pixelMatches(pixelAt(p, OUT.width, scx, scy), bgraA, 4));
    assert.ok(pixelMatches(pixelAt(px1, OUT.width, mcx, mcy), bgraA, 4),
      `master tile shows A after move; got ${pixelAt(px1, OUT.width, mcx, mcy)}`);

    // Show workspace 2: only B composites.
    await c.runtime.invokeAction("workspace.show-at-index", { index: 2 });
    const px2 = await readUntil(c, (p) =>
      pixelMatches(pixelAt(p, OUT.width, mcx, mcy), bgraB, 4)
      && pixelMatches(pixelAt(p, OUT.width, scx, scy), bgraB, 4));
    assert.ok(pixelMatches(pixelAt(px2, OUT.width, scx, scy), bgraB, 4),
      `stack tile shows B on workspace 2; got ${pixelAt(px2, OUT.width, scx, scy)}`);

    const cur = await c.runtime.invokeAction("workspace.current", { outputId: 0 });
    assert.equal(cur.index, 2);
  } finally {
    await c.teardown();
  }
});
