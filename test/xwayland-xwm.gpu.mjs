// Phase 2 XWM end-to-end: spawn a rootless Xwayland WITH a -wm channel, start
// the XWM (xcb), run a real X11 client that creates + maps a window, and assert
// the window associates with its wl_surface (via WL_SURFACE_SERIAL) and enters
// overdraw's WM. Exercises the whole native XWM + serial-join path.
//
// Needs the GPU (Xwayland glamor) + the Xwayland binary + the built
// x11-test-client; self-skips otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu } from "./harness.mjs";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("xwm: an X11 window associates with its wl_surface and enters the WM",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, { waylandDisplay: c.sock, enableWm: true });
      assert.ok(handle.wmFd >= 0, "got a wm fd");
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      child = execFile(X11_CLIENT, [], { env: { ...process.env, DISPLAY: handle.display } });

      // Poll (yielding to the loop so the xcb + wayland fds get serviced) until
      // an X11 window is both mapped and associated with a wl_surface.
      let managed = [];
      for (let i = 0; i < 120; i++) {
        managed = [...xwm.windows().values()].filter((w) => w.addedToWm && w.surfaceId !== null);
        if (managed.length >= 1) break;
        await sleep(50);
      }
      const snapshot = [...xwm.windows().values()].map((w) =>
        `win=0x${w.window.toString(16)} mapped=${w.mapped} surfaceId=${w.surfaceId} managed=${w.addedToWm}`);
      assert.ok(managed.length >= 1,
        `an X11 window should associate + enter the WM; saw: ${snapshot.join("; ") || "none"}`);
      assert.ok(managed[0].surfaceId !== null, "window is associated with a wl_surface");
    } finally {
      if (child) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
