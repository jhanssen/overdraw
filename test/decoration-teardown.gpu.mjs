// Decoration surface teardown: when a decorated window unmaps, the decoration
// surface must (a) stop compositing (its region clears -- no lingering decoration
// where the window was) and (b) free the ring's GPU resources (3 dmabufs + STM on
// both devices) so the GPU process does not leak fds. Exercises the full
// surface.destroy path (worker -> gpu-broker -> ReleaseSurfaceBuf -> GPU process).

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { globSync } from "node:fs";

import { setupCompositor, canRunGpu, loadDawn, waitFor, pixelAt, gpuPids, fdCount } from "./harness.mjs";
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

test("decorated window unmap: decoration stops compositing + frees GPU resources", { skip }, async () => {
  const bus = createCompositorBus();
  const pluginBus = new DynamicBus();
  const c = await setupCompositor({ bus, headless: { width: W, height: H } });
  let runtime = null;
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

    const pid = gpuPids()[0];
    // Single decorated client: under master-stack tiling it fills the output
    // (the previous version used a filler client to push it down, but the
    // animated-gradient plugin decorates the filler too -- whose decoration
    // would then move to cover the decorated client's region after unmap,
    // since the resize plumbing repositions the filler's decoration; using
    // ONE client makes the "decoration cleared on unmap" assertion clean).
    const client = c.spawnClient(["--app-id", "org.test.app", "--size", "200x100", "--color", "FFFF0000"]);
    await client.ready; await waitFor(c.query, (s) => s.windows.length === 1);
    const win = c.query().windows.find((w) => w.appId === "org.test.app");
    const cr = win.rect;
    await waitFor(() => ({ g: c.state.wm.isContentGated(win.surfaceId) }), (s) => s.g === false, { what: "gate release" });

    const bandX = cr.x + 5, bandY = Math.max(0, cr.y - 12);
    c.jsCompositor.renderFrame();
    const before = pixelAt(await c.frameReadback(), W, bandX, bandY);
    assert.ok(before[0] + before[1] + before[2] > 30, `decoration not drawn before unmap: ${before}`);

    // Baseline fd count WITH the decoration ring up + animating, sampled at a
    // QUIESCENT point (stop driving frames, let in-flight GPU fences drain). The
    // renderer/driver keep a steady-state working set of sync_file fds in flight; to
    // detect a *teardown* leak we must compare like-for-like (quiescent vs quiescent),
    // not a pre-decoration count vs a mid-animation count.
    await sleep(800);
    const fdBefore = fdCount(pid);

    // Kill the decorated client -> window unmaps -> the plugin destroys its
    // decoration surface. No more windows after this.
    client.child.kill("SIGTERM");
    await waitFor(c.query, (s) => s.windows.length === 0, { what: "decorated window unmapped" });
    // Give the destroy + afterCurrentFrame teardown + GPU release a few frames.
    for (let i = 0; i < 10; i++) { c.jsCompositor.renderFrame(); await sleep(20); }

    // (a) The decoration region is no longer composited (black where the window was).
    c.jsCompositor.renderFrame();
    const after = pixelAt(await c.frameReadback(), W, bandX, bandY);
    assert.deepEqual(after, [0, 0, 0, 255], `decoration still composited after unmap: ${after}`);

    // (b) The decoration ring's GPU fds (dmabufs + imported sync-fences) are freed:
    // quiesce again, then the fd count must return to the quiescent baseline (the
    // ring added ~3 dmabufs + its fences; a leak would leave them open). Sampled
    // quiescent to exclude the renderer's in-flight working set.
    await sleep(1000);
    const fdAfter = fdCount(pid);
    assert.ok(fdAfter <= fdBefore + 1,
      `GPU-process fds leaked after decoration teardown: before=${fdBefore} after=${fdAfter}`);
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
