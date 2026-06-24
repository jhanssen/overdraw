// End-to-end Xwayland selection bridge tests. Two directions:
//
//   X -> Wayland: an X11 client claims CLIPBOARD with a payload; a focused
//                 wayland client running --receive on the same MIME reads
//                 the payload back over its wl_data_offer.receive pipe.
//
//   Wayland -> X: a wayland client running --source claims the selection
//                 with a payload; an X11 client running --paste converts
//                 the X selection and reads the payload.
//
// Both directions also exercised for PRIMARY.
//
// Needs GPU + Xwayland + the x11-selection-client and clipboard-test-client
// binaries; self-skips otherwise.

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

// Spawn an X11 client (selection or test) attached to the given DISPLAY. Returns
// a handle with .stdout (accumulator), .child, .waitForLine().
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

// Set up: compositor + Xwayland + XWM + selection bridge. Returns a context
// with .display (X display string) and a teardown.
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

// Run an X11 client to keep the X side focused on an X surface (required for
// the bridge to mediate the X selection). Returns the spawn handle; the
// caller is expected to kill it.
function spawnFocusKeeper(display, timeoutMs = 20000) {
  return spawnX11(X11_TEST, [
    "--title", "focus-keeper", "--timeout-ms", String(timeoutMs),
  ], display);
}

const MIME = "text/plain;charset=utf-8";

test("X -> wl: an X client claims CLIPBOARD; a focused wl client receives the bytes",
  { skip, timeout: 30000 }, async () => {
    const c = await setupBridge();
    let focusKeeper, xSource, wlReceiver;
    try {
      focusKeeper = spawnFocusKeeper(c.display);
      await focusKeeper.waitForLine(/\[x11\] mapped/, { what: "focus-keeper mapped" });
      // Wait for the X focus-keeper window to actually become the X-focused
      // window (the bridge's focus gate keys off xwm.xFocusedWindow()).
      await waitFor(c.query,
        (s) => s.windows.some((w) => w.role === "xwayland"),
        { timeoutMs: 8000, what: "X window in WM" });
      const snap = await c.query();
      const xwin = snap.windows.find((w) => w.role === "xwayland");
      c.state.seat?.applyKeyboardFocus(xwin.surfaceId);
      // Give the focus mirror time to land SetInputFocus on the X side.
      await sleep(200);

      const PAYLOAD = "x-owns-clipboard-roundtrip";
      xSource = spawnX11(X11_SEL,
        ["--source", "CLIPBOARD", MIME, PAYLOAD, "--timeout-ms", "20000"],
        c.display);
      await xSource.waitForLine(/selection-set/, { what: "x source claimed" });

      // Spawn a wayland --receive client. It maps a window first, which takes
      // focus over the X side; the selection bridge keeps the X source alive
      // and republishes the offer on the new focus.
      wlReceiver = spawn(CLIP, ["--socket", c.sock, "--receive", MIME],
        { stdio: ["ignore", "pipe", "pipe"] });
      let wlOut = "";
      wlReceiver.stdout.on("data", (d) => { wlOut += d.toString(); });
      wlReceiver.stderr.on("data", (d) => { wlOut += d.toString(); });
      // Wait for the receiver to print its result line.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !/received: /.test(wlOut)) {
        await sleep(50);
      }
      const m = wlOut.match(/received: (.*)/);
      assert.ok(m, `wayland receiver did not print received: line; stdout was:\n${wlOut}`);
      assert.equal(m[1].trim(), PAYLOAD,
        `X -> wl payload mismatch; got "${m[1]}"`);
    } finally {
      if (wlReceiver) try { wlReceiver.kill("SIGKILL"); } catch { /* ignore */ }
      if (xSource) try { xSource.child.kill("SIGKILL"); } catch { /* ignore */ }
      if (focusKeeper) try { focusKeeper.child.kill("SIGKILL"); } catch { /* ignore */ }
      await c.teardown();
    }
  });

test("wl -> X: a wl client claims CLIPBOARD; an X client paste reads the bytes",
  { skip, timeout: 30000 }, async () => {
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

      const PAYLOAD = "wl-owns-clipboard-roundtrip";
      // The wl source maps a window; that surface takes focus. The bridge
      // then claims the X selection on its behalf.
      wlSource = spawn(CLIP, ["--socket", c.sock, "--source", MIME, PAYLOAD],
        { stdio: ["ignore", "pipe", "pipe"] });
      let wlSrcOut = "";
      wlSource.stdout.on("data", (d) => { wlSrcOut += d.toString(); });
      wlSource.stderr.on("data", (d) => { wlSrcOut += d.toString(); });
      // Wait until the wl source has set the selection.
      const dl = Date.now() + 5000;
      while (Date.now() < dl && !/selection set/.test(wlSrcOut)) await sleep(25);
      // The bridge claims X ownership via SetSelectionOwner. Give xfixes time
      // to round-trip our self-notify so ownerTimestamp is set.
      await sleep(200);

      // X paste.
      xPaste = spawnX11(X11_SEL,
        ["--paste", "CLIPBOARD", MIME, "--timeout-ms", "10000"], c.display);
      await xPaste.waitForLine(/received: /, { what: "x paste received", timeoutMs: 10000 });
      const m = xPaste.stdout.match(/received: (.*)/);
      assert.ok(m, `x paste did not print; stdout was:\n${xPaste.stdout}`);
      assert.equal(m[1].trim(), PAYLOAD,
        `wl -> X payload mismatch; got "${m[1]}"`);
    } finally {
      if (xPaste) try { xPaste.child.kill("SIGKILL"); } catch { /* ignore */ }
      if (wlSource) try { wlSource.kill("SIGKILL"); } catch { /* ignore */ }
      if (focusKeeper) try { focusKeeper.child.kill("SIGKILL"); } catch { /* ignore */ }
      await c.teardown();
    }
  });

test("wl -> X: PRIMARY selection round-trips",
  { skip, timeout: 30000 }, async () => {
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

      const PAYLOAD = "wl-owns-primary-roundtrip";
      wlSource = spawn(CLIP,
        ["--socket", c.sock, "--primary", "--source", MIME, PAYLOAD],
        { stdio: ["ignore", "pipe", "pipe"] });
      let wlSrcOut = "";
      wlSource.stdout.on("data", (d) => { wlSrcOut += d.toString(); });
      wlSource.stderr.on("data", (d) => { wlSrcOut += d.toString(); });
      const dl = Date.now() + 5000;
      while (Date.now() < dl && !/selection set/.test(wlSrcOut)) await sleep(25);
      await sleep(200);

      xPaste = spawnX11(X11_SEL,
        ["--paste", "PRIMARY", MIME, "--timeout-ms", "10000"], c.display);
      await xPaste.waitForLine(/received: /, { what: "x paste received", timeoutMs: 10000 });
      const m = xPaste.stdout.match(/received: (.*)/);
      assert.equal(m[1].trim(), PAYLOAD,
        `wl -> X primary payload mismatch; got "${m[1]}"`);
    } finally {
      if (xPaste) try { xPaste.child.kill("SIGKILL"); } catch { /* ignore */ }
      if (wlSource) try { wlSource.kill("SIGKILL"); } catch { /* ignore */ }
      if (focusKeeper) try { focusKeeper.child.kill("SIGKILL"); } catch { /* ignore */ }
      await c.teardown();
    }
  });
