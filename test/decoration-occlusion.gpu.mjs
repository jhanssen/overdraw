// End-to-end GPU: per-window decoration z-binding (BUG 3 fix). Two cascading,
// overlapping windows A (mapped first, lower z) and B (mapped second, on top) are
// both decorated with a solid-blue top titlebar. Decorations must be z-bound to
// their own window (decoA below A's content, decoB below B's content) so the
// unified draw order is decoA, A, decoB, B.
//
// The decisive point is inside the TOP window B's titlebar band where it overlaps
// the LOWER window A's content:
//   - flat `below` layer (the old bug: decoA, decoB, A, B): A's content (red) draws
//     OVER decoB, so the spot is RED -- B's own titlebar is hidden behind a lower
//     window's content.
//   - per-window interleave (decoA, A, decoB, B): decoB (blue) draws over A's
//     content, so the spot is BLUE -- B's titlebar shows, correctly above A.
//
// Geometry is read from query() (robust to placement); the test only requires that
// B's titlebar band overlaps A's content (asserted explicitly before sampling).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu, loadDawn, waitFor, pixelAt } from "./harness.mjs";
import { createCompositorBus } from "../dist/events/window-bus.js";
import { PluginRuntime } from "../dist/plugins/index.js";
import { createGpuBroker } from "../dist/plugins/gpu-broker.js";
import { createDecorationBroker } from "../dist/plugins/decoration-broker.js";
import { createOverlayBroker } from "../dist/overlay.js";
import { WINDOW_EVENT } from "../dist/events/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OD = join(__dirname, "..");
const skip = !canRunGpu() ? "no host Wayland" : !loadDawn() ? "dawn.node not built" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Large enough that the cascade (80px/window) does not wrap: filler at (0,0),
// A at (80,80), B at (160,160) -- B's titlebar band overlaps A's content.
const W = 512, H = 512;
const TITLEBAR = 24;   // matches the decoration-surface fixture's top inset

test("cascading windows: each decoration is z-bound below its own window", { skip }, async () => {
  const bus = createCompositorBus();
  const c = await setupCompositor({ bus, headless: { width: W, height: H } });

  let runtime = null;
  bus.on(WINDOW_EVENT.map, (ev) => runtime?.broadcast(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.change, (ev) => runtime?.broadcast(WINDOW_EVENT.change, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => runtime?.broadcast(WINDOW_EVENT.unmap, ev));

  const dawn = loadDawn();
  const h = c.addon.gpuHandles();
  const overlays = createOverlayBroker(c.state, { width: W, height: H });
  const decoBroker = createDecorationBroker({
    bus, state: c.state, emitToPlugin: (p, n, d) => { runtime?.emit(p, n, d); },
  });
  const gpuBroker = createGpuBroker({
    addon: c.addon, compositor: c.jsCompositor, overlays, dawn, coreDeviceHandle: h.device,
    onSurfaceAllocated: (sid, win) => decoBroker.onSurfaceAllocated(sid, win),
    onSurfacePresented: (sid) => decoBroker.onSurfacePresented(sid),
  });
  const [dawnNodePath] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));

  const logs = [];
  runtime = new PluginRuntime({
    pluginAddonPath: join(OD, "build", "overdraw_plugin_native.node"),
    dawnPath: dawnNodePath,
    pingIntervalMs: 500, maxMissedPongs: 10, shutdownTimeoutMs: 800, heapMb: 128,
    log: () => {},
    onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
    onRequest: (p, method, params) =>
      method.startsWith("decoration.") ? decoBroker.onRequest(p, method, params) : gpuBroker(p, method, params),
  });

  try {
    await runtime.load([{
      module: pathToFileURL(join(__dirname, "fixtures", "plugins", "decoration-surface.mjs")).href,
      name: "deco", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {},
    }]);
    await waitForLog(logs, (l) => l === "registered");

    // Filler (non-matching) at (0,0) so the decorated windows cascade down-right
    // with their titlebar bands on-screen.
    const filler = c.spawnClient(["--app-id", "filler", "--size", "50x50"]);
    await filler.ready;
    await waitFor(c.query, (s) => s.windows.length === 1, { what: "filler mapped" });

    // Window A (lower z) maps first, content solid red. Cascades to (80,80).
    const aClient = c.spawnClient(["--app-id", "org.test.deco", "--size", "240x160", "--color", "FFFF0000"]);
    await aClient.ready;
    await waitFor(c.query, (s) => s.windows.length === 2, { what: "A mapped" });
    await waitForLog(logs, (l) => l.startsWith("decorated "), 6000);
    const aWin = c.query().windows.find((w) => w.appId === "org.test.deco");
    assert.ok(aWin, "A in query");
    await waitFor(() => ({ g: c.state.wm.isContentGated(aWin.surfaceId) }),
      (s) => s.g === false, { what: "A gate release" });

    // Window B (on top) maps second, content solid GREEN to distinguish it from A's
    // red. Cascades to (160,160).
    const bClient = c.spawnClient(["--app-id", "org.test.deco", "--size", "240x160", "--color", "FF00FF00"]);
    await bClient.ready;
    await waitFor(c.query, (s) => s.windows.length === 3, { what: "B mapped" });
    const bWin = c.query().windows.find((w) => w.appId === "org.test.deco" && w.surfaceId !== aWin.surfaceId);
    assert.ok(bWin, "B in query");
    await waitFor(() => ({ g: c.state.wm.isContentGated(bWin.surfaceId) }),
      (s) => s.g === false, { what: "B gate release" });

    const a = aWin.rect, b = bWin.rect;   // B mapped later -> top of the WM stack.

    // B's titlebar band: y in [b.y - TITLEBAR, b.y), x in [b.x, b.x + b.width).
    // Require it to overlap A's content (else the test point is meaningless).
    const bandTop = b.y - TITLEBAR, bandBot = b.y;
    const ox0 = Math.max(a.x, b.x), ox1 = Math.min(a.x + a.width, b.x + b.width);
    const oy0 = Math.max(a.y, bandTop), oy1 = Math.min(a.y + a.height, bandBot);
    assert.ok(ox1 - ox0 > 8 && oy1 - oy0 > 4,
      `B's titlebar band must overlap A's content for the test to be meaningful; `
      + `A=${JSON.stringify(a)} B=${JSON.stringify(b)} band=[${bandTop},${bandBot}) overlap x[${ox0},${ox1}) y[${oy0},${oy1})`);
    assert.ok(bandTop >= 0, `B's titlebar band must be on-screen (bandTop=${bandTop})`);

    c.jsCompositor.renderFrame();
    const data = await c.frameReadback();

    // DECISIVE point: middle of (B's titlebar band ∩ A's content). Must be BLUE
    // (decoB above A's content), not RED (A's content over decoB -- the old bug).
    const px = Math.floor((ox0 + ox1) / 2), py = Math.floor((oy0 + oy1) / 2);
    const decisive = pixelAt(data, W, px, py);
    assert.ok(decisive[0] > 150 && decisive[2] < 80,
      `B's titlebar not visible over the lower window A's content at (${px},${py}); `
      + `expected blue (decoB above A), got ${decisive} `
      + `(red => A's content drew over decoB: the flat-layer occlusion bug)`);

    // Sanity: A's own titlebar is visible where B does NOT cover it. A's titlebar
    // band y[a.y-TITLEBAR, a.y); pick an x to the LEFT of B (x < b.x).
    const ax = Math.floor((a.x + Math.min(a.x + a.width, b.x)) / 2);
    const ay = Math.floor(a.y - TITLEBAR / 2);
    assert.ok(ax < b.x && ay >= 0, `A titlebar sample must be left of B and on-screen (ax=${ax}, ay=${ay}, b.x=${b.x})`);
    const aDeco = pixelAt(data, W, ax, ay);
    assert.ok(aDeco[0] > 150 && aDeco[2] < 80,
      `A's own titlebar not visible at (${ax},${ay}): got ${aDeco}`);

    // Sanity: B's titlebar where it overlaps NOTHING below (x to the right of A).
    // Only assert if such a region is on-screen.
    const rx = Math.floor((Math.max(a.x + a.width, b.x) + b.x + b.width) / 2);
    if (rx > a.x + a.width && rx < W && bandTop >= 0) {
      const bDeco = pixelAt(data, W, rx, Math.floor((bandTop + bandBot) / 2));
      assert.ok(bDeco[0] > 150 && bDeco[2] < 80,
        `B's titlebar not visible (no overlap) at (${rx}): got ${bDeco}`);
    }
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
