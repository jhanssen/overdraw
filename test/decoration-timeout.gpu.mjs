// End-to-end GPU: a decoration provider that registers but NEVER draws. The core's
// first-frame timeout must fire -> deregister the provider, release the gated
// content (the window appears UNDECORATED rather than hanging invisible), and
// notify the plugin (decoration.deregistered). Piece 3 safety path: a broken
// provider can never make a window permanently invisible.

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu, loadDawn, waitFor, pixelAt } from "./harness.mjs";
import { createCompositorBus } from "../packages/core/dist/events/window-bus.js";
import { DynamicBus } from "../packages/core/dist/events/dynamic-bus.js";
import { PluginRuntime } from "../packages/core/dist/plugins/index.js";
import { createGpuBroker } from "../packages/core/dist/plugins/gpu-broker.js";
import { createDecorationBroker } from "../packages/core/dist/plugins/decoration-broker.js";
import { createOverlayBroker } from "../packages/core/dist/overlay.js";
import { WINDOW_EVENT } from "../packages/core/dist/events/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..", "packages", "core");
const skip = !canRunGpu() ? "needs GPU (no render node / dawn.node)" : !loadDawn() ? "dawn.node not built" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 256, H = 256;

test("broken decoration provider times out: content shown undecorated + deregistered", { skip }, async () => {
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  // Pass pluginBus to the harness so the WM's window.relayout reaches the
  // decoration registry's notifyRelayout (wired below). Without this the
  // broker leaves the assignment in its pending map (window.map fires with
  // the WM placeholder rect, layout-driver is async).
  const c = await setupCompositor({ bus, pluginBus, headless: { width: W, height: H } });

  let runtime = null;
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.change, (ev) => pluginBus.emit(WINDOW_EVENT.change, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  const dawn = loadDawn();
  const h = c.addon.gpuHandles();
  const overlays = createOverlayBroker(c.state, { width: W, height: H });
  // Short timeout so the test is fast (default 500ms).
  const decoBroker = createDecorationBroker({
    bus, state: c.state, timeoutMs: 150,
    emitToPlugin: (p, n, d) => { runtime?.emit(p, n, d); },
  });
  // window.relayout -> decoration registry (mirrors main.ts).
  pluginBus.subscribe(WINDOW_EVENT.relayout, (_n, payload) => {
    const ev = payload;
    if (!ev || typeof ev.surfaceId !== "number") return;
    const r = ev.newOuter;
    if (!r || typeof r.x !== "number" || typeof r.y !== "number"
        || typeof r.width !== "number" || typeof r.height !== "number") return;
    decoBroker.registry.notifyRelayout(ev.surfaceId,
      { x: r.x, y: r.y, width: r.width, height: r.height });
  });
  const gpuBroker = createGpuBroker({
    addon: c.addon, compositor: c.jsCompositor, overlays, dawn, coreDeviceHandle: h.device,
    onSurfaceAllocated: (sid, win) => decoBroker.onSurfaceAllocated(sid, win),
    onSurfacePresented: (sid) => decoBroker.onSurfacePresented(sid),
  });
  const [dawnNodePath] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));

  const logs = [];
  runtime = new PluginRuntime({
    liveOutputIds: () => [0],
    pluginAddonPath: join(OD, "build", "overdraw_plugin_native.node"),
    dawnPath: dawnNodePath,
    pingIntervalMs: 500, maxMissedPongs: 10, shutdownTimeoutMs: 800, heapMb: 128,
    log: () => {},
    bus: pluginBus,
    onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
    onRequest: (p, method, params) =>
      method.startsWith("decoration.") ? decoBroker.onRequest(p, method, params) : gpuBroker.onRequest(p, method, params),
  });

  try {
    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "decoration-never-draws.mjs")).href,
      name: "broken", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);
    await waitForLog(logs, (l) => l === "registered");

    // Cascade a filler first so the decorated window is on-screen, then the matching
    // (broken-decorated) window with solid red content.
    const filler = c.spawnClient(["--app-id", "filler", "--size", "50x50"]);
    await filler.ready;
    await waitFor(c.query, (s) => s.windows.length === 1);
    const client = c.spawnClient(["--app-id", "org.test.broken", "--size", "200x100", "--color", "FFFF0000"]);
    await client.ready;
    await waitFor(c.query, (s) => s.windows.length === 2);

    // The provider is assigned but never draws -> the timeout must deregister it and
    // release the gate.
    await waitForLog(logs, (l) => l.startsWith("assigned "));
    await waitForLog(logs, (l) => l.startsWith("deregistered "), 3000);

    // Wait for the post-second-window retile to settle (filler ignores
    // configure, so the WM's resize transaction relies on the broker's
    // deadline; query() until both tiles partition the output).
    await waitFor(c.query, (s) => {
      if (s.windows.length !== 2) return false;
      const widths = s.windows.map((w) => w.rect.width).sort((a, b) => a - b);
      return widths[0] + widths[1] === W;
    }, { what: "two tiles settled", timeoutMs: 4000 });

    const win = c.query().windows.find((w) => w.appId === "org.test.broken");
    assert.ok(win, "window in query");
    // Gate released -> content composites (red), even though no decoration drew.
    assert.equal(c.state.wm.isContentGated(win.surfaceId), false, "gate released by timeout");
    c.jsCompositor.renderFrame();
    const data = await c.frameReadback();
    const cr = win.rect;
    const px = pixelAt(data, W, cr.x + 5, cr.y + 20);
    assert.ok(px[2] > 150 && px[0] < 80, `content (red) not visible after timeout: got ${px}`);
  } finally {
    if (runtime) await runtime.stop();
    await c.teardown();
  }
});

async function waitForLog(logs, pred, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (logs.some(pred)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForLog timed out; logs:\n${logs.join("\n")}`);
    await sleep(15);
  }
}
