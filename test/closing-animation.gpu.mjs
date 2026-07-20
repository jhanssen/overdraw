// Phase 9a GPU integration: end-to-end closing animation.
//
// Three tests:
//
//   1. Baseline (no plugin): a client closes; the window vanishes
//      immediately. No phantom, no window.closing emit.
//
//   2. With plugin: a fixture plugin claims the 'window-closing'
//      namespace and runs an opacity tween on the phantom on every
//      window.closing event. After a client closes, pixel readback
//      shows the phantom present briefly (with intermediate opacity
//      values), then absent after the animation completes.
//
//   3. Backstop: same plugin but configured to NOT call
//      destroyPhantom. After the backstop timeout fires, the
//      compositor destroys the phantom on its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  setupCompositor, canRunGpu, pixelAt, pixelMatches, settled,
} from "./harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skip = canRunGpu() ? false : "needs GPU (no render node / dawn.node)";
const OUT = { width: 320, height: 240 };
const FILL = "--fill-configured";

function argbToBgra(argb) {
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  const a = (argb >>> 24) & 0xff;
  return [b, g, r, a];
}
const BLACK = [0, 0, 0, 255];

test("closing-animation: baseline -- no plugin, instant unmap (no phantom)",
  { skip }, async () => {
  // closingAnimations: false (the default) -- no closing driver wired,
  // unmap is instant.
  const c = await setupCompositor({ headless: OUT });
  try {
    const color = 0xffff0000;
    const bgra = argbToBgra(color);
    const a = c.spawnClient([FILL, "--color", color.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "client mapped" });

    // Wait for the client to render.
    await settled(() => c.frameReadback(),
      (px) => px && pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), bgra, 4),
      { timeoutMs: 2000, intervalMs: 16, what: "client visible" });

    // Kill the client. The compositor sees the resource sweep and
    // unmaps; with no closing driver, the window vanishes
    // immediately.
    a.child.kill("SIGTERM");
    await settled(() => c.query(), (s) => s.windows.length === 0,
      { timeoutMs: 2000, intervalMs: 16, what: "window unmapped" });

    // Pixel at where the window used to be should be black (clear
    // color, no phantom).
    const px = await c.frameReadback();
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), BLACK, 4),
      `no phantom: clear color where window was; got ${pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1)}`);

    // Compositor's phantom list is empty.
    assert.deepEqual(c.jsCompositor.activePhantomIds(), [],
      `no phantoms should be active`);
  } finally {
    await c.teardown();
  }
});

test("closing-animation: with plugin -- phantom fades out, then is destroyed",
  { skip }, async () => {
  // closingAnimations: true wires the closing driver. The fixture
  // plugin claims the namespace + animates a 400ms fade -- animations
  // broker is required for sdk.animations.run to work.
  const c = await setupCompositor({
    headless: OUT,
    closingAnimations: true,
    animations: true,
  });
  try {
    const logs = [];
    const fixture = pathToFileURL(
      join(__dirname, "fixtures", "plugins", "closing-animation.mjs")).href;
    // Load the fixture plugin AFTER setupCompositor returns. The
    // harness's runtime is already running with bundled plugins;
    // we just append this one.
    const onEventOrig = c.runtime.opts?.onEvent;
    void onEventOrig;
    await c.runtime.load([{
      module: fixture,
      name: "closing-animation",
      restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true,
      raw: { durationMs: 400, skipDestroy: false },
    }]);

    // Subscribe to plugin logs via the runtime's onEvent. We can't
    // re-pass opts.onEvent after construction, but we CAN tee via
    // pluginBus subscriptions to a 'log' emit -- the plugin emits
    // via sdk.log which goes through the endpoint.emit('log', ...).
    // Simpler: peek at the bus for our marker events instead.
    let phantomId = null;
    let closingPayload = null;
    c.pluginBus.subscribe("window.closing", (_name, payload) => {
      phantomId = payload.phantomSurfaceId;
      closingPayload = payload;
      logs.push(`closing: phantom=${phantomId}`);
    });

    const color = 0xff0000ff;  // blue
    const bgra = argbToBgra(color);
    const a = c.spawnClient([FILL, "--color", color.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "client mapped" });

    // Wait for the client to render.
    await settled(() => c.frameReadback(),
      (px) => px && pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), bgra, 4),
      { timeoutMs: 2000, intervalMs: 16, what: "client visible" });

    // Kill the client.
    a.child.kill("SIGTERM");
    // Wait for window.closing.
    await settled(() => phantomId, (id) => id !== null,
      { timeoutMs: 2000, intervalMs: 16, what: "window.closing event" });
    assert.ok(phantomId !== null, "phantom id should be set by window.closing");
    assert.ok(c.jsCompositor.activePhantomIds().includes(phantomId),
      "phantom should be in compositor's active list");

    // Output + tiling context mirrors window.opening: a plugin can pick
    // its exit animation from the payload alone.
    assert.equal(closingPayload.tiling, "managed",
      "a tiled toplevel closes with tiling 'managed'");
    assert.equal(typeof closingPayload.outputId, "number");
    assert.deepEqual(
      { w: closingPayload.outputRect.width, h: closingPayload.outputRect.height },
      { w: OUT.width, h: OUT.height },
      "outputRect is the output's shown region");
    assert.ok(closingPayload.rect.width > 0 && closingPayload.rect.height > 0,
      "rect is the closing window's outer rect");

    // While the fade animation runs (400ms), there should be a
    // moment where the phantom is partly transparent. Pixel
    // readback at midpoint should be neither full blue nor full
    // black; the blue channel should be partway down.
    const midDeadline = Date.now() + 300;
    let sawMid = false;
    while (Date.now() < midDeadline) {
      const px = await c.frameReadback();
      const center = pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1);
      // Premultiplied alpha: as opacity drops, B drops; full opacity
      // = 0xff, full transparent = 0. An in-progress value in
      // (16, 240) indicates the fade is running.
      if (center[0] > 16 && center[0] < 240) {
        sawMid = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 16));
    }
    assert.ok(sawMid, "should observe a partially-faded phantom during the animation");

    // After the animation finishes + the plugin calls destroyPhantom,
    // the phantom should be gone.
    await settled(() => c.jsCompositor.activePhantomIds(),
      (ids) => !ids.includes(phantomId),
      { timeoutMs: 2000, intervalMs: 16, what: "phantom destroyed" });

    // Pixel where the window was should be clear color.
    const px = await c.frameReadback();
    assert.ok(pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), BLACK, 4),
      `after phantom destroyed: clear color; got ${pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1)}`);
  } finally {
    await c.teardown();
  }
});

test("closing-animation: backstop fires when plugin doesn't call destroyPhantom",
  { skip }, async () => {
  // Short backstop for the test (default is 10s; cap to 500ms here).
  const c = await setupCompositor({
    headless: OUT,
    closingAnimations: true,
    closingBackstopMs: 500,
    animations: true,
  });
  try {
    const fixture = pathToFileURL(
      join(__dirname, "fixtures", "plugins", "closing-animation.mjs")).href;
    // skipDestroy: true -- plugin animates but does NOT destroy. The
    // backstop must fire.
    await c.runtime.load([{
      module: fixture,
      name: "closing-animation",
      restart: "never", maxRestarts: 0, windowSeconds: 60,
      bundled: true,
      raw: { durationMs: 100, skipDestroy: true },
    }]);

    let phantomId = null;
    c.pluginBus.subscribe("window.closing", (_name, payload) => {
      phantomId = payload.phantomSurfaceId;
    });

    const color = 0xff00ff00;
    const bgra = argbToBgra(color);
    const a = c.spawnClient([FILL, "--color", color.toString(16)]);
    await a.ready;
    await c.waitFor(c.query, (s) => s.windows.length === 1, { what: "client mapped" });
    // Wait for the client's first frame so s.mapped = true is set
    // (the per-frame imported-surfaces sweep sets it after content
    // is committed). Without this, the kill happens before mapped
    // is true and the closing driver skips the snapshot.
    await settled(() => c.frameReadback(),
      (px) => px && pixelMatches(pixelAt(px, OUT.width, OUT.width >> 1, OUT.height >> 1), bgra, 4),
      { timeoutMs: 2000, intervalMs: 16, what: "client visible" });
    // Kill the client.
    a.child.kill("SIGTERM");
    await settled(() => phantomId, (id) => id !== null,
      { timeoutMs: 2000, intervalMs: 16, what: "window.closing event" });
    assert.ok(c.jsCompositor.activePhantomIds().includes(phantomId),
      "phantom should be active right after window.closing");

    // Wait for the backstop to fire (500ms cap + a bit of slack).
    await settled(() => c.jsCompositor.activePhantomIds(),
      (ids) => !ids.includes(phantomId),
      { timeoutMs: 3000, intervalMs: 50, what: "backstop destroyed phantom" });

    // Phantom is gone after backstop.
    assert.ok(!c.jsCompositor.activePhantomIds().includes(phantomId),
      `phantom should be gone after backstop`);
  } finally {
    await c.teardown();
  }
});
