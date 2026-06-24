// Phase 3.2 end-to-end: the compositor is authoritative for an X11 window's
// geometry. When the X client maps, the WM picks a rect for it; the
// configureSink router (protocols/index.ts) calls xwmConfigureWindow +
// xwmSendConfigureNotify so the client sees the WM-chosen size, not its
// own requested size.
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

test("xwm: WM-chosen rect reaches the X client via synthetic ConfigureNotify",
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

      // The x11-test-client creates a 200x150 window; the WM will tile it
      // to the full output (1280x720 headless). The client should see a
      // synthetic ConfigureNotify carrying the WM-chosen dims.
      let stdout = "";
      child = execFile(X11_CLIENT,
        ["--title", "configure-test", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      // Wait for the window to appear in the WM with the layout-driver-chosen
      // rect; the WM-chosen content size matches the output (1280x720).
      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) =>
          w.role === "xwayland" && w.rect.width === 1280 && w.rect.height === 720),
        { timeoutMs: 8000, what: "xwayland window tiled to full output" });
      const w = snap.windows.find((w) => w.role === "xwayland");
      assert.ok(w, "expected an xwayland window");

      // Wait for the client's stdout to show a synthetic ConfigureNotify
      // with the WM-chosen dims (1280x720). The "synthetic" marker is what
      // ICCCM-compliant clients (gtk/qt) read for authoritative geometry.
      const deadline = Date.now() + 5000;
      let configureLine = null;
      while (Date.now() < deadline) {
        const lines = stdout.split("\n");
        configureLine = lines.find((l) =>
          l.includes("[x11] configure synthetic") && l.includes("w=1280") && l.includes("h=720"));
        if (configureLine) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(configureLine,
        `expected synthetic ConfigureNotify with w=1280 h=720; saw stdout:\n${stdout}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("xwm: with global X scale=2, the X client sees doubled configure dims",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      // Freeze the global X scale BEFORE startXwm so the XWM and the
      // ConfigureSink router see the same value. Production wires this
      // through main.ts (resolveXwaylandScale + config.xwayland.scale);
      // here we set it directly.
      c.state.xwaylandScale = 2;
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      // The WM tiles the X window to the full output (1280x720 logical).
      // With X scale=2, the synthetic ConfigureNotify must carry the
      // doubled (X-device) dims: 2560x1440.
      let stdout = "";
      child = execFile(X11_CLIENT,
        ["--title", "configure-scale-test", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      // Wait for the WM-side window snapshot (still in compositor logical
      // coords).
      await waitFor(c.query,
        (s) => s.windows.some((w) =>
          w.role === "xwayland" && w.rect.width === 1280 && w.rect.height === 720),
        { timeoutMs: 8000, what: "xwayland window tiled to full output (logical)" });

      // The X client must see the doubled dims (X-device coords).
      const deadline = Date.now() + 5000;
      let configureLine = null;
      while (Date.now() < deadline) {
        const lines = stdout.split("\n");
        configureLine = lines.find((l) =>
          l.includes("[x11] configure synthetic") && l.includes("w=2560") && l.includes("h=1440"));
        if (configureLine) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(configureLine,
        `expected synthetic ConfigureNotify with w=2560 h=1440 (scale=2); saw stdout:\n${stdout}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
