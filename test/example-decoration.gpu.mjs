// Validates the shipped example examples/decorations/animated-gradient.mjs end to
// end: a real client maps, the example decorates it, the content gate releases on
// the decoration's first frame, and the animated gradient titlebar composites AND
// changes across frames (the shader animates). Also exercises the SAB slot-state
// ring under continuous (per-frame) presents -- the path that the blind round-robin
// ring corrupted before the SlotStates rework.

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
const REPO = join(__dirname, "..");
const OD = join(REPO, "packages", "core");
const skip = !canRunGpu() ? "no host Wayland" : !loadDawn() ? "dawn.node not built" : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 256, H = 256;

test("example animated-gradient decoration composites + animates", { skip }, async () => {
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const c = await setupCompositor({ bus, headless: { width: W, height: H } });
  let runtime = null;
  // Republish core window.* events onto the plugin bus, where the runtime
  // delivers them to subscribed plugins.
  bus.on(WINDOW_EVENT.map, (ev) => pluginBus.emit(WINDOW_EVENT.map, ev));
  bus.on(WINDOW_EVENT.change, (ev) => pluginBus.emit(WINDOW_EVENT.change, ev));
  bus.on(WINDOW_EVENT.unmap, (ev) => pluginBus.emit(WINDOW_EVENT.unmap, ev));

  const dawn = loadDawn();
  const h = c.addon.gpuHandles();
  const overlays = createOverlayBroker(c.state, { width: W, height: H });
  const decoBroker = createDecorationBroker({ bus, state: c.state, emitToPlugin: (p, n, d) => runtime?.emit(p, n, d) });
  const gpuBroker = createGpuBroker({
    addon: c.addon, compositor: c.jsCompositor, overlays, dawn, coreDeviceHandle: h.device,
    onSurfaceAllocated: (sid, win) => decoBroker.onSurfaceAllocated(sid, win),
    onSurfacePresented: (sid) => decoBroker.onSurfacePresented(sid),
  });
  const [dawnNodePath] = globSync(join(OD, "build", "3rdparty", "dawn", "Dawn-*", "dawn.node"));
  const logs = [];
  runtime = new PluginRuntime({
    pluginAddonPath: join(OD, "build", "overdraw_plugin_native.node"), dawnPath: dawnNodePath,
    pingIntervalMs: 500, maxMissedPongs: 10, shutdownTimeoutMs: 800, heapMb: 128, log: () => {},
    bus: pluginBus,
    onEvent: (_p, name, data) => { if (name === "log") logs.push(String(data)); },
    onRequest: (p, m, params) => m.startsWith("decoration.") ? decoBroker.onRequest(p, m, params) : gpuBroker(p, m, params),
  });

  try {
    await runtime.load([{ module: pathToFileURL(join(REPO, "examples", "decorations", "animated-gradient.mjs")).href,
      name: "deco", restart: "never", maxRestarts: 0, windowSeconds: 60, raw: {} }]);
    await waitForLog(logs, (l) => l.includes("registered"));

    // Filler first (cascade the decorated window down so its titlebar is on-screen).
    const filler = c.spawnClient(["--app-id", "filler", "--size", "50x50"]);
    await filler.ready; await waitFor(c.query, (s) => s.windows.length === 1);
    const client = c.spawnClient(["--app-id", "org.test.app", "--size", "200x100", "--color", "FFFF0000"]);
    await client.ready; await waitFor(c.query, (s) => s.windows.length === 2);

    const win = c.query().windows.find((w) => w.appId === "org.test.app");
    const cr = win.rect;
    // Atomic appearance: content held until the decoration's first frame.
    await waitFor(() => ({ g: c.state.wm.isContentGated(win.surfaceId) }),
      (s) => s.g === false, { what: "gate release" });

    const sx = cr.x + 5, sy = Math.max(0, cr.y - 12);   // in the titlebar band
    c.jsCompositor.renderFrame();
    const f1 = pixelAt(await c.frameReadback(), W, sx, sy);
    await sleep(250);   // let the gradient/sweep advance
    c.jsCompositor.renderFrame();
    const f2 = pixelAt(await c.frameReadback(), W, sx, sy);

    assert.ok(f1[0] + f1[1] + f1[2] > 30, `titlebar not drawn: ${f1}`);
    const delta = Math.abs(f1[0]-f2[0]) + Math.abs(f1[1]-f2[1]) + Math.abs(f1[2]-f2[2]);
    assert.ok(delta > 8, `titlebar did not animate: ${f1} -> ${f2} (delta ${delta})`);
  } finally {
    if (runtime) await runtime.stop();
    await c.teardown();
  }
});

async function waitForLog(logs, pred, timeoutMs = 4000) {
  const t0 = Date.now();
  for (;;) {
    if (logs.some(pred)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitForLog timed out:\n${logs.join("\n")}`);
    await sleep(15);
  }
}
