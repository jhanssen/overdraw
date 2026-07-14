// X glass-space fiction (canvas-design.md §7b, xwayland/glass-map.ts): X
// clients are told GLASS positions -- their world rect mapped through the
// chart camera of the output that shows them, pan only. A camera change
// re-narrates positions via a synthetic ConfigureNotify; identity cameras
// tell world coordinates unchanged.
//
// Needs the GPU, Xwayland, and the built x11-test-client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu, waitFor, settled, nextXDisplay } from "./harness.mjs";
import { startXwayland } from "../packages/core/dist/xwayland/index.js";
import { startXwm } from "../packages/core/dist/xwayland/xwm.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const X11_CLIENT = join(__dirname, "..", "packages", "core", "build", "x11-test-client");

function haveXwayland() {
  return (process.env.PATH ?? "").split(":").some((p) => p && existsSync(`${p}/Xwayland`));
}

const skip = !canRunGpu()
  ? "no GPU/dawn.node"
  : !haveXwayland()
    ? "Xwayland not installed"
    : !existsSync(X11_CLIENT)
      ? "x11-test-client not built"
      : false;

// Apply a camera the way the windows broker does: compositor + state
// mirror + pointer repick + X re-narration.
function setCamera(c, outputId, x, y, zoom = 1) {
  c.state.outputCameras ??= new Map();
  if (x === 0 && y === 0 && zoom === 1) c.state.outputCameras.delete(outputId);
  else c.state.outputCameras.set(outputId, { x, y, zoom });
  c.state.compositor.setOutputCamera(outputId, x, y, zoom);
  c.state.seat?.repickPointer();
  c.state.xwm?.retellPositions();
}

test("xwm: camera pan re-narrates glass positions to the X client",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      let stdout = "";
      child = execFile(X11_CLIENT,
        ["--title", "camera-test", "--timeout-ms", "25000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      // The WM tiles the window to the full output: world rect (0,0,1280,720).
      await waitFor(c.query,
        (s) => s.windows.some((w) =>
          w.role === "xwayland" && w.rect.width === 1280 && w.rect.height === 720),
        { timeoutMs: 8000, what: "xwayland window tiled to full output" });

      const sawConfigure = (needle) =>
        stdout.split("\n").some((l) =>
          l.includes("[x11] configure synthetic") && l.includes(needle));
      const waitConfigure = async (needle, what) => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (sawConfigure(needle)) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.fail(`expected synthetic configure with ${what}; stdout:\n${stdout}`);
      };

      // Identity camera: told coordinates are the world rect verbatim.
      await waitConfigure("x=0 y=0 w=1280 h=720", "identity position");

      // Camera (200, 0): the window's glass position is world - camera.
      setCamera(c, 0, 200, 0);
      await waitConfigure("x=-200 y=0 w=1280 h=720", "panned glass position");

      // The XWindow record syncs from the real ConfigureNotify echo.
      const snap = c.query();
      const win = snap.windows.find((w) => w.role === "xwayland");
      await settled(
        () => c.state.xwm.findBySurfaceId(win.surfaceId)?.x,
        (x) => x === -200, { timeoutMs: 5000, what: "XWindow record echoed x=-200" });

      // Identity restore re-narrates the original position.
      setCamera(c, 0, 0, 0);
      await waitConfigure("x=0 y=0 w=1280 h=720", "restored identity position");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
