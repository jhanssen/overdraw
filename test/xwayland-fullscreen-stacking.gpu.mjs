// A fullscreen X window must draw ABOVE the island peers it overlaps.
//
// Regression shape: tiled windows share one z, and z-ties resolve by WM
// list order -- which is master-front, so the NEWEST window drew at the
// BOTTOM. Non-overlapping tiles never exposed this; the exclusive
// (fullscreen) lane does: the fullscreen window overlaps its suppressed
// peers at full-output size, and input (windowAt, descending-z with the
// OPPOSITE tie direction) kept targeting the fullscreen window -- clicks
// landed on a window drawn underneath another. effectiveStackZ lifts
// exclusive windows above every tier for BOTH draw and hit-test, and an
// exclusive transition re-pushes the stack.
//
// Scenario: a wayland client (green) maps first, then an X client declares
// EWMH fullscreen pre-map (how games do it) and fills red. The readback
// must be red everywhere the output shows content.
//
// Needs the GPU, Xwayland, and the built x11-test-client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu, waitFor, nextXDisplay } from "./harness.mjs";
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

test("xwm: EWMH-fullscreen X window draws above an earlier-mapped peer",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      // Peer maps FIRST (list order is what broke the z-tie).
      const green = c.spawnClient(
        ["--title", "term", "--app-id", "term", "--color", "FF00FF00", "--size", "400x300"]);
      await green.ready;
      await waitFor(c.query, (s) => s.windows.length >= 1 && s.windows[0].mapped,
        { timeoutMs: 8000, what: "peer mapped" });

      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);
      child = execFile(X11_CLIENT,
        ["--title", "fs-game", "--app-id", "fs.game", "--fullscreen",
         "--fill", "ff0000", "--timeout-ms", "30000"],
        { env: { ...process.env, DISPLAY: handle.display } });

      // Fullscreened by the WM: rect = the whole (1280x720 headless) output.
      await waitFor(c.query, (s) => s.windows.some((w) =>
        w.role === "xwayland" && w.rect.width === 1280 && w.rect.height === 720),
        { timeoutMs: 8000, what: "x window fullscreened" });

      // Composite until the fullscreen red covers both probe points. On the
      // regressed code the green peer stays permanently on top wherever the
      // two overlap, so the deadline elapses and the asserts below fail.
      const px = (d, w, x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
      const RED = [0, 0, 255, 255];  // BGRA
      let center = null, corner = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        c.jsCompositor.renderFrame();
        const { data, width, height } = await c.jsCompositor.readback();
        center = px(data, width, Math.floor(width / 2), Math.floor(height / 2));
        corner = px(data, width, 10, 10);
        if (RED.every((v, i) => center[i] === v) && RED.every((v, i) => corner[i] === v)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.deepEqual(center, RED, "output center shows the fullscreen X window");
      assert.deepEqual(corner, RED, "output corner shows the fullscreen X window");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
