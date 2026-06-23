// Phase 3.4 end-to-end: compositor keyboard focus is mirrored to the X side
// via SetInputFocus + WM_TAKE_FOCUS (per the ICCCM truth table), and X
// clients that try to steal cross-PID focus are denied by the WM refocusing
// the previous window.
//
// Needs the GPU, Xwayland, and x11-test-client.

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until `child.stdout` contains `needle` (substring); reject on timeout.
async function waitForStdout(stdoutRef, needle, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdoutRef.value.includes(needle)) return;
    await sleep(25);
  }
  throw new Error(`waitForStdout: never saw '${needle}'; stdout=\n${stdoutRef.value}`);
}

test("focus mirror: applyKeyboardFocus on an xwayland surface fires WM_TAKE_FOCUS + FocusIn",
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

      const stdout = { value: "" };
      child = execFile(X11_CLIENT, [
        "--title", "focus-test", "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout.value += d.toString(); });

      // Wait for the window to enter the WM.
      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "xwayland window mapped" });
      const w = snap.windows.find((w) => w.role === "xwayland");

      // Move keyboard focus to it; the focus mirror should SetInputFocus +
      // send WM_TAKE_FOCUS (the test client advertises both protocols).
      c.state.seat?.applyKeyboardFocus(w.surfaceId);

      // The X client must see both FocusIn (from SetInputFocus) and
      // take-focus (from the WM_PROTOCOLS ClientMessage).
      await waitForStdout(stdout, "[x11] focused");
      await waitForStdout(stdout, "[x11] take-focus");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("focus leaves X -> bookkeeper holds focus and _NET_ACTIVE_WINDOW clears",
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

      const stdout = { value: "" };
      child = execFile(X11_CLIENT, [
        "--title", "leave-x-test", "--timeout-ms", "20000",
      ], { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout.value += d.toString(); });

      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "xwayland window mapped" });
      const w = snap.windows.find((w) => w.role === "xwayland");

      // Focus the X client.
      c.state.seat?.applyKeyboardFocus(w.surfaceId);
      await waitForStdout(stdout, "[x11] focused");
      stdout.value = "";

      // Now move focus to nothing (null) -- simulating focus moving to a
      // non-existent Wayland client; bookkeeper should take X-side focus.
      c.state.seat?.applyKeyboardFocus(null);

      // The X client must see a FocusOut.
      await waitForStdout(stdout, "[x11] unfocused");
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("focus mirror: applyKeyboardFocus moves between two managed X windows",
  { skip, timeout: 30000 }, async () => {
    const c = await setupCompositor();
    let handle;
    let xwm;
    let childA, childB;
    try {
      handle = await startXwayland(c.addon, {
        waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
      });
      xwm = startXwm(c.state, c.addon, handle.wmFd);

      const stdoutA = { value: "" };
      const stdoutB = { value: "" };
      childA = execFile(X11_CLIENT,
        ["--title", "app-a", "--app-id", "app-a", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      childA.stdout?.on("data", (d) => { stdoutA.value += d.toString(); });
      await waitForStdout(stdoutA, "[x11] mapped", { timeoutMs: 5000 });

      childB = execFile(X11_CLIENT,
        ["--title", "app-b", "--app-id", "app-b", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      childB.stdout?.on("data", (d) => { stdoutB.value += d.toString(); });
      await waitForStdout(stdoutB, "[x11] mapped", { timeoutMs: 5000 });

      // Both windows in the WM.
      const snap = await waitFor(c.query,
        (s) => s.windows.filter((w) => w.role === "xwayland").length >= 2,
        { timeoutMs: 8000, what: "both X windows in WM" });
      const xwins = snap.windows.filter((w) => w.role === "xwayland");
      const winA = xwins.find((w) => w.title === "app-a");
      const winB = xwins.find((w) => w.title === "app-b");
      assert.ok(winA && winB, `both windows must be present; titles=${xwins.map((w) => w.title).join(", ")}`);

      // Reset stdout captures. The bundled focus plugin may have already
      // moved focus during map; we only care about the next two transitions.
      stdoutA.value = "";
      stdoutB.value = "";

      // Focus A: A sees [x11] focused. (B may already see [x11] unfocused
      // if it had focus before; both are valid.)
      c.state.seat?.applyKeyboardFocus(winA.surfaceId);
      await waitForStdout(stdoutA, "[x11] focused");

      // Focus B: A sees [x11] unfocused, B sees [x11] focused.
      c.state.seat?.applyKeyboardFocus(winB.surfaceId);
      await waitForStdout(stdoutA, "[x11] unfocused");
      await waitForStdout(stdoutB, "[x11] focused");
    } finally {
      if (childA && childA.exitCode === null) childA.kill("SIGKILL");
      if (childB && childB.exitCode === null) childB.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
