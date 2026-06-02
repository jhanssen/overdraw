// Two-window decoration GPU test (deliverable B from
// docs/wire-ordering-abstraction.md). Master-stack tiling; map two windows with
// the same decorated app_id; the second mapping SHRINKS window 1's tile, so
// window 1's decoration must be redrawn at the new size. The bug being fixed:
// recycled producer-texture wire handle ids cause the second window's content
// to be overpainted by a stale decoration (the second window shows only the
// blue decoration bar).
//
// Verifies: BOTH windows show their own content (red) at the center of their
// content rect; neither center pixel is decoration-blue. The harness clients
// run with --fill-configured so they fill the compositor-assigned tile (the
// tiling WM owns geometry).

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

const W = 256, H = 256;
const LAYOUT = { masterFraction: 0.5, gap: 0 };

test("two tiled decorated windows both show their own content after retile",
     { skip }, async () => {
  const bus = createCompositorBus();
  const c = await setupCompositor({ bus, headless: { width: W, height: H }, layout: LAYOUT });

  // Forward window.* to the runtime so the decoration broker sees them.
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
  // Wire the WM's decoration-resize indirection so an outer-tile change emits
  // decoration.resized to the owning plugin (mirrors src/main.ts).
  c.state.decorationResize = (windowId, outerRect, contentRect, insets) =>
    decoBroker.onDecorationResized(windowId, outerRect, contentRect, insets);
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

    // Window 1: matches the decorated app_id; fills its assigned tile via
    // --fill-configured so the WM's reflow-on-window-2-map actually moves
    // pixels (the client adopts the new content size).
    const c1 = c.spawnClient(["--app-id", "org.test.deco", "--title", "w1",
                              "--fill-configured", "--color", "FFFF0000"]);
    await c1.ready;
    await waitFor(c.query, (s) => s.windows.length === 1, { what: "w1 mapped" });
    await waitForLog(logs, (l) => l.startsWith("decorated "), 6000);

    // Window 2: same decorated app_id. Mapping it makes the WM become a 2-tile
    // master-stack: window 2 becomes the master (front, left half), window 1
    // becomes the stack (right half). Window 1's tile SHRANK -> its decoration
    // must be redrawn at the new size.
    logs.length = 0;
    const c2 = c.spawnClient(["--app-id", "org.test.deco", "--title", "w2",
                              "--fill-configured", "--color", "FFFF0000"]);
    await c2.ready;
    await waitFor(c.query, (s) => s.windows.length === 2, { what: "w2 mapped" });
    // Wait for w2's decoration first present and for w1's redraw.
    await waitForLog(logs, (l) => l.startsWith("decorated "), 6000);
    // Give the resize redraw a moment to complete (frame timer paces it).
    await sleep(150);

    c.jsCompositor.renderFrame();
    const data = await c.frameReadback();

    // Both windows are query-visible; sample their CONTENT centers.
    const snap = c.query();
    const wins = snap.windows.filter((w) => w.appId === "org.test.deco");
    assert.equal(wins.length, 2, "two decorated windows in query");
    for (const w of wins) {
      const r = w.rect;  // CONTENT rect (the WM shrinks the outer by insets)
      const cx = r.x + Math.floor(r.width / 2);
      const cy = r.y + Math.floor(r.height / 2);
      const px = pixelAt(data, W, cx, cy);
      // Client color is ARGB 0xFFFF0000 -> stored as BGRA (0,0,0xFF,0xFF):
      // red is HIGH in the R channel; decoration color is blue (B high).
      assert.ok(px[2] > 150 && px[0] < 80,
        `window '${w.title}' content center (${cx},${cy}) must be red, got [B,G,R,A]=${px}`);
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
