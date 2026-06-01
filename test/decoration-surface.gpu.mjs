// End-to-end GPU: a decoration provider draws. A real client maps with a matching
// app_id; the provider is assigned, reserves a top inset, creates a surface at the
// granted outerRect, clears it blue, and presents. The test pixel-verifies the
// decoration composites in the inset band above the content. Piece 2b of the
// decoration milestone (no content gating yet -- piece 3).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu, loadDawn, waitFor, pixelAt, pixelMatches } from "./harness.mjs";
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

test("decoration surface composites at the inset rect above the window", { skip }, async () => {
  const bus = createCompositorBus();
  const c = await setupCompositor({ bus, headless: { width: W, height: H } });

  // Forward window.* to the runtime (mirrors main.ts).
  let runtime = null;
  bus.on(WINDOW_EVENT.map, (ev) => runtime?.broadcast(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.change, (ev) => runtime?.broadcast(WINDOW_EVENT.change, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => runtime?.broadcast(WINDOW_EVENT.unmap, ev));

  // Brokers against the live state/compositor (mirrors main.ts).
  const dawn = loadDawn();
  const h = c.addon.gpuHandles();
  const overlays = createOverlayBroker(c.state, { width: W, height: H });
  const gpuBroker = createGpuBroker({ addon: c.addon, compositor: c.jsCompositor, overlays, dawn, coreDeviceHandle: h.device });
  const decoBroker = createDecorationBroker({
    bus, state: c.state, emitToPlugin: (p, n, d) => { runtime?.emit(p, n, d); },
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

    // Spawn a filler client first (non-matching app_id) so the placement cascade
    // pushes the decorated window down -- otherwise it maps at y=0 and its top
    // inset band is off-screen (clipped), leaving nothing to sample.
    const filler = c.spawnClient(["--app-id", "filler", "--size", "50x50"]);
    await filler.ready;
    await waitFor(c.query, (s) => s.windows.length === 1, { what: "filler mapped" });

    // Real client maps with the matching app_id. Content is solid red (ARGB
    // 0xFFFF0000 -> opaque red); a 200x100 window. It cascades below the filler.
    const client = c.spawnClient(["--app-id", "org.test.deco", "--size", "200x100", "--color", "FFFF0000"]);
    await client.ready;
    await waitFor(c.query, (s) => s.windows.length === 2, { what: "decorated window mapped" });

    // The provider draws on assignment; wait for its "decorated" log + the rect.
    await waitForLog(logs, (l) => l.startsWith("decorated "), 6000);
    const outer = JSON.parse(logs.find((l) => l.startsWith("decorated ")).slice("decorated ".length));

    // The decorated window's content rect (from query); cascaded below the filler
    // so its top inset band (cr.y-24 .. cr.y) is on-screen.
    const win = c.query().windows.find((w) => w.appId === "org.test.deco");
    assert.ok(win, "decorated window in query");
    const cr = win.rect;
    assert.ok(cr.y >= 24, `decorated window must be cascaded down for an on-screen inset band (cr.y=${cr.y})`);
    // Render a frame and read back; assert a blue decoration pixel in the top inset
    // band (above the content), and the content (red) below it.
    c.jsCompositor.renderFrame();
    const data = await c.frameReadback();

    // A point inside the decoration's top inset band: same x as content, y just
    // above the content top (outer.y .. cr.y).
    const dx = Math.max(0, cr.x + 5);
    const dy = Math.max(0, cr.y - 12);              // within the 24px top inset
    const decoPx = pixelAt(data, W, dx, dy);        // expect blue (B high, R/G low)
    assert.ok(decoPx[0] > 150 && decoPx[2] < 80,
      `decoration pixel not blue at (${dx},${dy}): got ${decoPx}`);

    // A content point (inside the content rect): expect red (R high).
    const contentPx = pixelAt(data, W, cr.x + 5, cr.y + 20);
    assert.ok(contentPx[2] > 150 && contentPx[0] < 80,
      `content pixel not red at (${cr.x + 5},${cr.y + 20}): got ${contentPx}`);
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
