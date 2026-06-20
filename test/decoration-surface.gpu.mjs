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

test("decoration surface composites at the inset rect above the window", { skip }, async () => {
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  // Pass our pluginBus to the harness so the WM's window.relayout emits land
  // on it -- the decoration registry's notifyRelayout (below) listens here to
  // promote a "pending" tentative match into a real assignment when the WM
  // finally publishes a valid outer rect. Without this, the broker's pending
  // map traps the assignment forever (window.map fires with the WM's
  // placeholder rect since the layout-driver schedule is async).
  const c = await setupCompositor({ bus, pluginBus, headless: { width: W, height: H } });

  // Forward window.* to the runtime (mirrors main.ts).
  let runtime = null;
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.change, (ev) => pluginBus.emit(WINDOW_EVENT.change, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  // Brokers against the live state/compositor (mirrors main.ts).
  const dawn = loadDawn();
  const h = c.addon.gpuHandles();
  const overlays = createOverlayBroker(c.state, { width: W, height: H });
  const decoBroker = createDecorationBroker({
    bus, state: c.state, emitToPlugin: (p, n, d) => { runtime?.emit(p, n, d); },
  });
  // Wire window.relayout -> decorationRegistry.notifyRelayout (mirrors main.ts).
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
    // After the decorated window maps the WM retiles both windows to the
    // master-stack split (master = left half, stack = right half). The filler
    // ignores configure, so its resize transaction relies on the broker's
    // 150ms deadline to force-apply -- poll query() until both rects are
    // non-overlapping and partition the output before sampling pixels.
    await waitFor(c.query, (s) => {
      if (s.windows.length !== 2) return false;
      const widths = s.windows.map((w) => w.rect.width).sort((a, b) => a - b);
      return widths[0] + widths[1] === W;
    }, { what: "two non-overlapping tiles", timeoutMs: 4000 });

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

    // A content point (inside the content rect): expect red (R high). That the
    // content composites at all confirms the gate RELEASED after the decoration's
    // first present (piece 3) -- a gated window is held out of the draw stack.
    const contentPx = pixelAt(data, W, cr.x + 5, cr.y + 20);
    assert.ok(contentPx[2] > 150 && contentPx[0] < 80,
      `content pixel not red at (${cr.x + 5},${cr.y + 20}): got ${contentPx}`);
    assert.equal(c.state.wm.isContentGated(win.surfaceId), false,
      "content gate released after the decoration's first present");
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
