// INCR (large-transfer) Xwayland selection bridge tests. Above 64 KiB the
// bridge switches to INCR in both directions:
//
//   X -> wl INCR: the X source serves a large property; xcb itself transports
//     it as INCR because the bridge's source-side ConvertSelection asks for
//     a one-shot. In practice for THIS test the X source writes one big
//     property and the X server fragments it; the bridge's incoming code
//     path handles both the INCR-typed first reply and PropertyNotify chunks
//     until a zero-length chunk signals EOF.
//
//   wl -> X INCR: the wayland source writes >64 KiB into the pipe; the bridge
//     pumps the bytes, switches to INCR at 64 KiB, writes one INCR-typed
//     property (carrying the size hint), sends SelectionNotify, then on each
//     PropertyNotify(Delete) on the requestor writes the next chunk, and
//     finally an empty-property write to signal EOF.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  setupCompositor, canRunGpu, nextXDisplay, buildBin, waitFor,
} from "./harness.mjs";
import { startXwayland } from "../packages/core/dist/xwayland/index.js";
import { startXwm } from "../packages/core/dist/xwayland/xwm.js";
import { startSelectionBridge } from "../packages/core/dist/xwayland/selection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const X11_SEL = join(__dirname, "..", "packages", "core", "build", "x11-selection-client");
const CLIP = buildBin("clipboard-test-client");
const X11_TEST = join(__dirname, "..", "packages", "core", "build", "x11-test-client");

function haveXwayland() {
  return (process.env.PATH ?? "").split(":").some((p) => p && existsSync(`${p}/Xwayland`));
}

const skip = !canRunGpu()
  ? "no GPU/dawn.node"
  : !haveXwayland()
    ? "Xwayland not installed"
    : !existsSync(X11_SEL)
      ? "x11-selection-client not built"
      : !existsSync(X11_TEST)
        ? "x11-test-client not built"
        : !existsSync(CLIP)
          ? "clipboard-test-client not built"
          : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnX11(bin, args, display) {
  const child = execFile(bin, args, {
    env: { ...process.env, DISPLAY: display },
  });
  const handle = { child, stdout: "" };
  child.stdout?.on("data", (d) => { handle.stdout += d.toString(); });
  child.stderr?.on("data", (d) => { handle.stdout += d.toString(); });
  handle.waitForLine = async (re, { timeoutMs = 5000, what = "x11 line" } = {}) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (re instanceof RegExp ? re.test(handle.stdout) : handle.stdout.includes(re)) {
        return handle.stdout;
      }
      await sleep(25);
    }
    throw new Error(`waitForLine (${what}) timed out; stdout:\n${handle.stdout}`);
  };
  return handle;
}

async function setupBridge() {
  const c = await setupCompositor({ headless: { width: 800, height: 600 } });
  const handle = await startXwayland(c.addon, {
    waylandDisplay: c.sock, enableWm: true, displayNumber: nextXDisplay(),
  });
  const xwm = startXwm(c.state, c.addon, handle.wmFd);
  const bridge = startSelectionBridge(c.state, c.addon, xwm);
  c.state.onWlSelectionChanged = bridge.onWlSelectionChanged;
  c.state.receiveForXSource = bridge.receiveForXSource;
  return {
    ...c,
    display: handle.display,
    teardown: async () => {
      try { bridge.stop(); } catch { /* ignore */ }
      try { xwm.stop(); } catch { /* ignore */ }
      try { c.addon.xwaylandStop(handle.pid); } catch { /* ignore */ }
      await c.teardown();
    },
  };
}

function spawnFocusKeeper(display, timeoutMs = 30000) {
  return spawnX11(X11_TEST, [
    "--title", "focus-keeper", "--timeout-ms", String(timeoutMs),
  ], display);
}

const MIME = "text/plain;charset=utf-8";

// Compute the expected 32-bit unsigned sum of N bytes of the deterministic
// pattern (byte i = (i ^ (i >> 8)) & 0xFF), to match the C clients.
function expectedSum32(n) {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum = (sum + (((i ^ (i >>> 8)) & 0xff))) >>> 0;
  }
  return sum >>> 0;
}

// 96 KiB: comfortably above the bridge's 64 KiB INCR threshold without
// pushing into X server property-size limits.
const INCR_SIZE = 96 * 1024;

test("X -> wl INCR: a large X selection chunks through the bridge to a wl receiver",
  { skip, timeout: 45000 }, async () => {
    const c = await setupBridge();
    let focusKeeper, xSource, wlReceiver;
    try {
      focusKeeper = spawnFocusKeeper(c.display);
      await focusKeeper.waitForLine(/\[x11\] mapped/, { what: "focus-keeper mapped" });
      await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "X window in WM" });
      const snap = await c.query();
      const xwin = snap.windows.find((w) => w.role === "xwayland");
      c.state.seat?.applyKeyboardFocus(xwin.surfaceId);
      await sleep(200);

      xSource = spawnX11(X11_SEL,
        ["--source-bytes", "CLIPBOARD", MIME, String(INCR_SIZE), "--timeout-ms", "40000"],
        c.display);
      await xSource.waitForLine(/selection-set/, { what: "x source claimed" });

      wlReceiver = spawn(CLIP,
        ["--socket", c.sock, "--receive", MIME, "--summary"],
        { stdio: ["ignore", "pipe", "pipe"] });
      let wlOut = "";
      wlReceiver.stdout.on("data", (d) => { wlOut += d.toString(); });
      wlReceiver.stderr.on("data", (d) => { wlOut += d.toString(); });
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !/received-summary [^\n]*\n/.test(wlOut)) {
        await sleep(50);
      }
      const m = wlOut.match(/received-summary len=(\d+) sum32=0x([0-9a-f]+)/);
      assert.ok(m, `wayland receiver did not print summary; stdout was:\n${wlOut}`);
      const gotLen = Number(m[1]);
      const gotSum = parseInt(m[2], 16) >>> 0;
      assert.equal(gotLen, INCR_SIZE,
        `X -> wl INCR length mismatch; got ${gotLen}, expected ${INCR_SIZE}`);
      assert.equal(gotSum, expectedSum32(INCR_SIZE),
        `X -> wl INCR checksum mismatch; got 0x${gotSum.toString(16)}, expected 0x${expectedSum32(INCR_SIZE).toString(16)}`);
    } finally {
      if (wlReceiver) try { wlReceiver.kill("SIGKILL"); } catch { /* ignore */ }
      if (xSource) try { xSource.child.kill("SIGKILL"); } catch { /* ignore */ }
      if (focusKeeper) try { focusKeeper.child.kill("SIGKILL"); } catch { /* ignore */ }
      await c.teardown();
    }
  });

test("wl -> X INCR: a large wl selection chunks through the bridge to an X paste",
  { skip, timeout: 45000 }, async () => {
    const c = await setupBridge();
    let focusKeeper, wlSource, xPaste;
    try {
      focusKeeper = spawnFocusKeeper(c.display);
      await focusKeeper.waitForLine(/\[x11\] mapped/, { what: "focus-keeper mapped" });
      await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "X window in WM" });
      const snap = await c.query();
      const xwin = snap.windows.find((w) => w.role === "xwayland");
      c.state.seat?.applyKeyboardFocus(xwin.surfaceId);
      await sleep(200);

      wlSource = spawn(CLIP,
        ["--socket", c.sock, "--source-bytes", MIME, String(INCR_SIZE)],
        { stdio: ["ignore", "pipe", "pipe"] });
      let wlSrcOut = "";
      wlSource.stdout.on("data", (d) => { wlSrcOut += d.toString(); });
      wlSource.stderr.on("data", (d) => { wlSrcOut += d.toString(); });
      const dl = Date.now() + 5000;
      while (Date.now() < dl && !/selection set/.test(wlSrcOut)) await sleep(25);
      await sleep(200);

      xPaste = spawnX11(X11_SEL,
        ["--paste", "CLIPBOARD", MIME, "--summary", "--timeout-ms", "30000"],
        c.display);
      await xPaste.waitForLine(/received-summary [^\n]*\n/, { what: "x paste summary", timeoutMs: 30000 });
      const m = xPaste.stdout.match(/received-summary len=(\d+) sum32=0x([0-9a-f]+)/);
      assert.ok(m, `x paste did not print summary; stdout was:\n${xPaste.stdout}`);
      const gotLen = Number(m[1]);
      const gotSum = parseInt(m[2], 16) >>> 0;
      assert.equal(gotLen, INCR_SIZE,
        `wl -> X INCR length mismatch; got ${gotLen}, expected ${INCR_SIZE}`);
      assert.equal(gotSum, expectedSum32(INCR_SIZE),
        `wl -> X INCR checksum mismatch; got 0x${gotSum.toString(16)}, expected 0x${expectedSum32(INCR_SIZE).toString(16)}`);
    } finally {
      if (xPaste) try { xPaste.child.kill("SIGKILL"); } catch { /* ignore */ }
      if (wlSource) try { wlSource.kill("SIGKILL"); } catch { /* ignore */ }
      if (focusKeeper) try { focusKeeper.child.kill("SIGKILL"); } catch { /* ignore */ }
      await c.teardown();
    }
  });
