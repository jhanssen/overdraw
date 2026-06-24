// Phase 5 EWMH polish: the WM advertises identity (_NET_SUPPORTING_WM_CHECK
// + _NET_WM_NAME on the child) and capabilities (_NET_SUPPORTED) on the
// root, and tags each managed window with WM_STATE=NormalState (ICCCM
// §4.1.3.1). Also: a client-set _NET_STARTUP_ID and _NET_WM_ICON reach the
// XwmStateView so plugins can correlate launches / pull icons.
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

test("ewmh: _NET_SUPPORTING_WM_CHECK identifies overdraw on the root",
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
        ["--title", "wm-check", "--probe-wm", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      // Wait for the three probe lines.
      const deadline = Date.now() + 5000;
      const need = ["wm-check root child=", "wm-check child self=", "wm-name child='overdraw'"];
      while (Date.now() < deadline) {
        if (need.every((l) => stdout.includes(l))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const root = stdout.match(/wm-check root child=0x([0-9a-f]+)/i);
      const self = stdout.match(/wm-check child self=0x([0-9a-f]+)/i);
      assert.ok(root, `missing root wm-check; stdout:\n${stdout}`);
      assert.ok(self, `missing child wm-check; stdout:\n${stdout}`);
      assert.equal(root[1], self[1],
        `root._NET_SUPPORTING_WM_CHECK and child._NET_SUPPORTING_WM_CHECK must point at the same window`);
      assert.notEqual(parseInt(root[1], 16), 0,
        "wm-check root child must be non-zero");
      assert.ok(stdout.includes("wm-name child='overdraw'"),
        `child _NET_WM_NAME must be 'overdraw'; stdout:\n${stdout}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("ewmh: _NET_SUPPORTED on the root has at least one EWMH atom",
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
        ["--title", "supported", "--probe-net-supported", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      const deadline = Date.now() + 5000;
      let line = null;
      while (Date.now() < deadline) {
        line = stdout.match(/net-supported count=(\d+)/);
        if (line) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(line, `missing net-supported probe line; stdout:\n${stdout}`);
      const count = parseInt(line[1], 10);
      // We declare every atom we publish; the exact number may grow, but
      // it's well above 10 at the moment (every _NET_WM_STATE_*, every
      // _NET_WM_WINDOW_TYPE_*, plus identity / startup / icon).
      assert.ok(count >= 10,
        `_NET_SUPPORTED should list >= 10 atoms; got ${count}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("ewmh: WM_STATE = NormalState is set on a managed window",
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
        ["--title", "wm-state", "--probe-wm-state", "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });
      child.stdout?.on("data", (d) => { stdout += d.toString(); });

      await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "xwayland window managed" });

      const deadline = Date.now() + 5000;
      let line = null;
      while (Date.now() < deadline) {
        line = stdout.match(/wm-state state=(\d+) icon=0x([0-9a-f]+)/i);
        if (line) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(line, `WM_STATE never appeared; stdout:\n${stdout}`);
      assert.equal(line[1], "1",
        `WM_STATE.state must be NormalState=1 for a managed window; got ${line[1]}`);
      assert.equal(parseInt(line[2], 16), 0,
        `WM_STATE.icon must be None (0) for a normal window; got ${line[2]}`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });

test("ewmh: _NET_STARTUP_ID set by the client is exposed via XwmStateView",
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

      const sid = "overdraw-test-launcher_TIME0";
      child = execFile(X11_CLIENT,
        ["--title", "startup-id", "--startup-id", sid, "--timeout-ms", "20000"],
        { env: { ...process.env, DISPLAY: handle.display } });

      const snap = await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "xwayland window managed" });
      const xw = snap.windows.find((w) => w.role === "xwayland");
      assert.ok(xw, "expected an xwayland window");

      // Wait for the property reply to land in the XWM.
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (c.state.xwm?.startupIdOf(xw.surfaceId) === sid) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(c.state.xwm?.startupIdOf(xw.surfaceId), sid,
        `XwmStateView.startupIdOf should expose the client-set _NET_STARTUP_ID`);
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      if (xwm) xwm.stop();
      if (handle) c.addon.xwaylandStop(handle.pid);
      await c.teardown();
    }
  });
