// Phase 3.1 XWM end-to-end: spawn a rootless Xwayland, run an X11 client that
// sets title / WM_CLASS / WM_PROTOCOLS=WM_DELETE_WINDOW, and assert:
//
//   1. The window's title (via _NET_WM_NAME) and app_id (via WM_CLASS) reach
//      state.query() once the property batch lands.
//   2. The compositor's close path (closeSurface) sends WM_DELETE_WINDOW and
//      the X client exits cleanly.
//
// Needs the GPU, the Xwayland binary, and the built x11-test-client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu, waitFor, nextXDisplay } from "./harness.mjs";
import { startXwayland } from "../packages/core/dist/xwayland/index.js";
import { startXwm } from "../packages/core/dist/xwayland/xwm.js";
import { closeSurface } from "../packages/core/dist/protocols/close-surface.js";

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

test("xwm: title/app_id from ICCCM/EWMH properties reach state.query()",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, { waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay() });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      const expectedTitle = "Overdraw Phase 3.1";
      const expectedAppId = "com.overdraw.x11test";
      child = execFile(X11_CLIENT,
        ["--title", expectedTitle, "--app-id", expectedAppId, "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });

      // Wait for the window to enter state.query() with the expected title +
      // app_id. The XWM batch-reads properties on associate; the reply round-
      // trip + window.change flush should land within a few frames.
      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) =>
          w.title === expectedTitle && w.appId === expectedAppId),
        { timeoutMs: 8000, what: "xwayland title/appId" });
      const w = snap.windows.find((w) => w.title === expectedTitle);
      assert.ok(w, `expected one window with title=${expectedTitle}`);
      assert.equal(w.title, expectedTitle);
      assert.equal(w.appId, expectedAppId);
      assert.equal(w.role, "xwayland");
    } finally {
      if (child) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("xwm: closeSurface sends WM_DELETE_WINDOW and the X client exits",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    let exitPromise;
    try {
      handle = await startXwayland(c.addon, { waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay() });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      child = execFile(X11_CLIENT,
        ["--title", "closeme", "--app-id", "closeme", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      exitPromise = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));

      // Capture stdout to confirm the client received WM_DELETE_WINDOW.
      let stdout = "";
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      // Wait for the window to enter the WM. (No title check needed for this
      // test -- close works regardless of properties; we just need a target.)
      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "xwayland window mapped" });
      const w = snap.windows.find((w) => w.role === "xwayland");
      assert.ok(w, "expected an xwayland window");

      // Drive the close path the same way main.ts does for "window.close-
      // requested" / the foreign-toplevel manager. The X client's event loop
      // exits on WM_DELETE_WINDOW receipt.
      closeSurface(c.state, w.surfaceId);

      const exit = await Promise.race([
        exitPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("client did not exit after close")), 5000)),
      ]);
      assert.equal(exit.code, 0, `client exited cleanly; stdout: ${stdout}`);
      assert.match(stdout, /\[x11\] deleted/, "client logged the delete receipt");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
