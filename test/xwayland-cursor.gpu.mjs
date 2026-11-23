// Xwayland cursor under a global X scale: the X cursor image and hotspot
// arrive in X pixels (oversized by the scale), so the compositor's cursor
// slot must divide both back to logical. A 32x32 X cursor with hotspot
// (8,4) at X scale 2 draws as 16x16 logical, offset by (4,2).
//
// Needs the GPU, Xwayland, and the built x11-test-client.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompositor, canRunGpu, waitFor, nextXDisplay, pointerMotion } from "./harness.mjs";
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

test("X cursor at X scale 2 draws at logical size with a logical hotspot",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let child;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      c.state.xwaylandScale = 2;
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      child = execFile(X11_CLIENT, [
        "--title", "x-cursor",
        "--cursor", "32", "8", "4",
        "--fill", "3060a0",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland" && w.title === "x-cursor"
          && w.rect.width > 0 && w.rect.height > 0),
        { timeoutMs: 8000, what: "x window laid out" });
      const w = snap.windows.find((w) => w.title === "x-cursor");
      const r = w.rect;
      const px = r.x + Math.floor(r.width / 2);
      const py = r.y + Math.floor(r.height / 2);

      const cursorEntry = () => {
        for (const o of c.state.compositor.introspect().outputs) {
          const e = o.drawList.find((d) => d.kind === "cursor");
          if (e) return e;
        }
        return null;
      };
      // Pointer motion until Xwayland's set_cursor lands (its 32px image
      // replaces the compositor's default cursor in the slot).
      let e = null;
      const deadline = Date.now() + 8000;
      for (let i = 0; Date.now() < deadline; i++) {
        pointerMotion(c.addon, px + (i % 2), py);
        await new Promise((res) => setTimeout(res, 100));
        e = cursorEntry();
        if (e && e.id !== 0x7FFF_FFF0 && e.hasBuffer) break;
      }
      assert.ok(e && e.id !== 0x7FFF_FFF0, `X cursor surface in the cursor slot (got ${JSON.stringify(e)})`);
      assert.equal(e.width, 16, "32 X px / scale 2");
      assert.equal(e.height, 16);
      const lastX = e.x + 4;  // hotspot 8 X px = 4 logical
      assert.ok(lastX === px || lastX === px + 1, `hotspot x: entry ${e.x}, pointer ${px}`);
      assert.equal(e.y + 2, py, "hotspot y: 4 X px = 2 logical");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
