// Phase 3.3 end-to-end: override-redirect X11 windows (menus, tooltips, DnD
// icons) are placed at their X-client-supplied root coords on the content
// layer's overlay strip, above all toplevels and popups. They do NOT enter
// the WM, do NOT emit window.map / window.unmap, and do NOT trigger focus
// (focus on OR comes from explicit X-side requests in slice 3.4).
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

test("override-redirect X11 window is placed at its X-supplied coords",
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

      // Open an override-redirect window at (300, 200) of size 150x100.
      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "300", "--y", "200", "--w", "150", "--h", "100",
        "--title", "or-menu",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      // OR surfaces are recorded in state.overrideRedirects after MapNotify.
      // Wait for it. The state isn't surfaced through state.query() (OR
      // overlays are deliberately invisible to plugins), so check state
      // directly via the compositor handle.
      const overrideRedirects = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          const ors = overrideRedirects();
          if (ors.size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error(
            `OR overlay never appeared; state.overrideRedirects=${JSON.stringify([...ors])}`));
          setTimeout(tick, 50);
        };
        tick();
      });

      // The OR overlay must be at the X-supplied (300, 200) 150x100.
      const ors = overrideRedirects();
      assert.equal(ors.size, 1, "exactly one OR overlay");
      const [, rect] = [...ors.entries()][0];
      assert.deepEqual(rect, { x: 300, y: 200, width: 150, height: 100 },
        "OR rect matches X-supplied coords (identity-mapped in rootless mode)");

      // OR surfaces must NOT appear in state.query().windows. They are
      // transient overlays, not WM windows.
      const snap = c.query();
      assert.equal(snap.windows.length, 0,
        `OR overlay leaked into state.query().windows: ${JSON.stringify(snap.windows)}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("an OR overlay surface is focusable (focusTargetFor resolves it)",
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

      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "50", "--y", "50", "--w", "100", "--h", "60",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      // Wait for the OR overlay to register.
      const ors = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (ors().size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error("OR never appeared"));
          setTimeout(tick, 50);
        };
        tick();
      });

      const [orSurfaceId] = [...ors().keys()];

      // Apply keyboard focus to the OR overlay; the seat's focusTargetFor
      // should resolve it via state.overrideRedirects (instead of
      // wm.getSnapshot, which would fail -- OR isn't in the WM).
      c.state.seat?.applyKeyboardFocus(orSurfaceId);

      // The seat's kbFocus is now the OR surface.
      assert.equal(c.state.seat?.kbFocus?.surfaceId, orSurfaceId,
        "keyboard focus landed on the OR overlay");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("destroying an OR window cleans up state.overrideRedirects",
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

      child = execFile(X11_CLIENT, [
        "--override-redirect",
        "--x", "100", "--y", "100", "--w", "80", "--h", "40",
        "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });

      // Wait for it to appear.
      const ors = () => c.state.overrideRedirects ?? new Map();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const tick = () => {
          if (ors().size >= 1) return resolve();
          if (Date.now() > deadline) return reject(new Error("OR never appeared"));
          setTimeout(tick, 50);
        };
        tick();
      });

      // Kill the X client -- the X server then emits DestroyNotify which
      // xwm.ts maps to removeOverlay.
      child.kill("SIGKILL");

      // Wait for state.overrideRedirects to drain.
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
          if (ors().size === 0) return resolve();
          if (Date.now() > deadline) return reject(new Error(
            `OR not cleaned up after destroy; state.overrideRedirects=${JSON.stringify([...ors()])}`));
          setTimeout(tick, 50);
        };
        tick();
      });
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
